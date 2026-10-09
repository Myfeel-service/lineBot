import { requireCapability } from '~~/server/utils/workspace-auth'
import { addTestRecipient, TEST_RECIPIENTS_MAX } from '~~/server/utils/broadcast-test-recipients'
import { writeAuditLog } from '~~/server/utils/audit-log'

const LINE_USER_ID_RE = /^U[0-9a-f]{32}$/i

/**
 * POST /api/broadcast/test-recipients  body: { lineUserId }
 * 把一位好友加進「常找來看稿的人」（`D-119` ⑥）。之後試發框直接打勾，不用每次在全部好友裡搜名字。
 *
 * 門檻 `broadcast.testList`（管理員）：加人那一下還是要在全部好友裡找名字（同名的 Alice 有 5 位），
 * 交給少數人做一次，其他人之後只要打勾。
 * 稽核：這份名單決定試發會送到誰的手機，加了誰要查得到。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'broadcast.testList')
  const body = await readBody<{ lineUserId?: unknown }>(event)
  const lineUserId = String(body?.lineUserId ?? '').trim()
  if (!LINE_USER_ID_RE.test(lineUserId)) throw createError({ statusCode: 400, statusMessage: '這不是一個 LINE 帳號' })

  const { result, displayName } = await addTestRecipient(workspaceId, lineUserId)
  if (result === 'not-friend') {
    throw createError({ statusCode: 404, statusMessage: '這位不是這個官方帳號的好友（LINE 只讓我們發訊息給已加好友的人）。' })
  }
  if (result === 'full') {
    throw createError({ statusCode: 409, statusMessage: `常找來看稿的人最多 ${TEST_RECIPIENTS_MAX} 位，請先拿掉一位。` })
  }
  if (result === 'added') {
    await writeAuditLog({
      workspaceId,
      uid,
      actor: 'human',
      action: 'broadcast.testRecipientAdd',
      targetId: lineUserId,
      after: { displayName },
    })
  }
  return { ok: true, result, displayName }
})
