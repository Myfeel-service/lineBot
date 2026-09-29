import { requireCapability } from '~~/server/utils/workspace-auth'
import { issueMemberLineBindCode } from '~~/server/utils/member-line-bind'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * POST /api/admin/workspaces/:workspaceId/members/:uid/line-bind-code
 * 產生一次性綁定碼，讓該成員用自己的 LINE 傳給官方帳號完成綁定。需 admin 以上角色。
 *
 * Response: { code, expiresAt, message }
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid: callerUid } = await requireCapability(event, 'notify.manage')

  const uid = event.context.params?.uid
  if (!uid) throw createError({ statusCode: 400, statusMessage: 'uid is required' })

  const result = await issueMemberLineBindCode(workspaceId, uid)

  /*
   * 稽核（`C-254`）：這組碼在有效期內，**誰拿到就能把自己的 LINE 綁成這位成員**
   * （之後客人的轉真人通知就會推到那支手機）。所以「什麼時候、由誰發了一組碼」要留紀錄。
   * ⛔ 碼本身絕對不寫進紀錄——稽核不能變成第二個外洩面（`sanitizeAuditValue` 的同一條紀律）。
   */
  await writeAuditLog({
    workspaceId,
    uid: callerUid,
    actor: 'human',
    action: 'member.lineBindCode',
    targetId: uid,
    note: '產生了一組一次性的 LINE 綁定碼（碼本身不留在紀錄裡）',
  })

  return result
})
