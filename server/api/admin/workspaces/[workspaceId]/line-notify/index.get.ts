import { requireCapability } from '~~/server/utils/workspace-auth'
import { buildLineNotifyPageData } from '~~/server/utils/line-notify-page'
import { can } from '~~/shared/permissions'

/**
 * GET /api/admin/workspaces/:workspaceId/line-notify
 * 「設定 → LINE 通知」頁（`C-270`）：誰會收到（每位成員一列＋送到了沒）、什麼時候通知。
 * 客服起跳（他要能把自己的手機加進來）；能不能動別人、改時間看 `canManage`。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid, role } = await requireCapability(event, 'notify.self')
  return buildLineNotifyPageData({ workspaceId, uid, canManage: can(role, 'notify.manage') })
})
