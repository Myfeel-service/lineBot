import { requireCapability } from '~~/server/utils/workspace-auth'
import { writeAuditLog } from '~~/server/utils/audit-log'

export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'marketing.write')
  const id = getRouterParam(event, 'id')!
  const db = getDb()
  const snap = await db.collection('leadCampaigns').doc(id).get()
  if (!snap.exists || snap.data()?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: 'Campaign not found' })
  }
  await db.collection('leadCampaigns').doc(id).delete()

  // 稽核（`C-254`）。⚠️ 已經發出去的活動連結會從此失效——客人點進去撲空時，
  // 這一筆就是唯一查得到「什麼時候被誰刪掉」的地方
  const before = snap.data()!
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'campaign.delete',
    targetId: id,
    before: { name: String(before.name ?? ''), isActive: before.isActive !== false },
    note: `${String(before.name ?? '')}（活動代碼 ${String(before.campaignCode ?? '')}，已發出的連結會失效）`,
  }, db)

  return { success: true, id }
})
