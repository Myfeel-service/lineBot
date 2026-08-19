/**
 * Re-sync 流程：對既有的 source 重新抓內容、跑切卡、跟現有 chunk 對比後產生 diff，
 * 讓使用者人工選擇要保留 / 覆蓋 / 新增 / 刪除哪些卡。
 *
 * 設計重點：
 * - 不直接覆蓋，永遠出 diff 讓人類決定。
 * - 對「手動編輯過」的卡（manuallyEditedAt != null）預設 keep_old。
 * - 配對策略：第一輪 title 相等（正規化後）；配不上的再用內容 bigram 相似度做第二輪配對。
 *   LLM 重切標題常會微調（「運費說明」→「運費與配送說明」），只靠 title 會把同一張卡
 *   誤報成「移除 + 新增」，使用者每次 re-sync 都要人工重配假差異。
 * - **比對一律先正規化**（空白、全半形標點）：舊卡是上一次 LLM 的輸出、新卡是這一次的輸出，
 *   逐字元比較會把「同一句話換個標點」報成「修改」，畫面上左右兩欄長得一樣卻要人做決定
 *   ——使用者的結論會是「系統說有變更但其實沒有」，整個 diff 從此不被信任。
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
  /**
   * kind=modified 才有：內容裡的數字（價格、天數、規格、日期）有沒有變。
   * false ＝ 這張只是換句話說，客人拿到的事實沒變；true ＝ 要優先看的那幾張。
   *
   * 為什麼用數字而不是相似度：相似度只反映卡片長度。實測「50 到 99 度」改成
   * 「50 到 95 度」的長卡相似度 0.95（真的改了規格），純粹換句話說的卡卻只有 0.63
   * ——拿相似度標「幾乎相同」會剛好把該看的那張標成安全的。
   *
   * **只標示、不改預設動作**：數字沒變也可能少寫了一句（例如「重點」少一個欄位），
   * 預設仍是用新版（網頁才是事實來源），不替使用者默默決定。
   */
  numbersChanged?: boolean
  /** kind=modified 且數字有變：變掉的數字（各最多 6 個），前端直接列給人看 */
  numberChanges?: { removed: string[]; added: string[] }
  /** kind=modified 才有：標題（正規化後）是否真的變了 */
  titleChanged?: boolean
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

/**
 * 這次套用有幾個「保留了與網頁不同的內容」的決定（C-44 的關鍵量）：
 * - modified 選保留/略過 → 卡片停在舊版、網頁是新版
 * - removed 選保留 → 網頁已沒有這段、卡片還在
 * - new 選略過 → 網頁有這段、卡片沒有
 * 沒帶決定的項套用端視同保留，所以這裡也照算。unchanged 保留不算（兩邊本來就一樣）。
 * 只要這個數 > 0，套用後就**不能**把 appliedContentHash 推到新版——推了等於宣告
 * 「卡片已同步到這一版網頁」，下次重新同步會回「已是最新」，這次被保留的差異從此蒸發。
 */
export function countDivergentKeeps(
  entries: Array<Pick<DiffEntry, 'id' | 'kind'>>,
  decisions: Record<string, string>,
): number {
  let n = 0
  for (const e of entries) {
    const a = decisions[e.id]
    if (e.kind === 'modified' && (a === 'keep_old' || a === 'skip' || a === undefined)) n++
    else if (e.kind === 'removed' && (a === 'keep_old' || a === undefined)) n++
    else if (e.kind === 'new' && (a === 'skip' || a === undefined)) n++
  }
  return n
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

/**
 * 比對用正規化：把「同一份內容、只是排版或標點不同」的兩張卡視為相同。
 *
 * 為什麼需要：diff 兩邊都是 LLM 產物（舊卡＝上次切卡結果、新卡＝這次），
 * 同一段原文重切兩次常只差全形冒號 / 「、」與「，」 / 「重點：」行的分隔空白。
 * 逐字元比較會把這些報成「修改」，使用者看到左右兩欄一模一樣，等於系統在說謊。
 *
 * 只做**形變**統一（空白、全半形標點），不刪字也不刪數字：
 * 「50 到 99 度」→「50 到 95 度」正規化後仍然不同，該報的修改照報。
 */
export function normalizeForCompare(s: string): string {
  return String(s || '')
    // 全形數字 → 半形（「１０００ 元」與「1000 元」是同一個價格，也讓數字比對抓得到）
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    // 全形標點 → 半形（同一句話兩次輸出可能用不同形）
    .replace(/[：]/g, ':')
    .replace(/[，、]/g, ',')
    .replace(/[；]/g, ';')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[｜]/g, '|')
    .replace(/[～]/g, '~')
    .replace(/[．。]/g, '.')
    // 中文沒有詞距，LLM 兩次的空白位置常不同 → 全部去掉（與 bigramSet 同一套思路）
    .replace(/\s+/g, '')
    .toLowerCase()
}

