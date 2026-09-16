import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { invalidateBrokenModuleRefsCache } from '~~/server/utils/broken-module-refs'

export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id is required' })

  const menu = await getDoc<{ richMenuId: string; aliasId?: string; workspaceId?: string }>('richmenus', id)
  if (!menu || menu.workspaceId !== workspaceId) throw createError({ statusCode: 404, statusMessage: 'Not found' })

  // 先刪除圖文選單別名（釋出 alias ID）
  if (menu.aliasId) {
    try {
      await deleteRichMenuAlias(menu.aliasId, workspaceId)
    } catch (e) {
      console.warn('[richmenu/delete] Failed to delete alias:', e)
    }
  }

  // 從 LINE 刪除圖文選單。
  // ⚠️ 失敗照樣往下走（我們這邊的紀錄要清掉，否則畫面會一直留著一筆點不開的），
  // ⛔ 但**不可以回報成「刪好了」**——呼叫端會照著那句話跟店家說「已經收回去了」，
  //    而 LINE 上其實還留著一張。這裡如實回傳，讓呼叫端自己決定怎麼講。
  let lineDeleted = true
  try {
    await deleteLineRichMenu(menu.richMenuId, workspaceId)
  } catch (e) {
    lineDeleted = false
    console.warn('[richmenu/delete] LINE delete failed:', e)
  }

  await deleteDoc('richmenus', id)

  // 讓「按鈕按下去沒反應」的異常檢查立刻反映這次變更（否則最多要等 5 分鐘快取過期）
  invalidateBrokenModuleRefsCache(workspaceId)

  return { success: true, lineDeleted }
})
