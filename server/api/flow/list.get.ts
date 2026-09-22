import { getDb, listDocs } from '~~/server/utils/firebase'
import { sortRegularFlows } from '~~/server/utils/flow-sort'
import { ACTIVE_SYSTEM_MODULE_TYPES, seedWorkspaceSystemModules, systemModuleId } from '~~/server/utils/workspace-system-modules'
import {
  buildPaginatedListResult,
  isPaginatedListQuery,
} from '~~/server/utils/paginated-collection-list'
import { parseAdminListPagination } from '~~/server/utils/admin-pagination'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'

function stripFlowTriggers(flow: Record<string, unknown>) {
  const { triggers, trigger, ...rest } = flow
  return rest
}

/**
 * 系統模組在側欄的排序。
 * ⛔ `welcome` **仍然留在這裡**：那顆 2026-09-21 起不再補建（`D-23`），但舊帳號裡
 *    可能還躺著一份；留著才排得對。⛔ 判斷「缺了要補建」請用 `ACTIVE_SYSTEM_MODULE_TYPES`。
 */
const SYSTEM_MODULE_ORDER = ['welcome', 'live_agent'] as const

/**
 * 「只要選單需要的」欄位（`?fields=picker`）。
 *
 * 為什麼要有這個模式：客服腳本／推播／活動／圖文選單／客服預存這**五個頁面**都會抓一份
 * 模組清單，但它們只是要長一個「要跳到哪個模組」的下拉選單，用到的就是名稱、編號、
 * 有沒有啟用。整份文件回去是 133 KB（63 個模組、含每個模組的每一則訊息內容），
 * 五個頁面各下載一次（2026-08-27 實測，見 docs/ADMIN-PERF-AUDIT-20260827.md）。
 *
 * 真正需要完整內容的只有「機器人模組」自己那一頁——它的側欄點一下就要直接編輯，
 * 所以**不帶這個參數時行為完全不變**（回整份），不必去動那頁的載入邏輯。
 */
const PICKER_FIELDS = [
  'name',
  'isSystem',
  'moduleType',
  'isActive',
  'createdAt', // 排序（沒設 sortOrder 時沿用 createdAt 新→舊）
  'sortOrder', // 側欄拖拉排序
  'folderId', // 資料夾分組
] as const

export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')
  const query = getQuery(event)
  const pickerOnly = String(query.fields ?? '') === 'picker'

  const fetchFlows = () => listDocs<Record<string, unknown>>('flows', (ref) => {
    const q = ref.where('workspaceId', '==', workspaceId).orderBy('createdAt', 'desc')
    return pickerOnly ? q.select(...PICKER_FIELDS) : q
  })

  let allFlows = await fetchFlows()

  /**
   * 系統模組（歡迎模組／真人客服）缺了才補建。
   *
   * ⛔ 原本是每次列清單前都先逐筆 `doc().get()` 確認存在（`workspace-system-modules.ts`
   * 裡是循序 for），也就是每次都白跑兩趟跨洋往返才開始真正的查詢。清單本身就看得出
   * 缺不缺——用它判斷，正常情況（早就建好了）零額外查詢，只有真的缺才走補建與重讀。
   */
  const missing = ACTIVE_SYSTEM_MODULE_TYPES.filter(
    type => !allFlows.some(f => f.id === systemModuleId(workspaceId, type)),
  )
  if (missing.length) {
    await seedWorkspaceSystemModules(getDb(), workspaceId)
    allFlows = await fetchFlows()
  }

  /**
   * `D-23`：**空的舊「歡迎模組」不再列出來**。
   *
   * 它沒有任何執行路徑（`systemModuleId(...,'welcome')` 在 `server/` 沒人讀），
   * 留在清單上只會讓人把內容編進去然後等一個永遠不會發生的事。
   * ⛔ **只藏空的**：真的有人把文案編進去過的話，藏起來就是讓他的東西無聲消失
   *    （這個 repo 吃過好幾次這種虧）——有內容的照舊顯示，讓他自己搬到
   *    「自動回應 → 客人加好友時」再處理。
   */
  const legacyWelcomeId = systemModuleId(workspaceId, 'welcome')
  allFlows = allFlows.filter((f) => {
    if (f.id !== legacyWelcomeId) return true
    const messages = Array.isArray(f.messages) ? f.messages : []
    // picker 模式沒帶 messages 欄位 → 拿不到內容時**保守顯示**，不要猜它是空的
    return pickerOnly ? true : messages.length > 0
  })

  const systemFlows = allFlows
    .filter(f => f.isSystem)
    .sort((a, b) => {
      const ai = SYSTEM_MODULE_ORDER.indexOf(a.moduleType as typeof SYSTEM_MODULE_ORDER[number])
      const bi = SYSTEM_MODULE_ORDER.indexOf(b.moduleType as typeof SYSTEM_MODULE_ORDER[number])
      return (ai === -1 ? Number.MAX_SAFE_INTEGER : ai)
        - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi)
    })
    .map(stripFlowTriggers)

  const regularFlows = sortRegularFlows(allFlows.filter(f => !f.isSystem)).map(stripFlowTriggers)

  if (!isPaginatedListQuery(query)) {
    return [...systemFlows, ...regularFlows]
  }

  const { page, limit, offset } = parseAdminListPagination(query)
  const total = systemFlows.length + regularFlows.length
  const systemCount = systemFlows.length

  let items: Record<string, unknown>[]
  if (page === 1) {
    const regularLimit = Math.max(0, limit - systemCount)
    items = [...systemFlows, ...regularFlows.slice(0, regularLimit)]
  }
  else {
    const regularOffset = offset - systemCount
    items = regularFlows.slice(regularOffset, regularOffset + limit)
  }

  const result = buildPaginatedListResult(items, page, limit, total)
  return { ...result, items }
})
