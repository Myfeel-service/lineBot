/**
 * 試算表上的「商品」（`C-434`，`D-166` ⑤「商品的事都在試算表做」，規格 `docs/PRODUCT-SHEET-CATALOG-DESIGN-20261030.md`）。
 *
 * **為什麼要有**：商品目錄、商品資訊範本、模組裡「試算表的一格」都要知道「這一列是哪個商品」。
 * 以前只用商品名（第一欄）認——店家改個錯字、補個型號就斷了，客人收到的字停在改名那天、沒人知道（`C-432`）。
 *
 * **怎麼認**：「商品頁面」格子裡的第一個網址為主（改名通常不會換網址），沒有網址才退回商品名。
 * 每次同步拿這一份跟上一份比：
 *  - 名字變了、網址一樣 → 同一個商品，**自動接上**（記一筆「改名」）；舊名字留在 `aliases`，模組用舊名寫的那一格照樣找得到。
 *  - 名字和網址都變了 → 認不出來：舊的記「少了」、新的記「新增」，並把這一輪新增的列掛在舊的 `renameCandidates`
 *    讓店家確認「是改名嗎？」（`confirmSheetProductRename`）。⛔ 不猜。
 *  - 少了一列 → `missingSince`，不刪（加回來就接上原本的圖、標籤）。
 *
 * 「放進LINE目錄」這種**開關欄**不進知識卡內容（AI 讀到只是雜訊），讀表時另外收（`isSheetControlHeader`）。
 */
import { sheetRowKey } from './sheet-field'

/** 打勾＝放進 LINE 商品目錄。列的順序就是目錄的順序 */
export const SHEET_CATALOG_HEADER = '放進LINE目錄'
/** 有填才出現「常見問答」按鈕；這欄照常進 AI */
export const SHEET_FAQ_HEADER = '常見問答頁'

/** 欄名比對用：全半形、空白、大小寫不算 */
export function sheetHeaderKey(h: unknown): string {
  return String(h ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase()
}

const CATALOG_HEADER_KEYS = new Set([sheetHeaderKey(SHEET_CATALOG_HEADER), sheetHeaderKey('放進目錄')])

/** 「放進LINE目錄」這欄（開關，不給 AI 讀） */
export function isSheetCatalogHeader(h: unknown): boolean {
  return CATALOG_HEADER_KEYS.has(sheetHeaderKey(h))
}

/** 開關欄：讀表時另外收，不進知識卡內容。目前只有「放進LINE目錄」 */
export function isSheetControlHeader(h: unknown): boolean {
  return isSheetCatalogHeader(h)
}

/**
 * 勾了沒。Google 試算表的勾選框讀出來是 TRUE／FALSE；店家自己打字的常見寫法也認。
 * ⛔ 認不得的一律當「沒勾」：寧可少放一張，不要把沒打算上架的東西放給客人看。
 */
const CHECKED = new Set(['true', 'v', 'y', 'yes', '1', 'o', '○', '✓', '✔', '☑', '是', '有', '勾', '要'])
export function parseSheetCheckbox(v: unknown): boolean {
  return CHECKED.has(String(v ?? '').normalize('NFKC').trim().toLowerCase())
}

/**
 * 格子裡第一個網址。MYFEEL 的格子是「以下提供商品頁面連結供您參考： https://…」這種句子，不是光一個網址。
 * 網址後面黏著的標點（，。）」等）不算。
 */
export function firstHttpUrl(text: unknown): string | null {
  const m = String(text ?? '').match(/https?:\/\/[^\s<>"'，。、；：！？（）「」『』【】]+/i)
  if (!m) return null
  return m[0].replace(/[.,;:!?)\]}]+$/, '') || null
}

/**
 * 網址比對用的 key：主機（去掉 www.）＋路徑（解碼、去掉結尾斜線），小寫；查詢字串、#後面不算。
 * `AINotePods%2010S` 跟 `AINotePods 10S` 算同一個。解析不了＝null（退回用商品名認）。
 */
export function productUrlKey(url: unknown): string | null {
  const raw = String(url ?? '').trim()
  if (!raw) return null
  let u: URL
  try { u = new URL(raw) }
  catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  let path = u.pathname
  try { path = decodeURIComponent(path) }
  catch { /* 解不開就用原樣 */ }
  path = path.replace(/\/+$/, '')
  return `${u.hostname.toLowerCase().replace(/^www\./, '')}${path}`.toLowerCase()
}

