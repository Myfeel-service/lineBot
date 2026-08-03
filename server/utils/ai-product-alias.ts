/**
 * 產品別名歸一：同一台機器有兩個叫法時（「上好ㄟ抽取式除濕機」＝「NWT 威技 新一級能效 16L」），
 * 讓系統知道它們是同一個產品。
 *
 * 為什麼需要：答題端判斷「兩張卡是不是同一個產品」只有三招——產品名字串相同、同一份來源、
 * 標題共用英數型號。中文別名三招全不中，於是同一台被當成兩台：反問時要客人在「威技 / 上好ㄟ」
 * 之間二選一，答出貨時間還會把兩張卡當成兩台機器並列（實測災情，見 AI-KB-AUDIT-20260731 §P0-2）。
 *
 * **偵測出候選、由人確認**，不自動合併：字面上「W1 REGEN」與「W1 REGEN ULTRA」也是一個包含另一個，
 * 但它們是不同型號，自動合併會讓客人問 ULTRA 拿到普通版答案——比原本的問題更嚴重。
 *
 * 資料放 knowledgeProductIndex/{workspaceId}（與產品名清單同一份文件）：
 *   names: string[]                     既有的產品名清單
 *   aliases: { [正規化別名]: 正式名 }     確認過的對照
 *   dismissedPairs: string[]            使用者按過「不是同一台」的組合，不再重複詢問
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore'

/**
 * 與 ai-knowledge-chunks.PRODUCT_NAMES_COLLECTION 同一份文件（產品名清單與別名共存）。
 * 這裡不 import 那支、改自持字串：ai-knowledge-chunks 的索引流程要反過來用本檔的
 * canonicalProductName，互相 import 會形成循環相依。
 */
const PRODUCT_NAMES_COLLECTION = 'knowledgeProductIndex'

