import type { WorkspaceAlertsResponse } from '~~/shared/types/alerts'
import { getDb } from '~~/server/utils/firebase'
import { collectWorkspaceAlerts } from '~~/server/utils/workspace-alerts'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'

/**
 * GET /api/admin/alerts?workspaceId=...
 *
 * 工作區「目前異常」彙總：把散在各頁、不進去就看不到的持續性異常收成一份訊號，
 * 給右下角小幫手主動告知。訊號口徑只有一份——probe 本體在
 * server/utils/workspace-alerts.ts（組織頁跨工作區彙總也用同一套），
 * 這裡只做單一工作區的角色判定。
 */
export default defineEventHandler(async (event): Promise<WorkspaceAlertsResponse> => {
  const { workspaceId, role } = await requireWorkspaceAccess(event, 'viewer')
  const wid = String(workspaceId || '').trim()
  if (!wid)
    throw createError({ statusCode: 400, statusMessage: 'workspaceId is required' })

  const canSettings = role === 'owner' || role === 'admin'
  const items = await collectWorkspaceAlerts(getDb(), wid, {
    canSettings,
    canOperate: canSettings || role === 'agent',
    requestOrigin: getRequestURL(event, { xForwardedHost: true, xForwardedProto: true }).origin,
  })

  return { workspaceId: wid, items, checkedAt: Date.now() }
})