/** 哪一欄是商品頁：欄名有「商品頁」「商品網址」「商品連結」的第一欄（「常見問答頁」不算）。沒有＝null */
export function findProductPageHeader(headers: readonly string[]): string | null {
  for (const h of headers) {
    const k = sheetHeaderKey(h)
    if (k.includes('常見問答')) continue
    if (k.includes('商品頁') || k.includes('商品網址') || k.includes('商品連結')) return h
  }
  return null
}

/** 這一輪讀到的一列 */
export interface SheetProductRow {
  title: string
  pageUrl: string | null
  inCatalog: boolean
}

export interface SheetProductInput {
  rows: SheetProductRow[]
  /** 表上有沒有「放進LINE目錄」這欄（沒有＝換新做法的第 1 步還沒做；商品目錄要講缺哪一欄） */
  catalogColumn: boolean
  /** 認成商品頁的那一欄；null＝表上沒有，全部用商品名認 */
  pageHeader: string | null
}

export interface SheetProduct {
  /** 短代號（點目錄卡片時跟著 postback 走，上限 300 字，⛔ 不放網址） */
  id: string
  title: string
  nameKey: string
  /** 改名前的名字（`sheetRowKey`）；模組裡用舊名寫的「試算表的一格」靠它接到現在這一列（`C-432`） */
  aliases: string[]
  pageUrl: string | null
  urlKey: string | null
  inCatalog: boolean
  /** 在表上第幾列（0 起算）；目錄照這個排 */
  order: number
  firstSeenAt: number
  /** 表上找不到的時間；還在＝null */
  missingSince: number | null
  /** 認不出來的改名：這一輪新增的那幾個商品 id，等店家確認「是改名嗎？」 */
  renameCandidates?: string[]
  /**
   * 從商品頁抓的封面圖（`C-435`）。一律是我們 Storage 上的 JPG（LINE 只收 JPG／PNG，官網常是 GIF／WebP）。
   * 店家換了自己的圖也照樣留著——「改回商品頁封面圖」才能馬上換回來。
   */
  cover?: { url: string, fromUrlKey: string, at: number }
  /** 店家在商品目錄「換圖」傳的（`C-435`）；有這張就用這張，不再跟著官網換 */
  ownImage?: { url: string, at: number }
  /** 上一次抓封面圖失敗（`C-435`）；抓到就拿掉 */
  coverError?: SheetProductImageError
  /** 客人點目錄卡片時貼的標籤（`C-436`）：第一次進目錄時自動建；⛔ 改名不改標籤名（推播靠它挑人） */
  tagId?: string
}

/** 這個商品現在用哪張圖：自己換的優先，再來是商品頁封面圖；都沒有＝null（⛔ 不放進目錄，不出現空白卡） */
export function productImage(p: SheetProduct): { url: string, source: 'own' | 'web' } | null {
  if (p.ownImage?.url) return { url: p.ownImage.url, source: 'own' }
  if (p.cover?.url) return { url: p.cover.url, source: 'web' }
  return null
}

/**
 * noCover＝商品頁上找不到封面圖（不重試，換了網址才再抓）；
 * pageUnreachable／imageUnreachable＝連不上、太大；badImage＝不是讀得懂的圖——這三種最多試 `COVER_MAX_ATTEMPTS` 次。
 */
export type SheetProductImageFailReason = 'noCover' | 'pageUnreachable' | 'imageUnreachable' | 'badImage'

export interface SheetProductImageError {
  reason: SheetProductImageFailReason
  /** 失敗的是哪個商品頁；網址換了就重新算 */
  urlKey: string
  attempts: number
  at: number
}

export type SheetProductChangeKind =
  | 'added'
  | 'removed'
  | 'returned'
  | 'renamed'
  | 'renameUnsure'
  | 'catalogOn'
  | 'catalogOff'

/** 「試算表最近的變動」一筆 */
export interface SheetProductChange {
  at: number
  kind: SheetProductChangeKind
  productId: string
  title: string
  prevTitle?: string
  candidateIds?: string[]
}

export interface SheetProductRegistry {
  products: Record<string, SheetProduct>
  /** 新的在前，最多 `SHEET_PRODUCT_CHANGES_MAX` 筆 */
  changes: SheetProductChange[]
  catalogColumn: boolean
  pageHeader: string | null
  /**
   * 有商品目錄照這份試算表排（`C-436`）：自動建標籤時名稱的開頭（例：MYFEEL 的「客服 - 」，空字串＝就叫商品名）。
   * 沒有這格＝還沒有目錄用這份表，⛔ 不替它建標籤。存模組時寫進來
   */
  catalogTagPrefix?: string
}

