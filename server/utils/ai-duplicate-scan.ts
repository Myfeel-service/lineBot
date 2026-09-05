/**
 * 跨來源重複偵測（C-40(c)）——三層漏斗，AI 只當判官、人做拍板。
 *
 * 為什麼：同一台商品的知識散在不同來源（首頁總覽 94 條 vs 各產品專頁 vs 客服表格），
 * 從來沒有人查「既有卡彼此」是不是同一件事。已實際咬過人：7/31「上好ㄟ＝威技」
 * 同機不同名答矛盾、C-36 GPLUS 兩個名字害客人被轉真人。
 *
 * 設計（評估拍板）：
 *   第 1 層（免費）：C-33 的產品名相似度尺管字串看得出來的，這裡不重做。
 *   第 2 層（幾乎免費）：卡片 embedding 是已付費資產——兩兩算 cosine，
 *     超過門檻的才是候選。字串完全不像的（「上好ㄟ」vs「威技」、暱稱 vs 正式名）
 *     只有這一層抓得到。
 *   第 3 層（LLM 判官，一次呼叫）：只看候選名單，判「同一件事嗎」。
 *     ⛔規則寫死 C-36 的教訓：數字/型號不同（12L vs 16L、W1 vs ULTRA）一律當
 *     不同型號；不確定就回 unsure＝不出建議。寧可漏、不可誤。
 *   出口：只出建議（附白話理由），合併/刪除永遠留人按——接現成的產品名合併
 *   （合錯可解除）與回收桶（刪錯可還原），兩道後悔藥都已就位。
 *
 * 成本紀律：結果存 knowledgeDupScans/{workspaceId} 一份文件；卡片集合沒變
 * （指紋相同）就整輪跳過＝零 LLM 費。掃描本身圈進 C-45 的額度境域。
 */
import { createHash } from 'node:crypto'
import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import { generateJson, runWithLlmBudget } from './gemini'
import { KNOWLEDGE_CHUNKS_COLLECTION } from './ai-knowledge-chunks'
import { extractNumbers } from './ai-knowledge-resync'
import { recordAiUsage } from './ai-usage'

export const KNOWLEDGE_DUP_SCANS_COLLECTION = 'knowledgeDupScans'

/** 向量相似度門檻：低於這個連候選都不算（0.90 實務上＝幾乎同一段話） */
export const DUP_SIM_THRESHOLD = 0.9
/** 單輪最多送給 LLM 判官的候選組數（控制單次呼叫的 prompt 長度） */
export const DUP_MAX_CANDIDATES = 30
/** 單一 workspace 最多掃的卡數（超過先掃前面的並記 truncated） */
export const DUP_SCAN_CARD_LIMIT = 800
/** 同一 workspace 兩次掃描的最短間隔（指紋沒變本來就零成本，這是額外保險） */
export const DUP_SCAN_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface DupCardLite {
  id: string
  title: string
  productName: string
  sourceId: string | null
  /** 內容第一行（重點行）——給 LLM 判官與畫面理由用，不送全文 */
  firstLine: string
  embedding: number[]
}

export interface DupSuggestion {
  /** 穩定鍵（兩張卡 id 排序後相接）：忽略清單用它比對 */
  key: string
  /** product_split＝兩張卡各掛不同產品名（疑似同一台兩個名字）；duplicate_cards＝同產品下兩張卡講同一件事 */
  kind: 'product_split' | 'duplicate_cards'
  a: { id: string; title: string; productName: string; sourceId: string | null }
  b: { id: string; title: string; productName: string; sourceId: string | null }
  similarity: number
  /** LLM 判官的白話理由（給人看的，不是給程式看的） */
  reason: string
}

