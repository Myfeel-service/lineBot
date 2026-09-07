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
  /**
   * 措辭級修改（`C-144`）：意思判官認定「兩版意思相同，只是換句話說」。
   * UI 把這種摺疊起來、預設保留原卡——重切 LLM 每次輸出的措辭本來就會飄，
   * 讓人逐條審「可享有→可享」這種差異，真的變動反而被淹沒。
   */
  cosmetic?: boolean
  /**
   * `kind='removed'` 專用（`C-154`）：這張卡的內容**其實還在剛抓下來的網頁上**，
   * 只是這次 AI 換了一種分法所以沒對上。＝不是網頁刪掉了，是重切噪音。
   *
   * 為什麼這是根治：`C-145` 量過的實例是「移除 18／新增 1／修改 8」——
   * 意思判官只碰得到「修改」那 8 筆（三成），而這一項處理的是最大那塊，
   * 而且是**確定性的字串比對、零 LLM 成本**，判不錯。
   */
  stillOnPage?: boolean
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
  /**
   * 可以豁免的項目 id——**只能由伺服器自己算出來的那份**（`C-153`）。
   *
   * ⛔ 這裡以前直接讀 `entry.cosmetic`，而那個欄位是**從瀏覽器送回來的**：
   *    等於把「永久推進指紋」（推進後每次重新同步都直接回「已是最新」、差異從此蒸發）
   *    的決定權交給一個伺服器驗不了的欄位。判定結果現在存在伺服器端，呼叫端傳這份進來。
   *    傳空集合＝不豁免任何東西＝退回 `C-44` 的保守行為（方向安全）。
   */
  exemptIds: ReadonlySet<string> = new Set(),
): number {
  let n = 0
  for (const e of entries) {
    const a = decisions[e.id]
    /**
     * 豁免的項目保留原卡**不算**「保留了與網頁不同的內容」：
     * 系統已經確認過兩邊等價（措辭差異／內容其實還在網頁上），推進指紋是誠實的。
     * 不豁免的後果是一個會自己延續的迴圈：重切措辭本來就會飄 → 幾乎每次都有差異
     * → 指紋永不推進 → 排程又標「有變動」→ 再燒一次完整重切 → **永遠到不了「已是最新」**。
     */
    if (exemptIds.has(e.id) && (a === 'keep_old' || a === 'skip' || a === undefined)) continue
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

// ── 措辭差異的意思判官（`C-144`）────────────────────────────────
//
// 為什麼要有：重新同步是「舊卡 vs LLM 重切產物」的比對，而 LLM 每次輸出的措辭本來就會飄
// （temperature 0 也擋不住「可享有→可享」「支援 EQ 調整→EQ 設定調整」）。2026-09-04 實測
// BOYA FAQ 一次 resync 的 8 條 modified **全是**這種措辭差異，而字面相似度從 0.53 到 0.94
// 都有——**字串門檻判不動**（設低會把真改動一起吞掉），「意思一樣」只有 LLM 判得出來。
//
// ⛔ 紅線用程式守，不信 prompt（同 C-143 / C-27 的教訓）：
//    **數字有變的一律不送判、不摺疊**——價格、期限、容量改了就是真變動，
//    就算判官說「意思一樣」也不算數。

export const COSMETIC_JUDGE_SYSTEM = `你在幫商家審核客服知識卡的更新。使用者會給你幾組「舊版 vs 新版」的知識卡（含標題與內容）。任務：逐組判斷新版跟舊版的**意思**是否完全相同（只是換句話說、調整排版或重點行的寫法）。

規則（嚴格遵守）：
1. verdict 只能是 "same_meaning" / "changed" / "unsure"。
2. 新版多了資訊、少了資訊、或任何事實面的改變（條件、範圍、步驟、限制）→ "changed"。
3. ⛔**標題裡的型號、容量、版本代碼不同**（例：6L vs 12L、W1 vs ULTRA）→ 一律 "changed"。
   那是不同型號的兩張卡，不是換句話說。
4. 標題只是換個說法而內容意思相同（例：「運費說明」→「運費與配送說明」）→ "same_meaning"。
5. 只是同義改寫、語序調整、重點行格式不同 → "same_meaning"。
6. 沒有把握就回 "unsure"，不要猜。寧可多讓人看一條，不可把真變動藏起來。

輸出格式（嚴格 JSON）：{ "results": [ { "index": 0, "verdict": "same_meaning" } ] }`

/**
 * 判官一次看得完的長度。超過就不送判——**看不完卻回「意思一樣」是最危險的那種錯**。
 * ⛔ 不要改成「截斷後照送」：那正是 `C-146` 修掉的 bug（前 800 字相同、差異在第 900 字，
 *    判官收到兩段一模一樣的內容，必回 same_meaning，真的新增內容就被摺疊藏起來）。
 */
export const COSMETIC_JUDGE_MAX_CHARS = 800

/**
 * 一次送幾組給判官。比照重複偵測判官的 30——`maxOutputTokens: 2048` 大約只夠回 60～70 列 JSON，
 * 不分批的話 100 組會把輸出撐爆、JSON 解析失敗，**整批 token 白花而且零結論**。
 */
export const COSMETIC_JUDGE_BATCH = 25

/**
 * 送判的候選。兩道程式紅線，都在花 LLM 的錢之前就擋掉：
 *  ① 數字有變 → 不送（價格、期限、容量改了就是真變動，判官說什麼都不算數）
 *  ② 任一邊長到看不完 → 不送（見 COSMETIC_JUDGE_MAX_CHARS）
 * 擋掉的不是丟掉：它們照常以 modified 攤在畫面上給人看，只是不享有「自動摺疊」。
 *
 * ⚠️ 這裡**曾經**有第三道「標題變了就不送」（`C-146`）。那道守門是在補一個更上游的錯：
 * 判官當時只收得到內容、看不到標題，所以標題上的型號改動會被它判成「意思一樣」。
 * 正解是**把標題也送進去**（`C-155`，重複偵測那個判官一開始就這樣做），
 * 於是那道守門可以刪掉——而且刪掉才對：重切本來就常順手改標題
 *（「運費說明」→「運費與配送說明」），那道守門等於把這個功能自己的主場排除在外。
 */
export function pickCosmeticCandidates(diff: DiffResult): DiffEntry[] {
  return diff.entries.filter(e =>
    e.kind === 'modified'
    && !e.numbersChanged
    && (e.oldChunk?.content?.length ?? 0) <= COSMETIC_JUDGE_MAX_CHARS
    && (e.newChunk?.content?.length ?? 0) <= COSMETIC_JUDGE_MAX_CHARS,
  )
}

/**
 * 把判官結果寫回那幾張卡（`candidates` 是 `diff.entries` 裡的物件，就地標記）。
 * ⛔ 只動「有送判、且判官明確說意思相同」的：unsure / changed / 沒回覆的一律保持原樣，
 *    numbersChanged 的根本不在候選裡（見 pickCosmeticCandidates）。
 */
export function applyCosmeticVerdicts(
  candidates: DiffEntry[],
  verdicts: Array<'same_meaning' | 'changed' | 'unsure'>,
): { folded: number } {
  let folded = 0
  candidates.forEach((entry, i) => {
    if (verdicts[i] !== 'same_meaning') return
    // ⛔ 保險再守一次：就算呼叫端送錯候選，數字有變的也不准摺
    if (entry.numbersChanged) return
    entry.cosmetic = true
    entry.defaultAction = 'keep_old' // 意思沒變＝不動卡片（重寫只是燒 embedding 錢）
    folded++
  })
  return { folded }
}

/**
 * 意思判官本體：一次呼叫判完整批。失敗 throw（呼叫端自行決定跳過＝全部照舊給人看，
 * 判官掛掉的代價只是「多看幾條」，不能讓它擋整個 resync）。
 */
export async function judgeCosmeticRewrites(
  pairs: Array<{ oldTitle: string; old: string; nextTitle: string; next: string }>,
): Promise<{ verdicts: Array<'same_meaning' | 'changed' | 'unsure'>; inputTokens: number; outputTokens: number }> {
  if (!pairs.length) return { verdicts: [], inputTokens: 0, outputTokens: 0 }
  const { generateJson } = await import('./gemini')

  // 全部先預設 unsure：任何一批掛掉，那一批就是「沒判到」＝照常攤給人看
  const verdicts: Array<'same_meaning' | 'changed' | 'unsure'> = pairs.map(() => 'unsure')
  let inputTokens = 0
  let outputTokens = 0

  for (let start = 0; start < pairs.length; start += COSMETIC_JUDGE_BATCH) {
    const batch = pairs.slice(start, start + COSMETIC_JUDGE_BATCH)
    const prompt = [
      '請逐組判斷新版與舊版的意思是否完全相同：',
      // ⛔ 不再 slice：候選階段已經擋掉超長的（見 pickCosmeticCandidates ③）。
      //    在這裡截斷＝判官看不完卻照樣給結論，那是 `C-146` 修掉的 bug。
      ...batch.map((p, i) => [
        `[${i}]`,
        `舊版標題：${p.oldTitle}`,
        `舊版內容：${p.old}`,
        `新版標題：${p.nextTitle}`,
        `新版內容：${p.next}`,
      ].join('\n')),
    ].join('\n\n')
    try {
      const res = await generateJson<{ results?: Array<{ index?: unknown; verdict?: unknown }> }>(prompt, {
        systemInstruction: COSMETIC_JUDGE_SYSTEM,
        temperature: 0,
        maxOutputTokens: 2048,
        thinkingBudget: 0,
      })
      inputTokens += res.inputTokens
      outputTokens += res.outputTokens
      for (const row of Array.isArray(res.data?.results) ? res.data.results : []) {
        const idx = typeof row?.index === 'number' ? row.index : Number.NaN
        if (!Number.isInteger(idx) || idx < 0 || idx >= batch.length) continue
        const v = String(row?.verdict ?? '')
        if (v === 'same_meaning' || v === 'changed' || v === 'unsure') verdicts[start + idx] = v
      }
    }
    catch (e) {
      // ⛔ 一批失敗不放棄整輪：其餘批次照跑，這一批留在 unsure（攤給人看）。
      //    不分批的話，一次 100 組會把輸出撐爆 → JSON 解析失敗 → 整批 token 白花、零結論。
      console.warn(`[resync] 意思判官第 ${Math.floor(start / COSMETIC_JUDGE_BATCH) + 1} 批失敗（這批照常給人看）:`, (e as Error)?.message)
    }
  }
  return { verdicts, inputTokens, outputTokens }
}


// ── 伺服器端的「可豁免項目」帳本（`C-153`）────────────────────────────
//
// 為什麼要落地到 Firestore：算出「這幾項等價」的是重新同步那份背景工作，
// 而按下「套用」的是另一支端點，兩者之間只隔著使用者的瀏覽器。把判定結果放在
// 回應裡繞一圈再送回來，等於讓前端有機會（無論惡意或只是 bug）決定要不要
// 永久推進指紋——而指紋一推進，這次保留的差異就再也沒有人看得到。
//
// ⛔ 一定要綁 `contentHash`：這份帳本對應的是「那一版網頁」。排程可能在使用者
//    看 diff 的期間又抓了一次並覆寫，對不上就當作沒有帳本（不豁免＝保守）。

interface DiffLedgerDoc {
  contentHash: string
  exemptIds: string[]
  savedAtMs: number
}

const DIFF_LEDGER_DOC = 'lastDiffExempt'

/** 把這一輪算出來的「可豁免項目」存起來，供之後的套用查核 */
export async function saveDiffExemptIds(
  db: Firestore,
  sourceId: string,
  contentHash: string,
  exemptIds: string[],
): Promise<void> {
  if (!sourceId || !contentHash) return
  try {
    await db.collection('knowledgeSources').doc(sourceId)
      .collection('cache').doc(DIFF_LEDGER_DOC)
      .set({ contentHash, exemptIds, savedAtMs: Date.now() } satisfies DiffLedgerDoc)
  }
  catch (e) {
    // 寫不進去不擋流程：後果只是這次套用不豁免任何項目（保守方向）
    console.warn('[resync] 可豁免項目帳本寫入失敗（這次套用一律不豁免）:', (e as Error)?.message)
  }
}

/** 讀回「可豁免項目」。⛔ contentHash 對不上一律回空集合＝不豁免 */
export async function loadDiffExemptIds(
  db: Firestore,
  sourceId: string,
  contentHash: string,
): Promise<Set<string>> {
  if (!sourceId || !contentHash) return new Set()
  try {
    const snap = await db.collection('knowledgeSources').doc(sourceId)
      .collection('cache').doc(DIFF_LEDGER_DOC).get()
    const doc = snap.data() as DiffLedgerDoc | undefined
    if (!doc || doc.contentHash !== contentHash) return new Set()
    return new Set(Array.isArray(doc.exemptIds) ? doc.exemptIds.map(String) : [])
  }
  catch (e) {
    console.warn('[resync] 可豁免項目帳本讀取失敗（這次套用一律不豁免）:', (e as Error)?.message)
    return new Set()
  }
}


// ── 「移除」其實只是換了分法（`C-154`）──────────────────────────────
//
// 重新同步每次都把整頁丟給 LLM 重切，而分組方式本來就會飄：同一段內容這次切成一塊、
// 下次切成兩塊，於是舊卡對不上新卡 → 被列成「移除」。`C-145` 量到的實例是
// 移除 18 筆裡幾乎全是這種，人卻要逐張判斷「要不要刪掉」。
//
// 判準：這張卡的內容是不是**還出現在剛抓下來的網頁純文字裡**。還在 → 網頁沒有刪掉它，
// 只是這次沒對上 → 摺疊起來、預設保留（本來就是預設保留，這裡只是不再要人看）。
//
// ⛔ 確定性比對，不進 LLM：這是它比意思判官可靠的地方——判官會看走眼，字串比對不會。
// ⛔ 用「內容的實質片段」比，不是整段比：重切常常順手改標點、合併空白，整段逐字比對
//    幾乎一定失敗。正規化（全形轉半形、去空白，沿用 normalizeForCompare）之後取
//    最長的幾段來比，任一段還在頁面上就算數。

/** 一張卡至少要有幾個字才值得拿去比對（太短的片段在長網頁裡必然命中＝誤判） */
const STILL_ON_PAGE_MIN_CHARS = 24

/** 從卡片內容取出用來比對的片段：最長的幾行（跳過「重點：」那種摘要行） */
export function pickProbeLines(content: string, max = 3): string[] {
  return String(content ?? '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length >= STILL_ON_PAGE_MIN_CHARS && !l.startsWith('重點：'))
    .sort((a, b) => b.length - a.length)
    .slice(0, max)
}

/**
 * 這張卡的內容還在網頁上嗎（純函式，可測）。
 *
 * ⛔ 取不到夠長的片段時回 `false`（＝不摺疊、照樣攤給人看）：
 *    短卡在長網頁裡幾乎一定「命中」，回 true 會把真的被刪掉的短卡也藏起來。
 */
export function contentStillOnPage(cardContent: string, pageText: string): boolean {
  const probes = pickProbeLines(cardContent)
  if (!probes.length) return false
  const page = normalizeForCompare(pageText)
  if (!page) return false
  return probes.some(line => page.includes(normalizeForCompare(line)))
}

/**
 * 把「其實還在網頁上」的移除項標記起來，回傳標了幾筆。
 * 呼叫端負責把網頁純文字傳進來（重新同步時本來就剛抓過，不必多抓一次）。
 */
export function markRemovedStillOnPage(diff: DiffResult, pageText: string): { marked: number } {
  if (!pageText.trim()) return { marked: 0 }
  let marked = 0
  for (const e of diff.entries) {
    if (e.kind !== 'removed' || !e.oldChunk) continue
    // 手動編輯過的卡本來就預設保留、而且人特別在意 → 不摺疊，照樣給人看
    if (e.oldChunk.manuallyEdited) continue
    if (!contentStillOnPage(e.oldChunk.content, pageText)) continue
    e.stillOnPage = true
    e.defaultAction = 'keep_old'
    marked++
  }
  return { marked }
}