export const SHEET_PRODUCT_CHANGES_MAX = 30
const ALIASES_MAX = 10
const RENAME_CANDIDATES_MAX = 5

/** 物件鍵照字母排的字串（Firestore 讀回來的鍵順序不一定跟寫進去一樣，直接 JSON.stringify 比會一直以為「變了」） */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort()
      .filter(k => (v as Record<string, unknown>)[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v ?? null)
}

const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))]

/**
 * 拿這一輪讀到的表跟上一份比，產生新的商品清單＋這一輪的變動。
 * prev＝null（第一次）：照表建，⛔ 不記「新增」——那不是店家這次做的事，記了會在畫面上冒出一整排「新增」。
 * `changed`＝需不需要寫回去（只有順序、名字、開關、在不在這些真的變了才算）。
 */
export function reconcileSheetProducts(
  prev: SheetProductRegistry | null,
  input: SheetProductInput,
  now: number,
  newId: () => string,
): { registry: SheetProductRegistry, changed: boolean, newChanges: SheetProductChange[] } {
  const prevProducts = prev?.products ?? {}
  const next: Record<string, SheetProduct> = {}
  for (const [id, p] of Object.entries(prevProducts)) next[id] = { ...p, aliases: [...(p.aliases ?? [])] }

  // 表內同名的列只認第一列（跟同步配卡片同一個規矩）
  const seenNames = new Set<string>()
  const rows = input.rows
    .map((r, order) => ({ ...r, order, nameKey: sheetRowKey(r.title), urlKey: productUrlKey(r.pageUrl) }))
    .filter((r) => {
      if (!r.nameKey || seenNames.has(r.nameKey)) return false
      seenNames.add(r.nameKey)
      return true
    })

  const claimed = new Set<string>()
  const matchOf = new Map<number, string>()
  // 1) 網址
  for (const r of rows) {
    if (!r.urlKey) continue
    const hit = Object.values(next).find(p => !claimed.has(p.id) && p.urlKey === r.urlKey)
    if (hit) { claimed.add(hit.id); matchOf.set(r.order, hit.id) }
  }
  // 2) 名字（含改名前的舊名）
  for (const r of rows) {
    if (matchOf.has(r.order)) continue
    const hit = Object.values(next).find(p => !claimed.has(p.id) && (p.nameKey === r.nameKey || p.aliases.includes(r.nameKey)))
    if (hit) { claimed.add(hit.id); matchOf.set(r.order, hit.id) }
  }

  const bootstrap = prev === null
  const newChanges: SheetProductChange[] = []
  const addedIds: string[] = []

  for (const r of rows) {
    const id = matchOf.get(r.order)
    if (!id) {
      const pid = newId()
      next[pid] = {
        id: pid,
        title: r.title,
        nameKey: r.nameKey,
        aliases: [],
        pageUrl: r.pageUrl,
        urlKey: r.urlKey,
        inCatalog: r.inCatalog,
        order: r.order,
        firstSeenAt: now,
        missingSince: null,
      }
      addedIds.push(pid)
      if (!bootstrap) newChanges.push({ at: now, kind: 'added', productId: pid, title: r.title })
      continue
    }
    const p = next[id]!
    if (p.missingSince !== null) {
      newChanges.push({ at: now, kind: 'returned', productId: id, title: r.title })
    }
    if (p.nameKey !== r.nameKey) {
      newChanges.push({ at: now, kind: 'renamed', productId: id, title: r.title, prevTitle: p.title })
      p.aliases = uniq([...p.aliases, p.nameKey]).filter(k => k !== r.nameKey).slice(-ALIASES_MAX)
    }
    if (p.inCatalog !== r.inCatalog && p.missingSince === null) {
      newChanges.push({ at: now, kind: r.inCatalog ? 'catalogOn' : 'catalogOff', productId: id, title: r.title })
    }
    p.title = r.title
    p.nameKey = r.nameKey
    p.pageUrl = r.pageUrl
    p.urlKey = r.urlKey
    p.inCatalog = r.inCatalog
    p.order = r.order
    p.missingSince = null
    delete p.renameCandidates
  }

  // 3) 表上不見的：記時間、不刪。這一輪也有新增的列＝可能是名字和網址一起改了，問店家
  for (const p of Object.values(next)) {
    if (claimed.has(p.id) || addedIds.includes(p.id)) continue
    if (p.missingSince !== null) continue
    p.missingSince = now
    const candidates = addedIds.slice(0, RENAME_CANDIDATES_MAX)
    if (candidates.length) {
      p.renameCandidates = candidates
      newChanges.push({ at: now, kind: 'renameUnsure', productId: p.id, title: p.title, candidateIds: candidates })
    }
    else {
      newChanges.push({ at: now, kind: 'removed', productId: p.id, title: p.title })
    }
  }

  const registry: SheetProductRegistry = {
    products: next,
    changes: [...newChanges, ...(prev?.changes ?? [])].slice(0, SHEET_PRODUCT_CHANGES_MAX),
    catalogColumn: input.catalogColumn,
    pageHeader: input.pageHeader,
    // 存模組時寫的設定，⛔ 同步整份覆寫時要帶著走（不然每小時同步一次就把它洗掉）
    ...(prev?.catalogTagPrefix !== undefined ? { catalogTagPrefix: prev.catalogTagPrefix } : {}),
  }
  const changed = bootstrap
    || newChanges.length > 0
    || canonical(prevProducts) !== canonical(next)
    || prev!.catalogColumn !== input.catalogColumn
    || prev!.pageHeader !== input.pageHeader
  return { registry, changed, newChanges }
}

