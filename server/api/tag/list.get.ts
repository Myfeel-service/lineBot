import { getDb, listDocs } from '~~/server/utils/firebase'
import { parseAdminListPagination, paginateArray } from '~~/server/utils/admin-pagination'
import { memberCountsForTagIds } from '~~/server/utils/tag-member-count'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import type { TagDoc } from '~~/shared/types/tag-broadcast'

type TagRow = TagDoc & { id: string; memberCount?: number }

function filterTags(
  tags: TagRow[],
  opts: {
    statusFilter?: string
    categoryFilter?: string
    aiModeFilter?: string
    searchRaw?: string
  },
): TagRow[] {
  let result = tags
  if (opts.statusFilter) result = result.filter((t) => t.status === opts.statusFilter)
  if (opts.categoryFilter) result = result.filter((t) => t.category === opts.categoryFilter)
  // 'off' 要把「沒有這個欄位」的舊標籤也算進去（缺欄＝off 是全系統口徑）
  if (opts.aiModeFilter) {
    result = opts.aiModeFilter === 'off'
      ? result.filter((t) => !t.aiMode || t.aiMode === 'off')
      : result.filter((t) => t.aiMode === opts.aiModeFilter)
  }
  if (opts.searchRaw) {
    result = result.filter(
      (t) =>
        t.name?.toLowerCase().includes(opts.searchRaw!)
        || t.code?.toLowerCase().includes(opts.searchRaw!),
    )
  }
  return result
}

/**
 * GET /api/tag/list
 * Query: ?status=active|inactive  (省略則回傳全部)
 * Query: ?category=interest|behavior|...
 * Query: ?search=關鍵字（名稱或 code，不分大小寫）
 * Query: ?includeMemberCount=1  (附加 memberCount；分頁時僅計算該頁標籤)
 * Query: ?page=1&limit=50  (分頁模式，回傳 { items, total, page, limit })
 *
 * 無 page/limit：Response: TagRow[]
 * 有 page/limit：Response: { items: TagRow[], total, page, limit }
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')

  const query = getQuery(event)
  const statusFilter = query.status as string | undefined
  const categoryFilter = query.category as string | undefined
  const aiModeFilter = query.aiMode as string | undefined
  const searchRaw = String(query.search || '').trim().toLowerCase()
  const includeMemberCount = query.includeMemberCount === '1' || query.includeMemberCount === 'true'
  const { page, limit, offset, paginate } = parseAdminListPagination(query)

  const tags = await listDocs<TagDoc>('tags', (ref) =>
    ref.where('workspaceId', '==', workspaceId).orderBy('createdAt', 'desc'),
  )

  const filtered = filterTags(tags, { statusFilter, categoryFilter, aiModeFilter, searchRaw })

  const attachMemberCounts = async (rows: TagRow[]) => {
    if (!includeMemberCount || !rows.length) return rows
    const db = getDb()
    const counts = await memberCountsForTagIds(db, workspaceId, rows.map((t) => t.id))
    return rows.map((tag) => ({
      ...tag,
      memberCount: counts[tag.id] ?? 0,
    }))
  }

  if (!paginate) {
    return attachMemberCounts(filtered)
  }

  const total = filtered.length
  const pageItems = paginateArray(filtered, offset, limit)
  const items = await attachMemberCounts(pageItems)

  return { items, total, page, limit }
})
