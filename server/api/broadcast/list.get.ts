import { listDocs } from '~~/server/utils/firebase'
import { paginateInMemoryList } from '~~/server/utils/paginated-collection-list'
import { requireCapability } from '~~/server/utils/workspace-auth'
import type { BroadcastDoc } from '~~/shared/types/tag-broadcast'

/**
 * GET /api/broadcast/list
 * Query: ?status=draft|scheduled|completed|...
 * Query: page, limit（有帶則回傳 { items, total, page, limit, hasMore }）
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'workspace.read')

  const query = getQuery(event)
  const statusFilter = query.status as string | undefined

  const broadcasts = await listDocs<BroadcastDoc>('broadcasts', ref =>
    ref.where('workspaceId', '==', workspaceId).orderBy('createdAt', 'desc'),
  )

  const filtered = statusFilter
    ? broadcasts.filter(b => b.status === statusFilter)
    : broadcasts

  /**
   * ⛔ `sentContent`（`C-246` 存的「當時真的送出去的那幾則」）**不跟著清單回**：
   * 它含圖文訊息的整份設定，一則好幾 KB，而清單一次回幾十則、背景還會定時刷新。
   * 要看那一份的只有「點開某一則」那個當下，去 `GET /api/broadcast/:id` 拿就好
   * （同 `messages` 當初被拿掉的理由，見 `docs/ADMIN-PERF-AUDIT-20260827.md`）。
   */
  const rows = filtered.map(({ audienceSnapshot, messages, sentContent, ...rest }) => ({
    ...rest,
    audienceSnapshot: {
      estimatedCount: audienceSnapshot?.estimatedCount ?? 0,
      filter: audienceSnapshot?.filter ?? null,
    },
    messageCount: Array.isArray(messages) ? messages.length : 0,
  }))

  return paginateInMemoryList(rows, query)
})
