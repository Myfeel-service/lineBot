import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { clampSince, findNewFollower } from '~~/server/utils/onboarding-phone-test'

/**
 * GET /api/admin/onboarding/new-follower?since=<epoch ms>&exclude=<U…,U…>
 *
 * 開帳「用手機測試」那一步輪詢用（`C-250`③）：這段時間內**新加好友**、或早就是好友而**剛傳訊息**的最新一位——
 * 回名稱與頭像，讓他在電腦上認「是你嗎？」。唯讀。
 * ⛔ 管理員才看得到：回的是某位 LINE 使用者的名字與頭像，而且下一步就是把他綁成通知對象。
 * ⛔ 最多往回看一小時（`clampSince`）：放寬就等於任何舊好友都能被認成管理員。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'admin')
  const q = getQuery(event)
  const since = clampSince(q.since)
  const exclude = new Set(String(q.exclude ?? '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 20))
  const hit = await findNewFollower(workspaceId, since, exclude, getDb())
  return hit ? { found: true as const, ...hit } : { found: false as const }
})
