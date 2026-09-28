import { requireCapability } from '~~/server/utils/workspace-auth'
import { removeFromHandoffNotify, setMemberNotifyReceiving } from '~~/server/utils/member-line-bind'
import { writeAuditLog } from '~~/server/utils/audit-log'
import { can } from '~~/shared/permissions'

/**
 * PUT /api/admin/workspaces/:workspaceId/line-notify/receiving
 * body: { uid, on } —— 那一列的「收通知」開關（`C-270`）
 *       { lineUserId, on: false } —— 拿掉名單上對不上成員的舊帳號（管理員）
 *
 * 第 3 題拍板：客服可以開關**自己**那一列；動別人要管理員（notify.manage）。
 * 關掉＝從名單拿掉、LINE 還綁著，之後打開不用再掃一次。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid: callerUid, role } = await requireCapability(event, 'notify.self')
  const body = await readBody<{ uid?: unknown, lineUserId?: unknown, on?: unknown }>(event)
  const on = body?.on === true
  const canManage = can(role, 'notify.manage')

  // 舊資料：名單上有、卻不是任何一位成員的 LINE 帳號（`D-103` 第 2 題：名單只收綁好的成員）
  const legacyId = String(body?.lineUserId ?? '').trim()
  if (legacyId) {
    if (!canManage) throw createError({ statusCode: 403, statusMessage: '要管理員才能動別人的通知' })
    if (on) throw createError({ statusCode: 400, statusMessage: '名單只收綁好 LINE 的成員，這個帳號只能拿掉' })
    const removed = await removeFromHandoffNotify(workspaceId, legacyId)
    // ⛔ 失敗要照實講（`C-271`⑥）：這個帳號很可能是客人，還在名單上就會繼續收到別的客人的名字與原話
    if (removed === 'failed') throw createError({ statusCode: 500, statusMessage: '拿不掉，請再試一次' })
    if (removed === 'absent') return { ok: true, result: 'absent' }
    await writeAuditLog({
      workspaceId,
      uid: callerUid,
      actor: 'human',
      action: 'lineNotify.receiving',
      targetId: legacyId,
      before: { receiving: true },
      after: { receiving: false },
      note: '拿掉了名單上一個不是成員的 LINE 帳號',
    })
    return { ok: true, result: 'removed' }
  }

  const target = String(body?.uid ?? '').trim()
  if (!target) throw createError({ statusCode: 400, statusMessage: 'uid is required' })
  if (target !== callerUid && !canManage)
    throw createError({ statusCode: 403, statusMessage: '只能開關自己的通知；要改別人的請找管理員' })

  const r = await setMemberNotifyReceiving(workspaceId, target, on)
  if (!r.ok) {
    throw createError({
      statusCode: 400,
      statusMessage: r.reason === 'not-bound'
        ? '這位還沒綁 LINE，要先把手機加進來'
        : r.reason === 'viewer'
          ? '觀察者不收 LINE 通知；要收的話先到「成員管理」把角色改成客服'
          : '找不到這位成員',
    })
  }
  if (r.result === 'full')
    throw createError({ statusCode: 409, statusMessage: '名單滿了（最多 10 位），先關掉一位再開' })
  if (r.result === 'failed')
    throw createError({ statusCode: 500, statusMessage: '存不進去，請再試一次' })
  // 本來就在收／本來就不在名單上＝什麼都沒變，⛔ 不寫一筆假變更（`C-271`⑬：兩個分頁各按一次會多記一筆）
  if (r.result === 'already' || r.result === 'absent') return { ok: true, result: r.result }

  await writeAuditLog({
    workspaceId,
    uid: callerUid,
    actor: 'human',
    action: 'lineNotify.receiving',
    targetId: target,
    before: { receiving: !on },
    after: { receiving: on },
    ...(target === callerUid ? { note: on ? '打開了自己的 LINE 通知' : '關掉了自己的 LINE 通知' } : {}),
  })
  return { ok: true, result: r.result }
})
