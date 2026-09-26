import { requireCapability } from '~~/server/utils/workspace-auth'
import { buildLineNotifySelfStatus } from '~~/server/utils/line-notify-page'

/**
 * GET /api/admin/workspaces/:workspaceId/line-notify/self-status
 * 我自己綁好了沒、在不在收（`C-270`）。首頁那張卡、掃 QR 之後每幾秒問一次都用這支
 * （只讀自己的成員文件與設定，2 次讀取；⛔ 不要拿整頁那支來輪詢）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'notify.self')
  return buildLineNotifySelfStatus(workspaceId, uid)
})
