/**
 * GET /api/campaigns/:id/stats
 *
 * 行銷向指標（不含連結產生次數、不含「尚未兌換」pending）。
 */
import { requireCapability } from '~~/server/utils/workspace-auth'

export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'workspace.read')
  const campaignId = getRouterParam(event, 'id')!
  const db = getDb()

  const campaignSnap = await db.collection('leadCampaigns').doc(campaignId).get()
  if (!campaignSnap.exists || campaignSnap.data()?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: 'Campaign not found' })
  }

  const snap = await db.collection('leadClaims')
    .where('campaignId', '==', campaignId)
    .get()

  let claimed = 0
  let applied = 0

  for (const doc of snap.docs) {
    const status = doc.data().status as string
    if (status === 'claimed') claimed++
    else if (status === 'applied') applied++
  }

  const touched = claimed + applied
  const tagCompletionRate = touched > 0 ? Math.round((applied / touched) * 100) : 0

  return {
    campaignId,
    /** 已加好友並完成貼標 */
    applied,
    /** 已在 LIFF 綁定 LINE、尚未加官方帳號為好友 */
    claimed,
    /** 在「已綁定」的人當中，完成加好友貼標的比例 */
    tagCompletionRate,
  }
})