/** cosine 相似度（Gemini embedding 未必單位化，照定義算） */
export function cosineSim(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export function dupPairKey(idA: string, idB: string): string {
  return [idA, idB].sort().join('~')
}

/**
 * 第 2 層：兩兩比對取 ≥ threshold 的組，分數高的優先。
 *
 * ⛔`keep` 是「留下這組嗎」的過濾器，必須在**取前 cap 組之前**套用。
 * 2026-08-19 踩過：先 slice(30) 再過濾同來源 → 同一份文件切出來的卡本來就是全庫最像的，
 * 一個 94 條的型錄輕鬆生出 30 組以上同來源高相似對，過濾完剩 0 組 →
 * LLM 判官從沒被呼叫、「上好ㄟ vs 威技」這種跨來源重複永遠掃不到（整個功能的目的落空）。
 * 已忽略的組同理：每按一次忽略就永久吃掉一個名額。
 */
export function topSimilarPairs(
  cards: DupCardLite[],
  threshold = DUP_SIM_THRESHOLD,
  cap = DUP_MAX_CANDIDATES,
  keep: (a: DupCardLite, b: DupCardLite) => boolean = () => true,
): Array<{ a: DupCardLite; b: DupCardLite; similarity: number }> {
  const pairs: Array<{ a: DupCardLite; b: DupCardLite; similarity: number }> = []
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const s = cosineSim(cards[i]!.embedding, cards[j]!.embedding)
      if (s < threshold) continue
      if (!keep(cards[i]!, cards[j]!)) continue
      pairs.push({ a: cards[i]!, b: cards[j]!, similarity: s })
    }
  }
  return pairs.sort((x, y) => y.similarity - x.similarity).slice(0, cap)
}

/**
 * 候選分類：兩邊產品名都有且不同 → 疑似「同一台兩個名字」（接產品名合併）；
 * 其他（同名或有一邊沒掛）→ 疑似「重複卡」（接擇一刪、進回收桶）。
 * 同一來源內的同產品高相似對不報——那是切卡粒度問題，刪了反而掉資訊。
 */
export function classifyPair(a: DupCardLite, b: DupCardLite): DupSuggestion['kind'] | null {
  const pa = a.productName.trim()
  const pb = b.productName.trim()
  if (pa && pb && pa !== pb) return 'product_split'
  if (a.sourceId && a.sourceId === b.sourceId) return null
  return 'duplicate_cards'
}

/** 卡片集合指紋：id＋更新時間排序後雜湊。集合沒變＝上次的建議還新鮮＝整輪零成本跳過 */
export function cardSetFingerprint(rows: Array<{ id: string; updatedAtMs: number }>): string {
  const norm = rows.map(r => `${r.id}:${r.updatedAtMs}`).sort().join('|')
  return createHash('sha256').update(norm).digest('hex')
}

interface JudgeVerdictRow {
  index?: unknown
  verdict?: unknown
  reason?: unknown
}

const JUDGE_SYSTEM_INSTRUCTION = `你在幫商家清理客服知識庫。使用者會給你幾組「疑似重複」的知識卡（每組兩張，附標題、所屬產品、重點行）。任務：逐組判斷兩張卡是不是「同一台產品的同一件事」。

規則（嚴格遵守）：
1. verdict 只能是 "same" / "different" / "unsure"。
2. ⛔型號、容量、尺寸等**數字或型號代碼不同**（例：12L vs 16L、W1 vs ULTRA、806 vs 807）一律回 "different"——那是同系列的不同型號，合併會讓 AI 拿 A 型號的規格回答 B 型號。
3. 同一台產品的暱稱與正式名（例：「義比壓壓」與「義式半自動雙膠囊咖啡機」）算 "same"。
4. 沒有足夠把握就回 "unsure"，不要猜。寧可漏、不可誤。
5. reason 用一句白話說明（給店家看的，不要術語），例：「兩張都在講同一台咖啡機的保固，一張用暱稱一張用正式名」。

輸出格式（嚴格 JSON）：{ "results": [ { "index": 0, "verdict": "same", "reason": "string" } ] }`

