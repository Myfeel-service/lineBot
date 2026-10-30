import type { Firestore } from 'firebase-admin/firestore'
import { capMapSize } from './bounded-cache'
import { scanModuleGraph, type ModuleGraphScan, type SheetModuleUse } from './broken-module-refs'
import { loadSheetProductRegistry } from './sheet-products'
import { loadSheetRows, type SheetRow, type SheetSourceSummary } from './sheet-field-hydrate'
import { sheetCatalogIssues, type SheetCatalogIssues } from '~~/shared/sheet-catalog'
import { SHEET_FIELD_IMAGE, SHEET_FIELD_NAME, isCurrentProductRef, sheetRowKey } from '~~/shared/sheet-field'

/**
 * 試算表商品的五種提醒（`C-438`，`D-166` ⑤ 規格 §5.6）＋模組頁「要處理的事」那一塊，同一支算。
 *
 * - 商品目錄四種（放不下、抓不到圖、少了一列、是改名嗎）：只看**有商品目錄在用**的試算表——
 *   FAQ 那種一列一題的表少一列不是「商品不見了」，亮了只是吵。
 * - 模組用到的那一欄／那一列找不到（`C-432` 剩下那半）：看每個啟用中的模組帶出的每一格。
 *
 * 讀多少：模組那份掃描本來就有（壞按鈕那顆提醒，5 分鐘快取，⛔ 不另外讀 flows）；
 * 有商品目錄才讀那幾份商品清單（一份一筆）；有模組帶出試算表的格子才讀試算表的卡（60 秒快取）。
 * 這裡的結果再快取 5 分鐘：模組存檔清掉掃描快取時這裡跟著重算（認的是掃描那一份是不是換了）。
 */

export interface SheetCatalogIssueEntry extends SheetCatalogIssues {
  flowId: string
  flowName: string
  sourceId: string
}

export interface SheetFieldIssue {
  flowId: string
  flowName: string
  field: string
  /** 哪一列；null＝商品資訊範本的「這個商品」 */
  row: string | null
  /** field＝表上沒有這一欄；row＝表上沒有這一列 */
  kind: 'field' | 'row'
}

export interface SheetIssues {
  /** 每一個（啟用中的）商品目錄一筆，沒事的也列（知識庫那一行連結、模組頁要知道哪份表有目錄） */
  catalogs: SheetCatalogIssueEntry[]
  fields: SheetFieldIssue[]
}

const CACHE_TTL_MS = 5 * 60 * 1000
const cache = new Map<string, { scan: ModuleGraphScan, data: SheetIssues, expires: number }>()

export async function findSheetIssues(db: Firestore, workspaceId: string, opts: { skipCache?: boolean } = {}): Promise<SheetIssues> {
  const scan = await scanModuleGraph(db, workspaceId, opts)
  const hit = opts.skipCache ? null : cache.get(workspaceId)
  if (hit && hit.scan === scan && hit.expires > Date.now()) return hit.data

  const active = scan.sheetModules.filter(m => m.isActive)
  const catalogs: SheetCatalogIssueEntry[] = []
  const sourceIds = [...new Set(active.flatMap(m => m.catalogSourceIds))]
  const regs = new Map(await Promise.all(sourceIds.map(async id => [id, await loadSheetProductRegistry(db, workspaceId, id)] as const)))
  for (const m of active) {
    for (const sourceId of m.catalogSourceIds) {
      const reg = regs.get(sourceId)
      // 還沒同步出商品清單的表：沒有可以講的（目錄那一塊自己會講「還沒整理出商品清單」）
      const issues = reg ? sheetCatalogIssues(reg) : { overflow: [], noImage: [], missing: [], renameUnsure: [] }
      catalogs.push({ flowId: m.id, flowName: m.name, sourceId, ...issues })
    }
  }

  let fields: SheetFieldIssue[] = []
  if (active.some(m => m.fieldRefs.length)) {
    const { rows, sources } = await loadSheetRows(workspaceId)
    fields = sheetFieldIssues(active, rows, sources)
  }

  const data = { catalogs, fields }
  cache.set(workspaceId, { scan, data, expires: Date.now() + CACHE_TTL_MS })
  capMapSize(cache, 50)
  return data
}

/** 商品目錄上按了「是改名」「不賣了」之後：下一次提醒馬上反映（不等 5 分鐘） */
export function invalidateSheetIssuesCache(workspaceId: string): void {
  cache.delete(workspaceId)
}

/**
 * 模組帶出的每一格，試算表上還找不找得到。
 * ⛔ 不知道的不報：有試算表還沒同步過（不知道有哪幾欄）就不判斷「那一列不見了」——它的列根本還沒讀進來。
 * 範本的「這個商品」：商品名、商品圖永遠在；其他欄只要任何一份有欄名的表有就算在（送出時照客人點的那份表填）。
 */
export function sheetFieldIssues(modules: SheetModuleUse[], rows: Map<string, SheetRow>, sources: SheetSourceSummary[]): SheetFieldIssue[] {
  const known = sources.filter(s => s.headers)
  if (!known.length) return []
  const allHeaders = new Set(known.flatMap(s => s.headers!))
  const rowsComplete = known.length === sources.length
  const out: SheetFieldIssue[] = []
  for (const m of modules) {
    for (const ref of m.fieldRefs) {
      if (isCurrentProductRef(ref)) {
        if (ref.field === SHEET_FIELD_NAME || ref.field === SHEET_FIELD_IMAGE || allHeaders.has(ref.field)) continue
        out.push({ flowId: m.id, flowName: m.name, field: ref.field, row: null, kind: 'field' })
        continue
      }
      const row = rows.get(sheetRowKey(ref.row))
      if (!row) {
        if (rowsComplete) out.push({ flowId: m.id, flowName: m.name, field: ref.field, row: ref.row, kind: 'row' })
        continue
      }
      if (!row.headers.includes(ref.field)) out.push({ flowId: m.id, flowName: m.name, field: ref.field, row: ref.row, kind: 'field' })
    }
  }
  return out
}

/** 提醒那一句（第一個例子＋還有幾個）：只講商品名，最多三個 */
export function sheetProductNames(names: string[], max = 3): string {
  const head = names.slice(0, max).map(n => `「${n}」`).join('、')
  return names.length > max ? `${head}等 ${names.length} 個` : head
}

/** 範本／模組用到的那一格找不到了：哪個模組、哪一欄（或哪一列）、客人會怎樣 */
export function sheetFieldIssueText(i: SheetFieldIssue): string {
  if (i.row === null) return `範本「${i.flowName}」用到的「${i.field}」這一欄找不到了，那一行不會顯示`
  if (i.kind === 'row') return `「${i.flowName}」用到的「${i.row}」這一列找不到了，客人收到的停在上次的內容`
  return `「${i.flowName}」用到的「${i.field}」這一欄找不到了，客人收到的停在上次的內容`
}
