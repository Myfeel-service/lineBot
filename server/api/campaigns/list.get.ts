import { getDb } from '~~/server/utils/firebase'
import { queryCollectionPage } from '~~/server/utils/paginated-collection-list'
import { requireCapability } from '~~/server/utils/workspace-auth'

/**
 * GET /api/campaigns/list
 * Query: page, limit（有帶則回傳 { items, total, page, limit, hasMore }）
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'workspace.read')
  const query = getQuery(event)
  const db = getDb()

  return queryCollectionPage(
    db,
    ref => ref
      .where('workspaceId', '==', workspaceId)
      .orderBy('createdAt', 'desc'),
    'leadCampaigns',
    query,
    (id, data) => ({ id, ...data }),
  )
})
