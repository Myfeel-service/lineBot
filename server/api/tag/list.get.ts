import { getDb, listDocs } from '~~/server/utils/firebase'
import { parseAdminListPagination, paginateArray } from '~~/server/utils/admin-pagination'
import { memberCountsForTagIds } from '~~/server/utils/tag-member-count'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import type { TagDoc } from '~~/shared/types/tag-broadcast'
import { isAiJudgedTag, tagSegmentCounts } from '~~/shared/tag-admin'

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
    if (opts.aiModeFilter === 'off') result = result.filter((t) => !isAiJudgedTag(t))
    // 'ai'＝suggest+auto 合起來（計數膠囊的粗篩；細分仍可傳 suggest / auto）
    else if (opts.aiModeFilter === 'ai') result = result.filter((t) => isAiJudgedTag(t))
    else result = result.filter((t) => t.aiMode === opts.aiModeFilter)
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

  // ⛔ 計數要算在這一行**之後**：不分頁的呼叫端（好友頁載標籤選項）根本不看 segments，
  //    算在前面等於每次都白跑一輪全表過濾再丟掉。
  if (!paginate) {
    return attachMemberCounts(filtered)
  }

  /**
   * 計數膠囊的數字（`D-30`①）。⛔ **刻意不套 aiModeFilter**：
   * 分面篩選的通則是每一面的計數要排除它自己，否則點了「AI 判斷中」之後
   * 「手動／系統」會顯示 0，看起來像那些標籤消失了。
   * 這裡是記憶體運算，`tags` 上面已經撈過了，零額外讀取。
   * `suggest`／`auto` 給進了「AI 判斷中」之後才出現的那排細分用。
   */
  const segments = tagSegmentCounts(filterTags(tags, { statusFilter, categoryFilter, searchRaw }))

  const total = filtered.length
  const pageItems = paginateArray(filtered, offset, limit)
  const items = await attachMemberCounts(pageItems)

  return { items, total, page, limit, segments }
})
