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
 * 偵測疑似別名。純函式（可測），只用手上已有的資料，不呼叫 LLM：
 *   訊號1 來源名稱本身用「｜」並列兩個叫法（使用者上傳的檔名就寫了，最可靠）
 *   訊號2 一個名稱包含另一個（簡稱／全稱；若多出來的部分含型號字眼則標記風險）
 * 已確認過或已被否決的組合不再列出。
 * 只差標點/空白的寫法差異由 normalizeProductName 自動吸收，不列為候選（見下方註解）。
 */
export function detectAliasCandidates(input: {
  sources: Array<{ name?: string; productName?: string }>
  productNames: string[]
  aliasMap: ProductAliasMap
}): AliasCandidate[] {
  const { aliases, dismissedPairs } = input.aliasMap
  const dismissed = new Set(dismissedPairs)
  const out = new Map<string, AliasCandidate>()

  const resolved = (n: string) => aliases[normalizeProductName(n)]
  const alreadyLinked = (a: string, b: string) => {
    const ca = resolved(a) ?? a
    const cb = resolved(b) ?? b
    return normalizeProductName(ca) === normalizeProductName(cb)
  }
  const add = (c: AliasCandidate) => {
    if (dismissed.has(c.key) || alreadyLinked(c.a, c.b)) return
    if (!out.has(c.key)) out.set(c.key, c)
  }

  // ── 訊號 1：檔名/來源名以「｜」並列兩個叫法 ──
  for (const s of input.sources) {
    const raw = String(s.name ?? '')
    const parts = raw
      .split(/[｜|]/)
      .map(p => p.replace(/[-–—]?\s*(使用)?說明書.*$/i, '').replace(/\.(pdf|pptx|xlsx?|docx?)$/i, '').trim())
      .filter(p => p.length >= 3)
    if (parts.length < 2) continue
    const [a, b] = [parts[0]!, parts[1]!]
    if (normalizeProductName(a) === normalizeProductName(b)) continue
    add({
      key: aliasPairKey(a, b),
      // 較長的當正式名（資訊較完整）
      a: a.length >= b.length ? a : b,
      b: a.length >= b.length ? b : a,
      reason: `這兩個名字並列在同一份文件的名稱裡：「${raw.slice(0, 60)}」`,
      confidence: 'high',
      variantRisk: false,
    })
  }

  // ── 訊號 2/3：名稱之間的字面關係 ──
  const names = [...new Set(input.productNames.map(n => n.trim()).filter(Boolean))]
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

// ── 讀取 / 快取 ────────────────────────────────────────────────

const ALIAS_TTL_MS = 60_000
const aliasCache = new Map<string, { expiresAt: number; value: ProductAliasMap }>()

export function invalidateProductAliases(workspaceId?: string) {
  if (workspaceId) aliasCache.delete(workspaceId)
  else aliasCache.clear()
}

export async function getProductAliases(db: Firestore, workspaceId: string): Promise<ProductAliasMap> {
  const cached = aliasCache.get(workspaceId)
  if (cached && cached.expiresAt > Date.now()) return cached.value
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
  return aliases[normalizeProductName(raw)] ?? raw
}

// ── 寫入 ──────────────────────────────────────────────────────

/** 確認「這兩個是同一台」：把 alias 指向 canonical，並把 canonical 補進產品名清單 */
export async function confirmAlias(
  db: Firestore,
  workspaceId: string,
  canonical: string,
  alias: string,
): Promise<void> {
  const c = canonical.trim()
  const a = alias.trim()
  if (!c || !a || normalizeProductName(c) === normalizeProductName(a)) return
  await db.collection(PRODUCT_NAMES_COLLECTION).doc(workspaceId).set(
    {
      names: FieldValue.arrayUnion(c),
      aliases: { [normalizeProductName(a)]: c },
      aliasLabels: { [normalizeProductName(a)]: a },
      dismissedPairs: FieldValue.arrayUnion(aliasPairKey(c, a)),
    },
    { merge: true },
  )
  invalidateProductAliases(workspaceId)
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
