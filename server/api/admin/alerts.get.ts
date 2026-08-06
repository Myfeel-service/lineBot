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
  // ?force=1：使用者按「重新檢查」、或小幫手要確認「剛剛去修的好了沒」。
  // 這種情境要連外部查詢的快取一起跳過——人剛在 LINE 後台改完設定回頭問，
  // 給他五分鐘前那份答案等於騙他「還沒修好」。
  const force = String(getQuery(event).force ?? '') === '1'
  const items = await collectWorkspaceAlerts(getDb(), wid, {
    canSettings,
    canOperate: canSettings || role === 'agent',
    skipCache: force,
  })

  return { workspaceId: wid, items, checkedAt: Date.now() }
})
