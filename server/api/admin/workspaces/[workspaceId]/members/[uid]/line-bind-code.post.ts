import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { issueMemberLineBindCode } from '~~/server/utils/member-line-bind'

/**
 * POST /api/admin/workspaces/:workspaceId/members/:uid/line-bind-code
 * 產生一次性綁定碼，讓該成員用自己的 LINE 傳給官方帳號完成綁定。需 admin 以上角色。
 *
 * Response: { code, expiresAt, message }
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'admin')

  const uid = event.context.params?.uid
  if (!uid) throw createError({ statusCode: 400, statusMessage: 'uid is required' })

  return await issueMemberLineBindCode(workspaceId, uid)
})
