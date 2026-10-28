/**
 * 知識庫「分組」（`C-320`；`D-127` 分組就是商品）與商品名的其他叫法（別名，`C-323`）：型別與純函式。
 * 原本寫在知識庫頁 `sources/index.vue`，`C-406` 把三個分組視窗搬成獨立元件時一起搬出來。
 */
import { normalizeProductName } from '~~/shared/product-name-similarity'
import { sameProductGroupName } from '~~/shared/knowledge-product-group'

/** 一個分組（資料庫裡叫 folder；畫面上叫「分組」，`C-320`） */
export interface KbFolderRow {
  id: string
  name: string
  order: number
  createdAtMs: number
  /** 「通用」那一組（FAQ、公告、價目表這種不是講單一商品的，`C-320`）：排最上面、名字旁標「通用」。⚠️ 舊伺服器沒有這一格，一律用 `=== true` 判斷 */
  general: boolean
}

/** 系統抓到、等人判斷「是不是同一台」的一組商品名 */
export interface ProductAliasCandidate {
  key: string
  a: string
  b: string
  reason: string
  confidence: 'high' | 'medium'
  variantRisk: boolean
}

/** 已確認的對照：別名 → 最終正式名 */
export interface ProductAliasPair { aliasKey: string; alias: string; canonical: string }

/** 編輯分組「客人還會怎麼叫它」的一列 */
export interface GroupAliasRow {
  /** 最終正式名（別名指向它） */
  product: string
  /** 打開時就有的別名（原樣寫法） */
  original: string[]
  /** 現在的（標籤） */
  current: string[]
  /** 輸入框裡還沒加進去的字（按儲存時一起收，見 KnowledgeGroupEditDialog 的 save） */
  draft: string
}

/** 名字就是這個的商品分組（`D-127`：組名＝商品名） */
export function productGroupNamed(folders: readonly KbFolderRow[], name: string): KbFolderRow | null {
  return folders.find(f => !f.general && sameProductGroupName(f.name, name)) ?? null
}

/**
 * 兩個名字只有一個是商品分組的組名 → 組名排前面＝合併後的正式名（`D-127` 組名就是商品名；/code-review 第 6 條）。
 * 以前一律拿比較長的當正式名，較長的常是沒有分組的舊全名：按「是同一台」反而把組名收成舊名字的別名，
 * 那一組的卡片全被收斂回舊名字、編輯分組裡的叫法也全看不到
 */
export function groupNameFirst<T extends { a: string; b: string }>(folders: readonly KbFolderRow[], c: T): T {
  return !productGroupNamed(folders, c.a) && productGroupNamed(folders, c.b) ? { ...c, a: c.b, b: c.a } : c
}

/** 同一組名字（不分先後、不分寫法） */
export function sameAliasPair(x: { a: string; b: string }, y: { a: string; b: string }): boolean {
  const k = (p: { a: string; b: string }) => [normalizeProductName(p.a), normalizeProductName(p.b)].sort().join('|')
  return k(x) === k(y)
}

/**
 * `D-127` 分組就是商品：一組一列，商品名＝組名（伺服器照組名掛在底下每一份上），列出指向它的別名。
 * （`C-323` 那時是「這一組裡每個商品名各一列」——一組裡可能有好幾種寫法；現在只有組名一種）
 */
export function buildGroupAliasRows(folder: KbFolderRow, pairs: readonly ProductAliasPair[]): GroupAliasRow[] {
  const key = normalizeProductName(folder.name)
  if (!key) return []
  const aliases = pairs.filter(p => normalizeProductName(p.canonical) === key).map(p => p.alias)
  return [{ product: folder.name, original: aliases, current: [...aliases], draft: '' }]
}

/**
 * 下拉可以挑的：其他現有商品名（挑了＝當成這一台）；已經是這一台的、已經在框裡的不列。
 * finalOf：正規化的別名 → 最終正式名
 */
export function groupAliasOptions(row: GroupAliasRow, productNames: readonly string[], finalOf: ReadonlyMap<string, string>): string[] {
  const rowKey = normalizeProductName(row.product)
  const taken = new Set(row.current.map(normalizeProductName))
  return productNames.filter((n) => {
    const k = normalizeProductName(n)
    return k !== rowKey && !taken.has(k) && normalizeProductName(finalOf.get(k) ?? n) !== rowKey
  })
}

/** 這一列跟打開時比，加了哪些、拿掉哪些（不分寫法） */
export function groupAliasDiff(row: GroupAliasRow): { added: string[]; removed: string[] } {
  const before = new Set(row.original.map(normalizeProductName))
  const after = new Set(row.current.map(normalizeProductName))
  return {
    added: row.current.filter(a => !before.has(normalizeProductName(a))),
    removed: row.original.filter(a => !after.has(normalizeProductName(a))),
  }
}