/**
 * 判官規則 2 的程式後檢（`C-143`）：兩張卡的**標題數字對不上**就不准判 same。
 *
 * 為什麼 prompt 寫了還要程式再守一次：規則 2 白紙黑字寫「12L vs 16L 一律 different」，
 * 但 2026-09-04 實測判官仍把「GPLUS除濕機6L開關機操作」與「12L開關機操作」判成 same
 * ——同系列不同型號的操作說明內容幾乎一字不差，模型會被內容說服而無視標題上的型號。
 * 這跟 C-27 觸發詞後檢是同一課：**寫在 prompt 裡的紅線，模型偶爾會踩，紅線要有程式版**。
 *
 * 判準＝比對兩個標題各自的「數字串多重集合」（對不上就從建議剔除＝不出建議）：
 *   「6L 開關機」vs「12L 開關機」→ {6} vs {12} → 擋下（從建議剔除）
 *   「HEALSIO 2.4L 功能」vs「HEALSIO 產品特色」→ {2.4} vs {} → 一邊沒有數字＝不擋
 *   （缺型號 ≠ 不同型號；這組是真的同一鍋）
 *   「BOYA mini2」vs「BOYA mini 2」→ {2} vs {2} → 不擋（空白差異不算）
 * 寧可漏、不可誤：擋錯（真重複被放過）只是少一條建議，放錯（跨型號被合併）會讓 AI
 * 拿 A 型號的規格回答 B 型號。
 */
export function titleModelConflict(titleA: string, titleB: string): boolean {
  /**
   * ⛔ 沿用重新同步那邊的 `extractNumbers`，不要自己再寫一版（2026-09-04 code review）：
   * 手寫版只轉全形**數字**，於是「1,000」被拆成 {1,000}、全形「２．４」被拆成 {2,4}，
   * 跟「1000」「2.4」比就變成「型號不同」→ **真的重複被誤擋、而且只留一行 log**。
   * `extractNumbers` 走 `normalizeForCompare`（全形標點也轉、空白去掉），千分位與小數都吃得對。
   */
  const digits = (t: string) => extractNumbers(t).sort().join(',')
  const a = digits(titleA)
  const b = digits(titleB)
  if (!a || !b) return false // 一邊沒有數字＝比不出型號，交給判官
  return a !== b
}

/**
 * 第 3 層：LLM 判官，一次呼叫判完整批候選。失敗 throw（呼叫端決定跳過本輪）。
 */
export async function judgeCandidates(
  pairs: Array<{ a: DupCardLite; b: DupCardLite }>,
): Promise<Array<{ verdict: 'same' | 'different' | 'unsure'; reason: string }>> {
  if (!pairs.length) return []
  const prompt = [
    '請逐組判斷以下疑似重複的知識卡：',
    ...pairs.map((p, i) => [
      `[${i}]`,
      `A：標題「${p.a.title}」｜產品「${p.a.productName || '（未設）'}」｜${p.a.firstLine.slice(0, 120)}`,
      `B：標題「${p.b.title}」｜產品「${p.b.productName || '（未設）'}」｜${p.b.firstLine.slice(0, 120)}`,
    ].join('\n')),
  ].join('\n\n')

  const { data, inputTokens, outputTokens } = await generateJson<{ results?: JudgeVerdictRow[] }>(prompt, {
    systemInstruction: JUDGE_SYSTEM_INSTRUCTION,
    temperature: 0,
    maxOutputTokens: 4096,
    thinkingBudget: 0,
  })

  const out: Array<{ verdict: 'same' | 'different' | 'unsure'; reason: string }>
    = pairs.map(() => ({ verdict: 'unsure' as const, reason: '' }))
  for (const row of Array.isArray(data?.results) ? data.results : []) {
    const idx = typeof row?.index === 'number' ? row.index : Number.NaN
    if (!Number.isInteger(idx) || idx < 0 || idx >= out.length) continue
    const v = String(row?.verdict ?? '')
    if (v === 'same' || v === 'different' || v === 'unsure') {
      out[idx] = { verdict: v, reason: String(row?.reason ?? '').slice(0, 200) }
    }
  }
  return Object.assign(out, { __usage: { inputTokens, outputTokens } }) as typeof out
}

function tsToMsSafe(v: any): number {
  return typeof v?.toMillis === 'function' ? v.toMillis() : 0
}

function embeddingToArray(v: any): number[] | null {
  if (Array.isArray(v)) return v.map(Number)
  if (typeof v?.toArray === 'function') return v.toArray().map(Number) // Firestore VectorValue
  return null
}

export interface DupScanResult {
  outcome: 'scanned' | 'skipped_fresh' | 'skipped_unchanged' | 'skipped_too_few'
  suggestions: number
  candidates: number
}

