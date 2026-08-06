import type { WorkspaceAlertItem } from '~~/shared/types/alerts'
import { getDb } from '~~/server/utils/firebase'
import { collectWorkspaceAlerts } from '~~/server/utils/workspace-alerts'
import { requireActiveOrgAdmin } from '~~/server/utils/workspace-auth'

/**
 * GET /api/admin/org/:orgId/alerts — 組織層「目前異常」跨工作區彙總。
 *
 * 給組織總覽的帳號卡用：overview 端點只知道方案／額度／接沒接 LINE，
 * 這支補上異常中心同一套訊號（webhook 壞了、知識庫失敗、客人等真人…）。
 * probe 與單一工作區的小幫手完全同一份（server/utils/workspace-alerts.ts），
 * 嚴重度與文案也沿用前端同一份註冊表——組織頁和小幫手講的必須是同一件事。
 *
 * 權限：組織管理員（requireActiveOrgAdmin）。組織管理員管的是帳務與帳號健康，
 * 訊號等級視同 settings＋operate 全開——與 billing.get.ts 能看各帳號帳單同一個先例。
 */
export default defineEventHandler(async (event) => {
  const orgId = event.context.params?.orgId
  if (!orgId) throw createError({ statusCode: 400, statusMessage: 'orgId is required' })
  await requireActiveOrgAdmin(event, orgId)

  const db = getDb()
  const wsSnap = await db.collection('workspaces')
    .where('organizationId', '==', orgId)
    .select()
    .get()
  const requestOrigin = getRequestURL(event, { xForwardedHost: true, xForwardedProto: true }).origin

  // 一個工作區一套 probe（~14 個查詢）。分批跑，避免大組織一口氣對
  // Firestore／LINE API 開出幾百個並發（健康工作區的單套成本趨近於零，分批只影響尾延遲）
  const CHUNK = 5
  const workspaces: Array<{ workspaceId: string; items: WorkspaceAlertItem[] }> = []
  for (let i = 0; i < wsSnap.docs.length; i += CHUNK) {
    workspaces.push(...await Promise.all(wsSnap.docs.slice(i, i + CHUNK).map(async doc => ({
      workspaceId: doc.id,
      items: await collectWorkspaceAlerts(db, doc.id, { canSettings: true, canOperate: true, requestOrigin }),
    }))))
  }

  return { orgId, workspaces, checkedAt: Date.now() }
})