/** 數字（含千分位、小數）：1,000 / 3.5 / 99 */
const NUMBER_RE = /\d+(?:[.,]\d+)*/g

/**
 * 抓出內容裡的所有數字（多重集合，重複出現算多次）。
 * 「這次的差異有沒有動到客人在意的事實」用數字判斷最穩：價格、天數、度數、規格、日期
 * 都是數字，而純粹換句話說不會動到它們。
 */
export function extractNumbers(s: string): string[] {
  // 先過 normalizeForCompare：全形數字/標點已轉半形、空白已去掉（「1 000」不會被拆成兩個）
  return (normalizeForCompare(s).match(NUMBER_RE) ?? []).map(n => n.replace(/,/g, ''))
}

/** 多重集合差集：a 有而 b 沒有的（含重複次數） */
function multisetDiff(a: string[], b: string[]): string[] {
  const pool = [...b]
  const out: string[] = []
  for (const x of a) {
    const i = pool.indexOf(x)
    if (i >= 0) pool.splice(i, 1)
    else out.push(x)
  }
  return out
}

/** 內容在「形變」層級上等價 */
function contentEquivalent(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b)
}

/** 標籤集合等價（順序、形變都不算差異） */
function tagsEquivalent(a: string[], b: string[]): boolean {
  const key = (tags: string[]) =>
    [...new Set(tags.map(normalizeForCompare).filter(Boolean))].sort().join('|')
  return key(a) === key(b)
}

/**
 * 從卡片內容抽出「連結：<網址>」的網址（切卡規則 12 產生的行）。
 * 正規化：去 query/hash、去尾斜線、host 小寫——同一個募資頁不同輪抓到的連結字串才對得起來。
 * 內容裡不只一條連結行（或沒有）回 null。
 */