/** 比對用正規化：去空白、去裝飾符號、小寫 */
export function normalizeProductName(s: string): string {
  return String(s || '')
    .replace(/[《》〈〉（）()【】\[\]「」『』・·,，.。\-–—_/|｜]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

/** 一組候選的穩定 key（與順序無關），用於「不再詢問」名單 */
export function aliasPairKey(a: string, b: string): string {
  return [normalizeProductName(a), normalizeProductName(b)].sort().join('||')
}

export interface ProductAliasMap {
  /** 正規化別名 → 正式名（答題熱路徑查這個，保持扁平好查） */
  aliases: Record<string, string>
  /** 正規化別名 → 原始寫法（純顯示用；正規化過的字串拿給人看會看不懂） */
  aliasLabels: Record<string, string>
  dismissedPairs: string[]
}

export interface AliasCandidate {
  key: string
  /** 兩個叫法（a 建議當正式名：較完整的那個） */
  a: string
  b: string
  /** 白話證據，直接顯示給使用者 */
  reason: string
  confidence: 'high' | 'medium'
  /** 需要特別提醒「可能其實是不同型號」 */
  variantRisk: boolean
}

/** 型號變體字眼：出現在「多出來的那段」時，兩者很可能是不同機器而非別名 */
const VARIANT_WORDS = /(ultra|pro|plus|max|mini|lite|se|air|2nd|ii)\b/i

/**
 * 兩個名字互為包含時，多出來的那段是不是型號變體（ULTRA / PRO …）。
 * 是的話兩者很可能是不同機器：「W1 REGEN」與「W1 REGEN ULTRA」。
 */
function variantApart(na: string, nb: string): boolean {
  const shorter = na.length <= nb.length ? na : nb
  const longer = na.length <= nb.length ? nb : na
  if (shorter === longer || !longer.includes(shorter)) return false
  return VARIANT_WORDS.test(longer.replace(shorter, ''))
}

/**
 * 把檔名片段對齊到「已存在的產品名」。檔名常比卡片上存的名字多帶括號型號
 * （「…高效抽取型除濕機 (WDH31B16E）」vs 卡片上的「…高效抽取型除濕機」）；
 * 直接拿檔名片段當正式名，會多生一個沒有任何卡片在用的第三個名字——
 * 對照表查不到卡片的舊寫法，分組照樣分成兩邊，使用者按了合併卻毫無效果。
 * 找不到對應就原樣回傳。
 */
function snapToExistingName(part: string, existing: string[]): string {
  const np = normalizeProductName(part)
  if (!np) return part
  let best = ''
  for (const e of existing) {
    const ne = normalizeProductName(e)
    if (!ne || ne.length < 4) continue
    // 互為包含即視為同一個名字的長短寫法，取既有清單裡的版本。
    // 但差在型號變體時不可對齊：檔名寫「…W1 REGEN」卻對齊到既有的「…W1 REGEN ULTRA」，
    // 會把基本款的文件掛到 ULTRA 名下，還讓候選看起來「證據明確」。
    if ((np.includes(ne) || ne.includes(np)) && !variantApart(np, ne)) {
      if (ne.length > normalizeProductName(best).length) best = e
    }
  }
  return best || part
}

/**
 * 偵測疑似別名。純函式（可測），只用手上已有的資料，不呼叫 LLM：
 *   訊號1 來源名稱本身用「｜」並列兩個叫法（使用者上傳的檔名就寫了，最可靠）
 *   訊號2 一個名稱包含另一個（簡稱／全稱；若多出來的部分含型號字眼則標記風險）
 * 已確認過或已被否決的組合不再列出。
 * 只差標點/空白的寫法差異由 normalizeProductName 自動吸收，不列為候選（見下方註解）。
 */
export function detectAliasCandidates(input: {
  sources: Array<{ name?: string; productName?: string; type?: string }>
  productNames: string[]
  aliasMap: ProductAliasMap
}): AliasCandidate[] {
  const { aliases, dismissedPairs } = input.aliasMap
  const dismissed = new Set(dismissedPairs)
  const out = new Map<string, AliasCandidate>()

  // 一路解析到最終正式名,**不能只查一層**:A→B、B→C 這種連鎖下,只查一層會判定
  // A(→B) 與 C 不同,於是把早就併好的組合又列成候選;使用者按「合併」寫入的內容
  // 與現況一模一樣,畫面毫無變化,看起來就是「按了沒反應」。
  const alreadyLinked = (a: string, b: string) =>
    normalizeProductName(canonicalProductName(a, aliases))
    === normalizeProductName(canonicalProductName(b, aliases))
  const add = (c: AliasCandidate) => {
    if (dismissed.has(c.key) || alreadyLinked(c.a, c.b)) return
    // 卡片上寫「合併後會以 a 為正式名」,但 a 自己可能已經是別名(a→C),實際寫進去的會是 C。
    // 這裡先解析成最終正式名,使用者看到的才等於按下去的結果。
    if (!out.has(c.key)) out.set(c.key, { ...c, a: canonicalProductName(c.a, aliases) })
  }
  const names = [...new Set(input.productNames.map(n => n.trim()).filter(Boolean))]

  // ── 訊號 1：**檔案**來源的檔名以「｜」並列兩個叫法 ──
  // 只吃 type='file'：網址來源的 name 是網頁標題，而商城標題慣用「｜」分隔品名與站名
  // （「NWT 威技 16L 除濕機｜MiniMe 官方購物網」），一律當高信心別名會把站名併成產品，
  // 汙染整個知識庫的產品歸屬。
  for (const s of input.sources) {
    if (s.type && s.type !== 'file') continue
    const raw = String(s.name ?? '')
    const parts = raw
      .split(/[｜|]/)
      .map(p => p.replace(/[-–—]?\s*(使用)?說明書.*$/i, '').replace(/\.(pdf|pptx|xlsx?|docx?)$/i, '').trim())
      .filter(p => p.length >= 3)
    if (parts.length < 2) continue
    // 對齊既有產品名：檔名片段常多帶括號型號（…除濕機 (WDH31B16E)），直接拿它當正式名會
    // 生出「第三個名字」——卡片上存的仍是不含型號的舊寫法，對照表查不到、分組照樣分兩邊，
    // 合併等於沒生效而且沒人看得出來。
    const a0 = snapToExistingName(parts[0]!, names)
    const b0 = snapToExistingName(parts[1]!, names)
    if (normalizeProductName(a0) === normalizeProductName(b0)) continue
    // 同一份檔名並列不代表就是同一台:說明書常一次涵蓋基本款與 ULTRA。
    // 差在型號變體時要照樣標風險,否則只顯示「證據明確」會誘導使用者把兩台不同機器併掉。
    const risk = variantApart(normalizeProductName(a0), normalizeProductName(b0))
    add({
      key: aliasPairKey(a0, b0),
      // 較長的當正式名（資訊較完整）
      a: a0.length >= b0.length ? a0 : b0,
      b: a0.length >= b0.length ? b0 : a0,
      reason: risk
        ? `這兩個名字並列在同一份文件的名稱裡：「${raw.slice(0, 60)}」——但兩者只差型號字尾，**可能是同系列的不同款**，請確認`
        : `這兩個名字並列在同一份文件的名稱裡：「${raw.slice(0, 60)}」`,
      confidence: 'high',
      variantRisk: risk,
    })
  }

  // ── 訊號 2：名稱之間的字面關係 ──
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i]!
      const b = names[j]!
      const na = normalizeProductName(a)
      const nb = normalizeProductName(b)
      // 只差標點/空白/大小寫的（《筋牌特務》vs 筋牌特務）不列候選：正規化後本來就相等，
      // 答題端的分組也用正規化比對，已自動視為同一台，不必浪費使用者一次確認。
      if (!na || !nb || na === nb) continue
      const shorter = na.length <= nb.length ? na : nb
      const longer = na.length <= nb.length ? nb : na
      if (shorter.length < 4 || !longer.includes(shorter)) continue
      const longName = na.length <= nb.length ? b : a
      const shortName = na.length <= nb.length ? a : b
      const extra = longer.replace(shorter, '')
      const variantRisk = VARIANT_WORDS.test(extra) || /\d/.test(extra)
      add({
        key: aliasPairKey(a, b),
        a: longName,
        b: shortName,
        reason: variantRisk
          ? `「${longName}」比「${shortName}」多了「${extra}」——這可能是同一台的全稱，也可能是**不同型號**，請確認`
          : `「${longName}」包含「${shortName}」，可能是同一台的全稱與簡稱`,
        confidence: 'medium',
        variantRisk,
      })
    }
  }

  // 高信心的排前面，其次是沒有型號風險的
  return [...out.values()].sort((x, y) =>
    (x.confidence === y.confidence ? 0 : x.confidence === 'high' ? -1 : 1)
    || Number(x.variantRisk) - Number(y.variantRisk))
}

