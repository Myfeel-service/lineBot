/**
 * Re-sync 流程：對既有的 source 重新抓內容、跑切卡、跟現有 chunk 對比後產生 diff，
 * 讓使用者人工選擇要保留 / 覆蓋 / 新增 / 刪除哪些卡。
 *
 * 設計重點：
 * - 不直接覆蓋，永遠出 diff 讓人類決定。
 * - 對「手動編輯過」的卡（manuallyEditedAt != null）預設 keep_old。
 * - 配對策略：第一輪 title 完全相等；配不上的再用內容 bigram 相似度做第二輪配對。
 *   LLM 重切標題常會微調（「運費說明」→「運費與配送說明」），只靠 title 會把同一張卡
 *   誤報成「移除 + 新增」，使用者每次 re-sync 都要人工重配假差異。
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import { listChunksBySource } from './ai-knowledge-sources'
import { extractUrlText } from './ai-source-extractors'

export type DiffKind = 'new' | 'modified' | 'removed' | 'unchanged'
export type DiffAction = 'add_new' | 'use_new' | 'keep_old' | 'delete_old' | 'skip'

export interface DiffEntry {
  /** 穩定 ID，apply 時用 */
  id: string
  kind: DiffKind
  /** 後端建議的預設動作（前端可覆寫） */
  defaultAction: DiffAction
  /** 舊版本（kind=modified/removed/unchanged 才有） */
  oldChunk?: {
    id: string
    title: string
    content: string
    tags: string[]
    manuallyEdited: boolean
  }
  /** 新版本（kind=new/modified/unchanged 才有） */
  newChunk?: {
    title: string
    content: string
    tags: string[]
    /** LLM 切卡生成的常見問法；apply 時隨新版一併寫入 */
    questions?: string[]
  }
}

export interface DiffSummary {
  added: number
  modified: number
  removed: number
  unchanged: number
}

interface OldChunk {
  id: string
  title: string
  content: string
  tags: string[]
  manuallyEditedAtMs: number
}
interface NewChunk {
  title: string
  content: string
  tags: string[]
  questions?: string[]
}

export interface DiffResult {
  entries: DiffEntry[]
  summary: DiffSummary
}

/** 第二輪配對的內容相似度門檻 */
export const SECOND_PASS_MIN_SIMILARITY = 0.6

/**
 * 字元 bigram Jaccard 相似度（0–1）。輕量、不需 embedding，
 * 給「title 配不上的新舊卡」做第二輪內容配對用。
 */
function bigramSet(s: string): Set<string> {
  const t = s.replace(/\s+/g, '').toLowerCase()
  const out = new Set<string>()
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2))
  return out
}

/** 兩個已算好的 bigram 集合的 Jaccard 相似度 */
function jaccard(ga: Set<string>, gb: Set<string>): number {
  if (!ga.size || !gb.size) return 0
  // 迭代較小的那個集合,查較大的(比對次數取決於小集合大小)
  const [small, large] = ga.size <= gb.size ? [ga, gb] : [gb, ga]
  let inter = 0
  for (const g of small) {
    if (large.has(g)) inter++
  }
  return inter / (ga.size + gb.size - inter)
}

export function contentSimilarity(a: string, b: string): number {
  return jaccard(bigramSet(a), bigramSet(b))
}

