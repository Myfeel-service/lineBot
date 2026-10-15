/**
 * 資料夾當「商品」分組用（`C-320`，2026-10-15 拍板 `D-126`①）：放進哪一組＝告訴 AI 這份在講哪個商品。
 *
 * 為什麼：AI 只看每份資料的「所屬產品」、不看資料夾。MYFEEL 18 個資料夾裡 16 個就是商品名，
 * 卻有幾份放在商品資料夾裡、產品名是空的——客人問「小滑手…」時，AI 不知道那幾條是講小滑手的（張冠李戴的來源之一）。
 *
 * 這支只做「該不該補、補成什麼」的判斷，純函式：伺服器搬資料夾時（server/utils/ai-knowledge-product-group）
 * 和舊資料搬家腳本（scripts/migrate-kb-product-groups.mjs）用同一份，兩邊才不會一個補、一個不補。
 *
 * ⛔ 三條紅線（2026-10-15 唯讀試算後定的）：
 *   1. **不用資料夾名當產品名**：資料夾名常比產品名短——「MATELASER」資料夾裡是 W1 REGEN 與 W1 REGEN ULTRA 兩款，
 *      蓋成「MATELASER」AI 就分不出兩台。只拿**同一組其他資料已經填好的**產品名。
 *   2. **不覆蓋已經填好的**：店家填過的是他的決定。
 *   3. **拿不準就不補**：同一組有兩種以上的產品名（或一個都沒有）、通用分組、型錄——一律不動，交給人。
 */
import { normalizeProductName } from './product-name-similarity'

export interface GroupProductNameInput {
  /** 這份資料自己的產品名（空的才有可能補） */
  productName: string | null | undefined
  /** 型錄／列表來源（旗下本來就很多商品，見 KnowledgeSourceDoc.generateOverview）：不補 */
  isCatalog?: boolean
  /**
   * 這份是 Google 試算表：不補（`/code-review` 2026-10-15 第 1 條）。試算表常是一張多商品價目表，
   * 補上產品名之後，沒寫品名的那幾列學習時會退回用來源產品名（runIndexOnChunk）→ 整張表被標成那一台、AI 答錯台。
   */
  isSheet?: boolean
  /** 放進的分組；null＝未分類 */
  group: { general?: boolean } | null
  /** 同一組**其他**資料的產品名（空的會被略過） */
  siblingProductNames: readonly (string | null | undefined)[]
  /**
   * 別名歸一（伺服器傳 canonicalProductName）：「上好ㄟ除濕機」「NWT 威技 16L」確認過是同一台的話算一種。
   * 沒給就只比去空白、去標點、不分大小寫後的字。
   */
  canonical?: (name: string) => string
}

export type GroupProductNameDecision =
  | { action: 'fill'; productName: string }
  | { action: 'keep'; reason: 'has-name' | 'no-group' | 'general' | 'catalog' | 'sheet' }
  /** 判斷不出來，交給人：no-names＝同組沒有人填過、ambiguous＝同組有好幾種（names 列出來給人挑） */
  | { action: 'ask'; reason: 'no-names' | 'ambiguous'; names: string[] }

/**
 * 同一組資料的產品名有幾種（別名歸一＋正規化後）。每一種取組裡最多份用的那個寫法（同票取先出現的）。
 * 回傳照份數多到少排。
 */
export function distinctGroupProductNames(
  names: readonly (string | null | undefined)[],
  canonical?: (name: string) => string,
): string[] {
  const byKey = new Map<string, Map<string, number>>()
  const order: string[] = []
  for (const raw of names) {
    const trimmed = String(raw ?? '').trim()
    if (!trimmed) continue
    const name = (canonical ? canonical(trimmed) : trimmed).trim() || trimmed
    const key = normalizeProductName(name)
    if (!key) continue
    if (!byKey.has(key)) {
      byKey.set(key, new Map())
      order.push(key)
    }
    const spellings = byKey.get(key)!
    spellings.set(name, (spellings.get(name) ?? 0) + 1)
  }
  return order
    .map((key) => {
      const spellings = [...byKey.get(key)!.entries()]
      const total = spellings.reduce((n, [, c]) => n + c, 0)
      // Map 保留插入順序：同票時 sort 是穩定的，先出現的寫法贏
      const best = spellings.sort((a, b) => b[1] - a[1])[0]![0]
      return { best, total }
    })
    .sort((a, b) => b.total - a.total)
    .map(x => x.best)
}