/** 裝飾符號數量：同一個名字的多種寫法中，優先選沒有《》【】括號的那個 */
function decorationCount(s: string): number {
  return (String(s).match(/[《》〈〉（）()【】\[\]「」『』]/g) ?? []).length
}

/**
 * 收斂同一個產品的多種寫法（「MATELASER 筋牌特務 W1 REGEN」與「MATELASER《筋牌特務》 W1 REGEN」）。
 * **只合併正規化後完全相等的**——「W1 REGEN」與「W1 REGEN ULTRA」是兩台不同機器，
 * 用「互相包含」去合併會把它們併掉。同一組取裝飾符號最少、其次較長的寫法。
 */
export function dedupeProductNames(names: string[]): string[] {
  const byKey = new Map<string, string>()
  for (const raw of names) {
    const n = String(raw ?? '').trim()
    const key = normalizeProductName(n)
    if (!n || !key) continue
    const cur = byKey.get(key)
    if (!cur) {
      byKey.set(key, n)
      continue
    }
    const better = decorationCount(n) !== decorationCount(cur)
      ? decorationCount(n) < decorationCount(cur)
      : n.length > cur.length
    if (better) byKey.set(key, n)
  }
  return [...byKey.values()]
}

// ── 讀取 / 快取 ────────────────────────────────────────────────

const ALIAS_TTL_MS = 60_000
const aliasCache = new Map<string, { expiresAt: number; value: ProductAliasMap }>()

export function invalidateProductAliases(workspaceId?: string) {
  if (workspaceId) aliasCache.delete(workspaceId)
  else aliasCache.clear()
}

export async function getProductAliases(
  db: Firestore,
  workspaceId: string,
  /** 寫入前的讀取要繞過快取:拿到 60 秒前的舊對照表會算錯要一起搬的別名 */
  opts?: { fresh?: boolean },
): Promise<ProductAliasMap> {
  const cached = aliasCache.get(workspaceId)
  if (!opts?.fresh && cached && cached.expiresAt > Date.now()) return cached.value
  let value: ProductAliasMap = { aliases: {}, aliasLabels: {}, dismissedPairs: [] }
  try {
    const snap = await db.collection(PRODUCT_NAMES_COLLECTION).doc(workspaceId).get()
    const raw = snap.data() as any
    value = {
      aliases: raw?.aliases && typeof raw.aliases === 'object' ? raw.aliases : {},
      aliasLabels: raw?.aliasLabels && typeof raw.aliasLabels === 'object' ? raw.aliasLabels : {},
      dismissedPairs: Array.isArray(raw?.dismissedPairs) ? raw.dismissedPairs.map(String) : [],
    }
  }
  catch {
    /* 讀不到就當沒有別名，不影響答題 */
  }
  aliasCache.set(workspaceId, { expiresAt: Date.now() + ALIAS_TTL_MS, value })
  return value
}