/**
 * 掃一個 workspace 並把建議存進 knowledgeDupScans/{workspaceId}。
 * 冪等且吝嗇：指紋沒變或 24 小時內掃過就跳過（零 LLM 費）。
 * force＝手動觸發（略過 24 小時保險，但指紋沒變仍跳過——結果不會不同）。
 */
export async function runDuplicateScan(
  db: Firestore,
  workspaceId: string,
  opts: { force?: boolean } = {},
): Promise<DupScanResult> {
  const scanRef = db.collection(KNOWLEDGE_DUP_SCANS_COLLECTION).doc(workspaceId)
  const prev = (await scanRef.get()).data() as any | undefined

  if (!opts.force && prev?.scannedAtMs && Date.now() - prev.scannedAtMs < DUP_SCAN_MIN_INTERVAL_MS) {
    return { outcome: 'skipped_fresh', suggestions: (prev?.suggestions ?? []).length, candidates: 0 }
  }

  const snap = await db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .where('status', '==', 'indexed')
    .select('title', 'productName', 'sourceId', 'content', 'embedding', 'isOverview', 'deletedAt', 'updatedAt')
    .limit(DUP_SCAN_CARD_LIMIT)
    .get()

  const cards: DupCardLite[] = []
  const fingerprintRows: Array<{ id: string; updatedAtMs: number }> = []
  for (const d of snap.docs) {
    const c = d.data() as any
    if (c?.isOverview === true || c?.deletedAt != null) continue
    const embedding = embeddingToArray(c?.embedding)
    if (!embedding) continue
    fingerprintRows.push({ id: d.id, updatedAtMs: tsToMsSafe(c?.updatedAt) })
    cards.push({
      id: d.id,
      title: String(c?.title ?? ''),
      productName: String(c?.productName ?? '').trim(),
      sourceId: c?.sourceId != null ? String(c.sourceId) : null,
      firstLine: String(c?.content ?? '').split('\n').map(s => s.trim()).find(Boolean) ?? '',
      embedding,
    })
  }

  if (cards.length < 2) {
    return { outcome: 'skipped_too_few', suggestions: 0, candidates: 0 }
  }

  const fingerprint = cardSetFingerprint(fingerprintRows)
  if (fingerprint === prev?.fingerprint) {
    // 卡片集合沒變：只戳掃描時間，建議沿用
    await scanRef.set({ scannedAtMs: Date.now() }, { merge: true }).catch(() => {})
    return { outcome: 'skipped_unchanged', suggestions: (prev?.suggestions ?? []).length, candidates: 0 }
  }

  const ignored = new Set<string>(Array.isArray(prev?.ignoredKeys) ? prev.ignoredKeys.map(String) : [])

  // 第 2 層：向量候選（同來源與已忽略的在取名額**之前**就排除，見 topSimilarPairs 註解）
  /**
   * ⛔ 型號後檢要在**取名額之前**就套用（2026-09-04 code review）。
   * 放在判官之後的代價有兩層：①同系列不同型號的說明書內容幾乎一字不差＝相似度最高，
   * 每次真掃都排在候選最前面被送去判、被判、再被丟掉——**每輪重付一次 LLM 錢**；
   * ②它們還吃掉 30 個名額，把真正該被判的跨來源重複擠出批次外——這正是
   * `topSimilarPairs` 註解裡那個 2026-08-19 事故的形狀。判官之後那道保留當保險。
   */
  const blockedByModel: Array<{ a: string; b: string }> = []
  const candidates = topSimilarPairs(
    cards,
    DUP_SIM_THRESHOLD,
    DUP_MAX_CANDIDATES,
    (a, b) => {
      if (classifyPair(a, b) == null || ignored.has(dupPairKey(a.id, b.id))) return false
      if (titleModelConflict(a.title, b.title)) {
        // ⛔ 過濾掉東西要說得出丟了什麼：只留 console.warn 的話，
        //    「按幾次都沒新的」又會變成沒人查得出原因的抱怨（C-68／C-94 同款）。
        blockedByModel.push({ a: a.title, b: b.title })
        return false
      }
      return true
    },
  ).map(p => ({ ...p, kind: classifyPair(p.a, p.b)! }))

  // 第 3 層：LLM 判官（只有候選 > 0 才花這一次呼叫）
  let suggestions: DupSuggestion[] = []
  if (candidates.length) {
    const verdicts = await judgeCandidates(candidates)
    const usage = (verdicts as any).__usage
    if (usage?.inputTokens || usage?.outputTokens) {
      await recordAiUsage(workspaceId, {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        importInputTokens: usage.inputTokens,
        importOutputTokens: usage.outputTokens,
      }, db).catch(() => {})
    }
    suggestions = candidates
      .map((p, i) => ({ p, v: verdicts[i]! }))
      .filter(x => x.v.verdict === 'same') // ⛔different/unsure 都不出建議：寧可漏、不可誤
      // 規則 2 的程式後檢（`C-143`）：標題數字對不上的，判官說 same 也不算數
      .filter(({ p }) => {
        if (!titleModelConflict(p.a.title, p.b.title)) return true
        console.warn(`[dup-scan] 判官違反規則2被後檢擋下：「${p.a.title}」vs「${p.b.title}」`)
        return false
      })
      .map(({ p, v }) => ({
        key: dupPairKey(p.a.id, p.b.id),
        kind: p.kind,
        a: { id: p.a.id, title: p.a.title, productName: p.a.productName, sourceId: p.a.sourceId },
        b: { id: p.b.id, title: p.b.title, productName: p.b.productName, sourceId: p.b.sourceId },
        similarity: Math.round(p.similarity * 1000) / 1000,
        reason: v.reason || '兩張卡內容高度相似',
      }))
  }

  await scanRef.set({
    workspaceId,
    fingerprint,
    scannedAtMs: Date.now(),
    scannedAt: FieldValue.serverTimestamp(),
    cardCount: cards.length,
    truncated: snap.size >= DUP_SCAN_CARD_LIMIT,
    suggestions,
    /**
     * 因「標題型號不同」被擋掉的組（`C-146`）：**存進資料、不是只寫 log**。
     * 這是同系列不同型號（6L/12L）最常見的形狀，量可能不少；沒有這份紀錄的話，
     * 「為什麼這兩張明明很像卻沒被建議合併」永遠查不出來（同 C-68／C-94 的沉默死亡）。
     */
    blockedByModel: blockedByModel.slice(0, 30),
    blockedByModelCount: blockedByModel.length,
    // ⛔**不要**寫回 ignoredKeys：這支從頭到尾只讀不改它，而判官那幾秒內使用者可能剛按了
    // 「忽略」（dismiss 用 arrayUnion 寫入）——把掃描開始時的快照寫回去會把那次忽略吃掉，
    // 該組下次又冒出來。少寫一個欄位就沒有這個競態。
  }, { merge: true })

  return { outcome: 'scanned', suggestions: suggestions.length, candidates: candidates.length }
}