export function decideGroupProductName(input: GroupProductNameInput): GroupProductNameDecision {
  if (String(input.productName ?? '').trim()) return { action: 'keep', reason: 'has-name' }
  if (!input.group) return { action: 'keep', reason: 'no-group' }
  if (input.group.general === true) return { action: 'keep', reason: 'general' }
  if (input.isCatalog) return { action: 'keep', reason: 'catalog' }
  if (input.isSheet) return { action: 'keep', reason: 'sheet' }
  const names = distinctGroupProductNames(input.siblingProductNames, input.canonical)
  if (names.length === 1) return { action: 'fill', productName: names[0]! }
  return { action: 'ask', reason: names.length ? 'ambiguous' : 'no-names', names }
}

// ── 哪些資料夾看起來是「通用」（舊資料搬家用的建議，不自動套用在新建的資料夾上）──────

/**
 * 名字像「不是講單一商品」的資料夾：客服、總覽、FAQ、公告、價目表…
 * ⛔ 只給搬家腳本列建議（加 --apply 才寫）。名字對不上的一律當商品分組——猜成通用的代價是那一組以後都不補產品名。
 */
const GENERAL_NAME_RE = /客服|總覽|通用|公告|常見問題|購物須知|購物說明|退換貨|運送|配送|付款方式|價目|價格表|政策|條款|品牌介紹|關於我們|其他|^faq$|^q&a$|^qa$/

export function looksLikeGeneralGroupName(name: string): boolean {
  const n = String(name ?? '').toLowerCase().replace(/\s+/g, '')
  return !!n && GENERAL_NAME_RE.test(n)
}

// ── 可能是同一個商品的兩個資料夾（只列建議，不自動合併）────────────────

export interface ProductGroupForDupCheck {
  id: string
  name: string
  general?: boolean
  /** 這一組裡各份資料的產品名（空的會被略過） */
  productNames: readonly (string | null | undefined)[]
}

export interface LikelyDuplicateGroups {
  a: string
  b: string
  /** name＝一個名字包含另一個（「零水鍋」⊂「SHARP 自動調理零水鍋」）；product＝兩組裡有同一個產品名 */
  why: 'name' | 'product'
}

/**
 * 名字只多了型號尾巴（MAX／PRO／ULTRA／數字…）＝另一款，不是同一個：
 * 「乾淨方」跟「乾淨方MAX」、「W1 REGEN」跟「W1 REGEN ULTRA」都是兩台。
 */
const VARIANT_ONLY_RE = /^(max|pro|plus|ultra|mini|lite|se|air|neo|s|x|\+|\d+|代|第\d+代|新版|升級版|旗艦版|旗艦|豪華版|標準版|二代|三代)+$/

/**
 * 找「可能是同一個商品、卻分成兩個資料夾」的組合（MYFEEL 實例：「零水鍋」與「SHARP 自動調理零水鍋」）。
 * 通用分組不比。⛔ 只當建議列出來給人決定，不自動合併——合錯會讓兩台的知識混在一起。
 */
export function findLikelyDuplicateGroups(groups: readonly ProductGroupForDupCheck[]): LikelyDuplicateGroups[] {
  const list = groups.filter(g => g.general !== true)
  const out: LikelyDuplicateGroups[] = []
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!
      const b = list[j]!
      const na = normalizeProductName(a.name)
      const nb = normalizeProductName(b.name)
      const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na]
      if (short.length >= 2 && long !== short && long.includes(short)) {
        const extra = long.replace(short, '')
        if (!VARIANT_ONLY_RE.test(extra)) {
          out.push({ a: a.id, b: b.id, why: 'name' })
          continue
        }
      }
      if (short && long === short) {
        out.push({ a: a.id, b: b.id, why: 'name' })
        continue
      }
      const keysA = new Set(a.productNames.map(n => normalizeProductName(String(n ?? ''))).filter(Boolean))
      if (b.productNames.some(n => keysA.has(normalizeProductName(String(n ?? ''))))) {
        out.push({ a: a.id, b: b.id, why: 'product' })
      }
    }
  }
  return out
}
