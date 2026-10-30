import { FieldValue } from 'firebase-admin/firestore'
import { assertFutureBroadcastScheduleAt } from '~~/server/utils/broadcast-schedule'
import { assertBroadcastPlanAllows } from '~~/server/utils/broadcast-plan-gate'
import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { writeAuditLog, auditTimeText } from '~~/server/utils/audit-log'

/**
 * POST /api/broadcast/:id/schedule
 * 確認排程（不發送）。僅允許 draft / scheduled 狀態。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'broadcast.send')

  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id is required' })

  const db = getDb()
  const ref = db.collection('broadcasts').doc(id)
  const snap = await ref.get()

  if (!snap.exists) throw createError({ statusCode: 404, statusMessage: 'Broadcast not found' })

  const current = snap.data()!
  if (current.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: 'Broadcast not found' })
  }

  const lockedStatuses = ['processing', 'completed', 'failed', 'cancelled']
  if (lockedStatuses.includes(current.status)) {
    throw createError({ statusCode: 409, statusMessage: `Cannot schedule broadcast with status: ${current.status}` })
  }

  const body = await readBody(event)
  if (!body?.scheduleAt) {
    throw createError({ statusCode: 400, statusMessage: 'scheduleAt is required' })
  }

  const scheduleAt = assertFutureBroadcastScheduleAt(body.scheduleAt)

  /**
   * 方案不含這種推播就不讓排（`D-131`）：以前排得進去，**到了排定時間**才在送出端失敗——
   * 那時人多半不在電腦前，隔天只看得到「失敗」。看的是排好之後真的會送的那一份對象（這次帶來的優先）。
   */
  const audienceSource = (body.audienceSource ?? current.audienceSource) as { type?: string } | undefined
  await assertBroadcastPlanAllows(workspaceId, audienceSource?.type, db)

  const updates: Record<string, unknown> = {
    status: 'scheduled',
    scheduleAt,
    // `D-167`②：草稿記著的那個時間到這裡就用完了，排上的時間只看 `scheduleAt`
    plannedScheduleAt: null,
    updatedAt: FieldValue.serverTimestamp(),
  }

  if (body.name !== undefined) updates.name = body.name
  if (body.audienceSource !== undefined) updates.audienceSource = body.audienceSource
  if (body.messages !== undefined) updates.messages = body.messages

  await ref.update(updates)

  // 稽核（`C-254`）：排程＝「到那個時間就自動送出去」，跟按下送出一樣收不回來
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'broadcast.schedule',
    targetId: id,
    before: { status: String(current.status ?? ''), scheduleAt: auditTimeText(current.scheduleAt) },
    after: { status: 'scheduled', scheduleAt: auditTimeText(scheduleAt) },
    note: String(updates.name ?? current.name ?? ''),
  }, db)

  return {
    success: true,
    id,
    status: 'scheduled',
    scheduleAt: scheduleAt.toISOString(),
  }
})