export function computeDiff(oldChunks: OldChunk[], newChunks: NewChunk[]): DiffResult {
  const oldByTitle = new Map(oldChunks.map(c => [c.title, c]))

  const entries: DiffEntry[] = []
  const summary: DiffSummary = { added: 0, modified: 0, removed: 0, unchanged: 0 }
  const matchedOldIds = new Set<string>()
  const unmatchedNew: Array<{ n: NewChunk; idx: number }> = []

  const pushModified = (o: OldChunk, n: NewChunk) => {
    const manuallyEdited = o.manuallyEditedAtMs > 0
    entries.push({
      id: `mod:${o.id}`,
      kind: 'modified',
      // 手動編輯過 → 預設保留人工版；沒編輯過 → 預設用新版
      defaultAction: manuallyEdited ? 'keep_old' : 'use_new',
      oldChunk: { id: o.id, title: o.title, content: o.content, tags: o.tags, manuallyEdited },
      newChunk: { title: n.title, content: n.content, tags: n.tags, questions: n.questions ?? [] },
    })
    summary.modified++
  }

  // ── 第一輪：title 完全相等 ───────────────────────────────
  for (let i = 0; i < newChunks.length; i++) {
    const n = newChunks[i]!
    const o = oldByTitle.get(n.title)
    if (!o || matchedOldIds.has(o.id)) {
      unmatchedNew.push({ n, idx: i })
      continue
    }
    matchedOldIds.add(o.id)
    const contentSame = o.content === n.content
    const tagsSame = JSON.stringify([...o.tags].sort()) === JSON.stringify([...n.tags].sort())
    if (contentSame && tagsSame) {
      entries.push({
        id: `same:${o.id}`,
        kind: 'unchanged',
        defaultAction: 'keep_old',
        oldChunk: { id: o.id, title: o.title, content: o.content, tags: o.tags, manuallyEdited: o.manuallyEditedAtMs > 0 },
        newChunk: { title: n.title, content: n.content, tags: n.tags, questions: n.questions ?? [] },
      })
      summary.unchanged++
    }
    else {
      pushModified(o, n)
    }
  }

  // ── 第二輪：title 配不上的，用內容相似度配對（title 被 LLM 微調的情況）──
  // 手動編輯過的舊卡**不參與**第二輪：它一旦被誤配到一張「相似但其實是新增」的卡，
  // defaultAction=keep_old 會讓那張新卡被靜默丟棄；寧可保守地出 removed + new 讓人判斷。
  const pairedNewIdx = new Set<number>()
  // bigram 集合只算一次:這是 O(舊卡 × 新卡) 的雙層迴圈,原本每對都重建兩個集合,
  // 150×150 張 5000 字的卡會做上億次字串切片,把 Lambda 的事件迴圈卡死
  // (同一台還要服務 LINE webhook),也可能撞到 job 租約時限而整份重算。
  const newGrams = new Map<number, Set<string>>()
  for (const cand of unmatchedNew) newGrams.set(cand.idx, bigramSet(cand.n.content))
  for (const o of oldChunks) {
    if (matchedOldIds.has(o.id) || o.manuallyEditedAtMs > 0) continue
    const oGrams = bigramSet(o.content)
    let best: { n: NewChunk; idx: number } | null = null
    let bestScore = 0
    for (const cand of unmatchedNew) {
      if (pairedNewIdx.has(cand.idx)) continue
      const score = jaccard(oGrams, newGrams.get(cand.idx)!)
      if (score > bestScore) {
        bestScore = score
        best = cand
      }
    }
    if (best && bestScore >= SECOND_PASS_MIN_SIMILARITY) {
      pairedNewIdx.add(best.idx)
      matchedOldIds.add(o.id)
      pushModified(o, best.n)
    }
  }

  // ── 剩餘：真正的新增 / 移除 ─────────────────────────────
  for (const { n, idx } of unmatchedNew) {
    if (pairedNewIdx.has(idx)) continue
    entries.push({
      id: `new:${idx}`,
      kind: 'new',
      defaultAction: 'add_new',
      newChunk: { title: n.title, content: n.content, tags: n.tags, questions: n.questions ?? [] },
    })
    summary.added++
  }
  for (const o of oldChunks) {
    if (matchedOldIds.has(o.id)) continue
    const manuallyEdited = o.manuallyEditedAtMs > 0
    entries.push({
      id: `rem:${o.id}`,
      kind: 'removed',
      // 手動編輯過 → 預設保留；沒有 → 預設刪除
      defaultAction: manuallyEdited ? 'keep_old' : 'delete_old',
      oldChunk: { id: o.id, title: o.title, content: o.content, tags: o.tags, manuallyEdited },
    })
    summary.removed++
  }

  return { entries, summary }
}

/**
 * 取「重新同步」要比對的最新內容：**一律當場重抓**，並把全文暫存回 cache。
 *
 * 為什麼不讀 cache：手動按下「重新同步」的語意就是「現在去看一次網頁」。排程偵測到變動時
 * 會把當下全文寫進 cache，而套用過一次之後 source.contentHash 就等於 cache 的 hash——
 * 若優先讀 cache，使用者改完網頁馬上按重新同步會拿到舊文字、畫面回報「全部未變」，
 * 明明上面還寫著「已重新抓一次網頁」。用時間門檻擋也只是把問題縮小到幾分鐘內，
 * 不如讓這顆按鈕的行為與它的名字一致。
 *
 * 代價：若網頁在「排程通知」與「使用者點進來」之間又變過一次，看到的是最新版而不是被通知的
 * 那一版。這是可接受的——回寫的 contentHash 取自這次抓到的內容，兩者仍然一致，
 * 而使用者要判斷的本來就是「網頁現在長怎樣」。
 */
export async function getResyncExtracted(
  db: Firestore,
  sourceId: string,
  _sourceContentHash: string,
  sourceUrl: string,
): Promise<{ text: string; rawLength: number; contentHash: string }> {
  const extracted = await extractUrlText(sourceUrl)
  const { createHash } = await import('node:crypto')
  const contentHash = createHash('sha256').update(extracted.text).digest('hex')
  // 暫存這一版：resync-apply 之後的排程比對要有同一個基準
  await db.collection('knowledgeSources').doc(sourceId)
    .collection('cache').doc('extracted')
    .set({
      text: extracted.text,
      hash: contentHash,
      rawLength: extracted.rawLength,
      fetchedAt: FieldValue.serverTimestamp(),
    })
    .catch(e => console.warn('[resync] cache write failed:', e))
  return { text: extracted.text, rawLength: extracted.rawLength, contentHash }
}

/** 把 Firestore 拉出來的 raw chunks 轉成 diff 函式吃的格式 */
export async function loadOldChunksForDiff(
  db: Firestore,
  workspaceId: string,
  sourceId: string,
): Promise<OldChunk[]> {
  const chunks = await listChunksBySource(db, workspaceId, sourceId)
  // 總覽卡（isOverview）不參與 diff：它是機器合成、由 resync-apply 依最終子卡片單獨重生，
  // 不該被當成「新切卡裡找不到 → 移除」而誤報。
  return chunks.filter(c => !c.isOverview).map(c => ({
    id: c.id,
    title: c.title,
    content: c.content,
    tags: c.tags,
    manuallyEditedAtMs: c.manuallyEditedAtMs,
  }))
}
