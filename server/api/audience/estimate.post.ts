import { resolveAudienceUserIds } from '~~/server/utils/audience'
import type { AudienceFilter } from '~~/shared/types/tag-broadcast'
import { requireCapability } from '~~/server/utils/workspace-auth'

/**
 * POST /api/audience/estimate
 * 根據 filter 條件預估受眾人數（不儲存）
 * 給推播建立頁即時顯示「預估發送人數」用
 *
 * Body:
 * {
 *   filter: AudienceFilter
 * }
 *
 * Response:
 * {
 *   estimatedCount: number
 *   previewUserIds: string[]   // 前 5 筆
 * }
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'workspace.read')
  const body = await readBody(event)
  const filter: AudienceFilter = body?.filter

  if (!filter) {
    throw createError({ statusCode: 400, statusMessage: 'filter is required' })
  }

  const userIds = await resolveAudienceUserIds(filter, workspaceId)

  return {
    estimatedCount: userIds.length,
    previewUserIds: userIds.slice(0, 5),
  }
})
