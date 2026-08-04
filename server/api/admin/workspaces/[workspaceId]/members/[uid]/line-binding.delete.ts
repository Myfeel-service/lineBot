import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { unbindMemberLine } from '~~/server/utils/member-line-bind'

/**
 * DELETE /api/admin/workspaces/:workspaceId/members/:uid/line-binding
 * 解除成員的 LINE 綁定，並把該 LINE 帳號從轉真人通知名單移除。需 admin 以上角色。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'admin')

  const uid = event.context.params?.uid
  if (!uid) throw createError({ statusCode: 400, statusMessage: 'uid is required' })

  await unbindMemberLine(workspaceId, uid)
  return { ok: true }
})
