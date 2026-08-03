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

  // 從 LINE 刪除圖文選單
  try {
    await deleteLineRichMenu(menu.richMenuId, workspaceId)
  } catch (e) {
    console.warn('[richmenu/delete] LINE delete failed:', e)
  }

  await deleteDoc('richmenus', id)

  // 讓「按鈕按下去沒反應」的異常檢查立刻反映這次變更（否則最多要等 5 分鐘快取過期）
  invalidateBrokenModuleRefsCache(workspaceId)

  return { success: true }
})
