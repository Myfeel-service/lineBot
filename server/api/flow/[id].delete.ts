import { getDoc } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { invalidateBrokenModuleRefsCache } from '~~/server/utils/broken-module-refs'

export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id is required' })

  const flow = await getDoc<{ isSystem?: boolean; workspaceId?: string }>('flows', id)
  if (!flow) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }
  if (flow.isSystem) {
    throw createError({ statusCode: 403, statusMessage: '系統模組不可刪除' })
  }
  if (flow.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }

  await deleteDoc('flows', id)

  // 讓「按鈕按下去沒反應」的異常檢查立刻反映這次變更（否則最多要等 5 分鐘快取過期）
  invalidateBrokenModuleRefsCache(workspaceId)

  return { success: true }
})