export function extractCardLink(content: string): string | null {
  const links = String(content || '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('連結：'))
    .map(l => l.slice('連結：'.length).trim())
    .filter(Boolean)
  if (links.length !== 1) return null
  try {
    const u = new URL(links[0]!)
    const path = u.pathname.replace(/\/+$/, '')
    return `${u.host.toLowerCase()}${path}`
  }
  catch {
    return null
  }
}

/** 集合內「只出現一次」的連結才可靠：同一產品頁切出的多張卡會共用同一條連結，不能拿來配對 */
function uniqueLinkMap<T>(items: T[], linkOf: (t: T) => string | null): Map<string, T> {
  const count = new Map<string, number>()
  const first = new Map<string, T>()
  for (const it of items) {
    const link = linkOf(it)
    if (!link) continue
    count.set(link, (count.get(link) ?? 0) + 1)
    if (!first.has(link)) first.set(link, it)
  }
  for (const [link, n] of count) {
    if (n > 1) first.delete(link)
  }
  return first
}

export function computeDiff(oldChunks: OldChunk[], newChunks: NewChunk[]): DiffResult {
  // 標題也用正規化後當索引：「特色：溫控」與「特色:溫控」是同一張卡，
  // 用原字串當 key 會讓它掉進第二輪、甚至變成「移除 + 新增」。
  const oldByTitle = new Map<string, OldChunk>()
  for (const c of oldChunks) {
    const key = normalizeForCompare(c.title)
    if (!oldByTitle.has(key)) oldByTitle.set(key, c)
  }

  const entries: DiffEntry[] = []
  const summary: DiffSummary = { added: 0, modified: 0, removed: 0, unchanged: 0 }
  const matchedOldIds = new Set<string>()
  const unmatchedNew: Array<{ n: NewChunk; idx: number }> = []


  const pushUnchanged = (o: OldChunk, n: NewChunk) => {
    entries.push({
      id: `same:${o.id}`,
      kind: 'unchanged',
      defaultAction: 'keep_old',
      oldChunk: { id: o.id, title: o.title, content: o.content, tags: o.tags, manuallyEdited: o.manuallyEditedAtMs > 0 },
      newChunk: { title: n.title, content: n.content, tags: n.tags, questions: n.questions ?? [] },
    })
    summary.unchanged++
  }

  const pushModified = (o: OldChunk, n: NewChunk) => {
    const manuallyEdited = o.manuallyEditedAtMs > 0
    const oldNums = extractNumbers(o.content)
    const newNums = extractNumbers(n.content)
    const gone = multisetDiff(oldNums, newNums)
    const came = multisetDiff(newNums, oldNums)
    entries.push({
      id: `mod:${o.id}`,
      kind: 'modified',
      // 手動編輯過 → 預設保留人工版；沒編輯過 → 預設用新版
      defaultAction: manuallyEdited ? 'keep_old' : 'use_new',
      oldChunk: { id: o.id, title: o.title, content: o.content, tags: o.tags, manuallyEdited },
      newChunk: { title: n.title, content: n.content, tags: n.tags, questions: n.questions ?? [] },
      numbersChanged: gone.length > 0 || came.length > 0,
      ...(gone.length || came.length
        ? { numberChanges: { removed: gone.slice(0, 6), added: came.slice(0, 6) } }
        : {}),
      titleChanged: normalizeForCompare(o.title) !== normalizeForCompare(n.title),
    })
    summary.modified++
  }

  /** 配上對之後的判定：形變等價 → unchanged，真有差 → modified */
  const pushMatched = (o: OldChunk, n: NewChunk) => {
    if (contentEquivalent(o.content, n.content)
      && tagsEquivalent(o.tags, n.tags)
      && normalizeForCompare(o.title) === normalizeForCompare(n.title)) {
      pushUnchanged(o, n)
    }
    else {
      pushModified(o, n)
    }
  }

  // ── 第 0 輪：穩定鍵配對——卡片內容裡的「連結：」網址 ─────────────
  // 列表頁（募資首頁）一個品項一條專案連結，是比標題穩得多的身分：
  // 品項改名（「義比壓壓」⇄「義式半自動」）、文案重寫都不影響連結。
  // 沒有這一輪，改名的品項會被判成「新增＋移除」→ 配上縮水保護的「移除預設保留」
  // → 同一台商品兩張卡越滾越多（C-40 的病）。
  // 只用「新舊兩邊都唯一」的連結：同一產品頁切出的多張卡共用連結，配了會亂點鴛鴦。
  const linkPairedNewIdx = new Set<number>()
  {
    const oldByLink = uniqueLinkMap(oldChunks, c => extractCardLink(c.content))
    const newByLink = uniqueLinkMap(newChunks.map((n, idx) => ({ n, idx })), x => extractCardLink(x.n.content))
    for (const [link, o] of oldByLink) {
      const cand = newByLink.get(link)
      if (!cand || matchedOldIds.has(o.id)) continue
      matchedOldIds.add(o.id)
      linkPairedNewIdx.add(cand.idx)
      pushMatched(o, cand.n)
    }
  }

  // ── 第一輪：title 相等（正規化後）─────────────────────────
  for (let i = 0; i < newChunks.length; i++) {
    if (linkPairedNewIdx.has(i)) continue // 第 0 輪已用連結配走
    const n = newChunks[i]!
    const o = oldByTitle.get(normalizeForCompare(n.title))
    if (!o || matchedOldIds.has(o.id)) {
      unmatchedNew.push({ n, idx: i })
      continue
    }
    matchedOldIds.add(o.id)
    pushMatched(o, n)
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
      // 走 pushMatched 而非直接 pushModified：內容一字不差、只有標題多了個全形空白的卡
      // 在這裡也該是「未變」。原本無條件當 modified，等於每次重切都憑空生出待決定項。
      pushMatched(o, best.n)
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
): Promise<{ text: string; rawLength: number; contentHash: string; truncatedBySize: boolean }> {
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
  return { text: extracted.text, rawLength: extracted.rawLength, contentHash, truncatedBySize: extracted.truncatedBySize === true }
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