/**
 * 排程進入點：一輪掃一個 workspace（LLM 最多一次呼叫）。
 * 用 knowledgeChunks 現有的 workspace 集合輪轉游標；圈進 C-45 額度境域。
 */
export async function scanNextWorkspaceForDuplicates(db: Firestore): Promise<{ workspaceId: string | null; result?: DupScanResult }> {
  // 從 knowledgeSources 抽 distinct workspace（知識功能的使用者才需要掃；比掃全 workspaces 便宜）
  const cursorRef = db.collection('cronState').doc('dup-scan')
  const cursor = String(((await cursorRef.get()).data() as any)?.lastWorkspaceId ?? '')

  const pick = await db.collection('knowledgeSources')
    .orderBy('workspaceId')
    .select('workspaceId')
    .startAfter(cursor)
    .limit(1)
    .get()

  let workspaceId = pick.empty ? '' : String((pick.docs[0]!.data() as any)?.workspaceId ?? '')
  if (!workspaceId) {
    // 游標到底：繞回開頭（下一輪從頭掃）
    await cursorRef.set({ lastWorkspaceId: '' }, { merge: true }).catch(() => {})
    return { workspaceId: null }
  }

  await cursorRef.set({ lastWorkspaceId: workspaceId }, { merge: true }).catch(() => {})
  const result = await runWithLlmBudget(workspaceId, () => runDuplicateScan(db, workspaceId))
  return { workspaceId, result }
}