/**
 * 店家按「是改名，接到新的名字」：留舊商品的 id（圖、標籤、目錄設定都掛在它上面），換成新那一列的名字與網址，
 * 新的那一筆拿掉。任一個找不到＝原樣回（null）。
 */
export function confirmSheetProductRename(reg: SheetProductRegistry, oldId: string, newId: string, now: number): SheetProductRegistry | null {
  const old = reg.products[oldId]
  const nw = reg.products[newId]
  if (!old || !nw || oldId === newId) return null
  const products: Record<string, SheetProduct> = {}
  for (const [id, p] of Object.entries(reg.products)) {
    if (id === newId) continue
    const copy: SheetProduct = { ...p, aliases: [...p.aliases] }
    if (copy.renameCandidates) {
      const rest = copy.renameCandidates.filter(c => c !== newId)
      if (rest.length) copy.renameCandidates = rest
      else delete copy.renameCandidates
    }
    products[id] = copy
  }
  const merged: SheetProduct = {
    id: oldId,
    title: nw.title,
    nameKey: nw.nameKey,
    aliases: uniq([...old.aliases, old.nameKey, ...nw.aliases]).filter(k => k !== nw.nameKey).slice(-ALIASES_MAX),
    pageUrl: nw.pageUrl,
    urlKey: nw.urlKey,
    inCatalog: nw.inCatalog,
    order: nw.order,
    firstSeenAt: old.firstSeenAt,
    missingSince: nw.missingSince,
  }
  // 店家換過的圖跟著舊的走（⛔ 不能因為確認改名就掉）；封面圖用新那一列的商品頁抓到的（網址換了，舊封面圖可能是別的商品頁）
  if (old.ownImage) merged.ownImage = old.ownImage
  const cover = nw.cover ?? old.cover
  if (cover) merged.cover = cover
  if (nw.coverError) merged.coverError = nw.coverError
  // 標籤跟著舊的走（推播靠它挑「點過這個商品的人」）；舊的還沒有才用新的
  const tagId = old.tagId ?? nw.tagId
  if (tagId) merged.tagId = tagId
  products[oldId] = merged
  const change: SheetProductChange = { at: now, kind: 'renamed', productId: oldId, title: nw.title, prevTitle: old.title }
  return { ...reg, products, changes: [change, ...reg.changes].slice(0, SHEET_PRODUCT_CHANGES_MAX) }
}

/** 店家按「不賣了，拿掉這張」：不再問是不是改名，那個商品維持「表上找不到」 */
export function dismissSheetProductRename(reg: SheetProductRegistry, oldId: string): SheetProductRegistry | null {
  const old = reg.products[oldId]
  if (!old?.renameCandidates) return null
  const { renameCandidates: _drop, ...rest } = old
  return { ...reg, products: { ...reg.products, [oldId]: rest } }
}

/** 抓封面圖最多試幾次（連不上、壞圖）；找不到封面圖不重試 */
export const COVER_MAX_ATTEMPTS = 3

