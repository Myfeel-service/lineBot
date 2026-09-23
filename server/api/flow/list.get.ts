import { countTaggedUriButtons } from '~~/shared/flow-uri-tagging'
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
  /**
   * `D-86`：下拉要標出「這個模組還沒有內容」（選了它＝客人按下去什麼都收不到，
   * 正是空「歡迎模組」那場災情的形狀）。判斷只需要**幾則**，不需要內容。
   *
   * ⛔ **但一定要在回傳前把 `messages` 拿掉**（下面 `toPickerRow`），否則 133 KB 又回到前端，
   *    這個模式就白做了——`list.get.test.ts` 有一條專門釘這件事。
   * ⚠️ 為什麼不存一個 `messageCount` 欄位就好：那要對正式庫 71 份既有文件做一次回填，
   *    而 `select()` 省的是**傳輸量不是讀取筆數**（Firestore 照樣一份算一次），
   *    所以多投影這個欄位在帳單上是零差別，只是伺服器端多收一點位元組。
   */
  'messages',
] as const

/**
 * picker 模式回給前端的形狀：把 `messages` 換成兩個數字。
 * - `messageCount`：有沒有內容（`D-86`，空模組＝客人走到這裡什麼都收不到）
 * - `taggedUriButtons`：有幾顆「開了貼標的網址按鈕」（`C-238`，推播送出時那個貼標不會生效）
 */
function toPickerRow(flow: Record<string, unknown>) {
  const { messages, ...rest } = flow
  return {
    ...rest,
    messageCount: Array.isArray(messages) ? messages.length : 0,
    taggedUriButtons: countTaggedUriButtons(messages),
  }
}

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
  const legacyWelcome = allFlows.find(f => f.id === legacyWelcomeId)
  if (legacyWelcome) {
    /**
     * ⚠️ **這裡以前要為 picker 模式多讀一次那份文件**，因為 picker 沒投影 `messages`，
     *    只好「拿不到就保守顯示」——而那等於五個下拉全都還看得到它（2026-09-22 老闆截圖回報）。
     *    `D-86` 起 picker 也投影 `messages`（為了標「還沒有內容」），
     *    兩個模式都直接判斷得出來，那次額外的 `doc().get()` 就不需要了。
     * ⛔ 判斷維持「**真的是空的才藏**」：有人編過內容的照舊顯示，
     *    藏起來就是讓他的東西無聲消失。
     */
    if (Array.isArray(legacyWelcome.messages) && legacyWelcome.messages.length === 0) {
      allFlows = allFlows.filter(f => f.id !== legacyWelcomeId)
    }
  }

  // picker 模式：剝掉 triggers 之外還要把 messages 換成一個數字（⛔ 不可以連內容一起回去）
  const shape = pickerOnly
    ? (f: Record<string, unknown>) => toPickerRow(stripFlowTriggers(f))
    : stripFlowTriggers

  const systemFlows = allFlows
    .filter(f => f.isSystem)
    .sort((a, b) => {
      const ai = SYSTEM_MODULE_ORDER.indexOf(a.moduleType as typeof SYSTEM_MODULE_ORDER[number])
      const bi = SYSTEM_MODULE_ORDER.indexOf(b.moduleType as typeof SYSTEM_MODULE_ORDER[number])
      return (ai === -1 ? Number.MAX_SAFE_INTEGER : ai)
        - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi)
    })
    .map(shape)

  const regularFlows = sortRegularFlows(allFlows.filter(f => !f.isSystem)).map(shape)

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
