import { requireCapability } from '~~/server/utils/workspace-auth'
import { removeTestRecipient } from '~~/server/utils/broadcast-test-recipients'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * DELETE /api/broadcast/test-recipients/:lineUserId
 * 從「常找來看稿的人」拿掉一位（`D-119` ⑥）。只是不再出現在試發框，⛔ 不會動到他這個好友本身。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'broadcast.testList')
  const lineUserId = String(getRouterParam(event, 'lineUserId') ?? '').trim()
  if (!lineUserId) throw createError({ statusCode: 400, statusMessage: 'lineUserId is required' })

  const removed = await removeTestRecipient(workspaceId, lineUserId)
  if (removed) {
    await writeAuditLog({
      workspaceId,
      uid,
      actor: 'human',
      action: 'broadcast.testRecipientRemove',
      targetId: lineUserId,
    })
  }
  return { ok: true, removed }
})