/**
 * 這個商品要不要（再）去抓封面圖（`C-435`）：還在表上、有商品頁網址、手上的封面圖不是從這個網址抓的、這個網址還沒放棄。
 * 店家自己換了圖也照樣抓（留著給「改回商品頁封面圖」用）。
 * 商品頁網址換了：舊的封面圖先留著用，抓到新的再換（⛔ 不先拿掉，不然目錄會空一格）。
 */
export function needsCoverFetch(p: SheetProduct): boolean {
  if (p.missingSince !== null || !p.urlKey || !p.pageUrl) return false
  if (p.cover?.fromUrlKey === p.urlKey) return false
  const e = p.coverError
  if (e && e.urlKey === p.urlKey && (e.reason === 'noCover' || e.attempts >= COVER_MAX_ATTEMPTS)) return false
  return true
}

/** 要抓封面圖的商品：還沒有任何圖的先（目錄上的再更先），再照表上的順序 */
export function productsNeedingCover(reg: SheetProductRegistry): SheetProduct[] {
  const rank = (p: SheetProduct) => (productImage(p) ? 2 : 0) + (p.inCatalog ? 0 : 1)
  return Object.values(reg.products)
    .filter(needsCoverFetch)
    .sort((a, b) => rank(a) - rank(b) || a.order - b.order)
}

/** 這份商品清單還有沒有要抓的封面圖（寫成 doc 上的 `needsCover`，排程只查這種 doc） */
export function registryNeedsCover(reg: SheetProductRegistry): boolean {
  return Object.values(reg.products).some(needsCoverFetch)
}

/**
 * 抓封面圖的結果寫回去（`C-435`）。⛔ 抓的這段時間店家可能改了商品頁網址：結果是舊網址的就不寫（回 null），下一輪照新網址重抓。
 * 成功：換上這張封面圖、拿掉失敗紀錄。失敗：同一個網址累計次數；手上的舊封面圖照留。
 */
export function applyCoverResult(
  reg: SheetProductRegistry,
  productId: string,
  fetchedUrlKey: string,
  result: { ok: true, url: string } | { ok: false, reason: SheetProductImageFailReason },
  now: number,
): SheetProductRegistry | null {
  const p = reg.products[productId]
  if (!p || p.urlKey !== fetchedUrlKey) return null
  const next: SheetProduct = { ...p, aliases: [...p.aliases] }
  if (result.ok) {
    next.cover = { url: result.url, fromUrlKey: fetchedUrlKey, at: now }
    delete next.coverError
  }
  else {
    const prev = p.coverError && p.coverError.urlKey === fetchedUrlKey ? p.coverError.attempts : 0
    next.coverError = { reason: result.reason, urlKey: fetchedUrlKey, attempts: prev + 1, at: now }
  }
  return { ...reg, products: { ...reg.products, [productId]: next } }
}

/** 店家在商品目錄「換圖」：之後就用這張，不再跟著官網換 */
export function setOwnProductImage(reg: SheetProductRegistry, productId: string, url: string, now: number): SheetProductRegistry | null {
  const p = reg.products[productId]
  if (!p) return null
  return { ...reg, products: { ...reg.products, [productId]: { ...p, aliases: [...p.aliases], ownImage: { url, at: now } } } }
}

/** 店家按「改回商品頁封面圖」：拿掉自己換的那張，馬上改用封面圖（還沒抓到封面圖的，抓到之前沒有圖） */
export function revertProductImage(reg: SheetProductRegistry, productId: string): SheetProductRegistry | null {
  const p = reg.products[productId]
  if (!p?.ownImage) return null
  const { ownImage: _drop, ...rest } = p
  return { ...reg, products: { ...reg.products, [productId]: rest } }
}

/**
 * 舊名字 → 現在的名字（都是 `sheetRowKey`）。只列還在表上的商品；
 * 舊名字剛好是另一個現在還在的商品的名字＝那個商品優先（⛔ 不接過去）。
 */
export function sheetProductAliasMap(reg: SheetProductRegistry): Map<string, string> {
  const present = Object.values(reg.products).filter(p => p.missingSince === null)
  const current = new Set(present.map(p => p.nameKey))
  const out = new Map<string, string>()
  for (const p of present) {
    for (const a of p.aliases) {
      if (!current.has(a) && !out.has(a)) out.set(a, p.nameKey)
    }
  }
  return out
}
