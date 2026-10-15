/**
 * 分組就是商品（`D-127`，2026-10-16 老闆拍板，取代 `C-320` 的「只補空的」）：
 * 資料放在哪一組＝在講哪一台，每份資料的商品名就是組名；通用、未分類＝不是講單一商品（空的）。
 *
 * 為什麼改：`C-320` 讓一台商品的名字散在三處（分組、每份資料自己的商品名、別名），AI 用的是店家最少看到的那一處，
 * 而且每加一份資料 AI 都自己想一個名字＝寫法分裂（MYFEEL 同組兩種寫法 3 組、歷來手動合併 6 組）。
 * `C-320` 當時「不用分組名蓋產品名」的兩個擔心，`D-127` 這樣處理：
 *   · 組名比產品名短、AI 少認得字 → 舊的全名、型號收成那一組的別名（產品鎖照樣認得，`C-325` productVocabulary）
 *   · 一組裡有兩款（MATELASER W1 REGEN／ULTRA）會被併成一款 → 搬家時拆成兩組
 *
 * 純函式：伺服器搬組、改組名（server/utils/ai-knowledge-product-group）、加入資料（bulk-create／create）
 * 和搬家腳本（scripts/migrate-kb-group-is-product.mjs）用同一份。
 */
import { normalizeProductName } from './product-name-similarity'

/**
 * 這份資料該掛哪個商品名（`D-127`）。商品分組＝組名；通用、未分類＝''。
 * 型錄（generateOverview）、Google 試算表＝''：一份講很多台，放在哪一組都不能整份當成那一台
 * （`C-320` /code-review 第 1 條：多商品價目表被整張標成一台、AI 答錯台；試算表的每一列照標題自己認領，pickCardProduct）。
 */
export function productNameForGroup(
  group: { name?: string | null; general?: boolean | null } | null | undefined,
  flags: { isCatalog?: boolean; isSheet?: boolean } = {},
): string {
  if (!group || group.general === true || flags.isCatalog || flags.isSheet) return ''
  return String(group.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 60)
}

/** 兩個組名是不是同一台（只差空白、符號、大小寫）。建組時拿來找「已經有這一組了」 */
export function sameProductGroupName(a: string, b: string): boolean {
  const ka = normalizeProductName(a)
  return !!ka && ka === normalizeProductName(b)
}

/**
 * 同一組資料的產品名有幾種（別名歸一＋正規化後）。每一種取組裡最多份用的那個寫法（同票取先出現的）。
 * 回傳照份數多到少排。搬家腳本拿它看「這一組是不是其實有兩款」。
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
 * 兩個商品名是不是「同系列的兩款」（`D-127` 搬家：一組裡是兩款就拆成兩組，不收成別名）：
 * 一個包含另一個、多出來的只有型號尾巴（ULTRA／MAX／數字…）——「W1 REGEN」與「W1 REGEN ULTRA」。
 * 其他寫法不同（「CHIMEI…(電淨艙)」與「奇美…」、「NWT 威技 除濕機」與「NWT 威技 新一級能效 16L…」）不算，當成同一台的不同寫法。
 */
export function isVariantPair(a: string, b: string): boolean {
  const na = normalizeProductName(a)
  const nb = normalizeProductName(b)
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na]
  if (!short || long === short || !long.includes(short)) return false
  return VARIANT_ONLY_RE.test(long.replace(short, ''))
}

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
