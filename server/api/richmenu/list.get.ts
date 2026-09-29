import { listDocs } from '~~/server/utils/firebase'
import { paginateInMemoryList } from '~~/server/utils/paginated-collection-list'
import { requireCapability } from '~~/server/utils/workspace-auth'

function sortRichMenus<T extends { isDefault?: boolean }>(menus: T[]): T[] {
  return [...menus].sort((a, b) => {
    if (a.isDefault && !b.isDefault) return -1
    if (!a.isDefault && b.isDefault) return 1
    return 0
  })
}

/**
 * GET /api/richmenu/list
 * Query: page, limit（有帶則回傳 { items, total, page, limit, hasMore }）
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'workspace.read')
  const query = getQuery(event)

  const menus = await listDocs<Record<string, unknown> & { isDefault?: boolean }>('richmenus', ref =>
    ref.where('workspaceId', '==', workspaceId).orderBy('createdAt', 'desc'),
  )

  return paginateInMemoryList(sortRichMenus(menus), query)
})
