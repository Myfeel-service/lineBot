import { requireCapability } from '~~/server/utils/workspace-auth'
import { unbindMemberLine } from '~~/server/utils/member-line-bind'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * DELETE /api/admin/workspaces/:workspaceId/members/:uid/line-binding
 * 解除成員的 LINE 綁定，並把該 LINE 帳號從轉真人通知名單移除。需 admin 以上角色。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid: callerUid } = await requireCapability(event, 'notify.manage')

  const uid = event.context.params?.uid
  if (!uid) throw createError({ statusCode: 400, statusMessage: 'uid is required' })

  await unbindMemberLine(workspaceId, uid)

  // 稽核（`C-254`）：解綁之後這個人的 LINE 就不會再收到「客人在等」的通知——
  // 這正是「為什麼都沒人通知我」最常見的原因之一
  await writeAuditLog({
    workspaceId,
    uid: callerUid,
    actor: 'human',
    action: 'member.lineUnbind',
    targetId: uid,
    note: '這位成員的 LINE 之後不會再收到轉真人通知',
  })

  return { ok: true }
})