/**
 * 把產品名換成正式名。查不到對照就原樣回傳。
 * 答題端與索引端共用，確保「同一台」在各處都收斂到同一個字串。
 */
export function canonicalProductName(name: string | undefined | null, aliases: Record<string, string>): string {
  const raw = String(name ?? '').trim()
  if (!raw) return ''
  // 逐層解析:先把 A 併到 B、之後又把 B 併到 C 時,只查一層會讓 A 停在 B、
  // 卡片又分成兩組(反問二選一重新出現)。設上限並記錄走過的節點防成環。
  let cur = raw
  const seen = new Set<string>()
  for (let i = 0; i < 5; i++) {
    const key = normalizeProductName(cur)
    if (seen.has(key)) break
    seen.add(key)
    const next = aliases[key]
    if (!next || normalizeProductName(next) === key) break
    cur = next
  }
  return cur
}

// ── 寫入 ──────────────────────────────────────────────────────

/**
 * 確認「這兩個是同一台」：把 alias 指向 canonical，並把 canonical 補進產品名清單。
 *
 * 對照表一律保持**扁平**（每個別名直接指向最終正式名，不留 A→B→C 的鏈）：
 *   1. 傳進來的 canonical 若自己也是別名，改指它的最終正式名；
 *   2. 原本指向 alias 的其他別名，一併改指新的正式名。
 * 不扁平化的話「已確認的對照」會出現同一個名字既是別名又是正式名（看起來很怪），
 * 而且鏈上的組合會被重複列成候選。
 *
 * 回傳 false 代表沒有東西可改（兩者早就是同一台）——呼叫端才有辦法告訴使用者，
 * 而不是靜靜地寫入一模一樣的內容、畫面沒變讓人以為壞掉。
 */
export async function confirmAlias(
  db: Firestore,
  workspaceId: string,
  canonical: string,
  alias: string,
): Promise<boolean> {
  const a = alias.trim()
  if (!canonical.trim() || !a) return false

  const current = await getProductAliases(db, workspaceId, { fresh: true })
  const aKey = normalizeProductName(a)
  // 正式名解析到最終那一層(步驟 1)
  const c = canonicalProductName(canonical, current.aliases)
  const cKey = normalizeProductName(c)
  // 自己併自己,或反過來 canonical 早就併進 alias 了(寫下去會成環)
  if (!cKey || cKey === aKey) return false
  // 已經指向同一個正式名 → 沒有東西要改
  if (normalizeProductName(canonicalProductName(a, current.aliases)) === cKey) return false

  // 原本指向 alias 的別名要一起搬過來(步驟 2)
  const repointed: Record<string, string> = {}
  for (const [k, v] of Object.entries(current.aliases)) {
    if (k !== aKey && normalizeProductName(v) === aKey) repointed[k] = c
  }

  // 刻意**不**寫進 dismissedPairs:合併後 detectAliasCandidates 的 alreadyLinked 本來就會
  // 濾掉這組;若又記進「不再詢問」,使用者按錯後即使「解除」也永遠找不回這組候選(單向門)。
  await db.collection(PRODUCT_NAMES_COLLECTION).doc(workspaceId).set(
    {
      names: FieldValue.arrayUnion(c),
      aliases: { ...repointed, [aKey]: c },
      aliasLabels: { [aKey]: a },
    },
    { merge: true },
  )
  invalidateProductAliases(workspaceId)
  return true
}

/** 「不是同一台」：記下來不再詢問 */
export async function dismissAliasPair(
  db: Firestore,
  workspaceId: string,
  a: string,
  b: string,
): Promise<void> {
  await db.collection(PRODUCT_NAMES_COLLECTION).doc(workspaceId).set(
    { dismissedPairs: FieldValue.arrayUnion(aliasPairKey(a, b)) },
    { merge: true },
  )
  invalidateProductAliases(workspaceId)
}

/** 解除已確認的對照（使用者按錯時） */
export async function removeAlias(db: Firestore, workspaceId: string, alias: string): Promise<void> {
  const key = normalizeProductName(alias)
  if (!key) return
  await db.collection(PRODUCT_NAMES_COLLECTION).doc(workspaceId).set(
    { aliases: { [key]: FieldValue.delete() }, aliasLabels: { [key]: FieldValue.delete() } },
    { merge: true },
  )
  invalidateProductAliases(workspaceId)
}
