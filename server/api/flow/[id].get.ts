import { getDoc } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'

/**
 * 讀一個模組的完整內容（`C-230`／`C-231`／`C-232`）。
 *
 * **為什麼需要它**：客服預存／活動歡迎訊息／AI 腳本都可以選「送出某個機器人模組」，
 * 而那幾頁要畫出「客人會看到什麼」就得拿到那個模組**真正的訊息**。在這支之前只有兩種選擇：
 *   - `/api/flow/list`＝整份 133 KB（71 個模組的每一則訊息），為了看一則而下載全部
 *   - `/api/flow/list?fields=picker`＝只有名字與則數，畫不出內容
 *
 * ⛔ 權限維持 `viewer`：這是唯讀的，客服看得到模組清單就該看得到它的內容
 * （他本來就能在模組頁看到同樣的東西）。
 * ⛔ 別的工作區的模組一律回 404，**不是 403**——回 403 等於告訴對方「這個編號存在」。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id is required' })

  const flow = await getDoc<Record<string, unknown>>('flows', id)
  if (!flow || flow.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到此模組' })
  }

  // triggers 與清單端點一樣不回（前端沒有人用，而且它是另一套資料的殘留）
  const { triggers, trigger, ...rest } = flow
  return rest
})
