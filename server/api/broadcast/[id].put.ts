import { FieldValue } from 'firebase-admin/firestore'
import { assertFutureBroadcastScheduleAt } from '~~/server/utils/broadcast-schedule'
import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { writeAuditLog, auditSnapshot, auditTimeText, diffChangedFields } from '~~/server/utils/audit-log'

/**
 * PUT /api/broadcast/:id
 * 更新草稿或排程中的推播（已開始發送後不可修改）
 *
 * Body（可選欄位）:
 * {
 *   name?: string
 *   audienceSource?: BroadcastAudienceSource
 *   messages?: any[]
 *   scheduleAt?: string | null   // null = 改回草稿
 * }
 *
 * Response: { id: string, ...updatedFields }
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'broadcast.write')

  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id is required' })

  const db = getDb()
  const ref = db.collection('broadcasts').doc(id)
  const snap = await ref.get()

  if (!snap.exists) {
    throw createError({ statusCode: 404, statusMessage: 'Broadcast not found' })
  }

  const current = snap.data()!
  if (current.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: 'Broadcast not found' })
  }
  const lockedStatuses = ['processing', 'completed', 'failed', 'cancelled']
  if (lockedStatuses.includes(current.status)) {
    throw createError({ statusCode: 409, statusMessage: `Cannot edit a broadcast with status: ${current.status}` })
  }

  const body = await readBody(event)
  const updates: Record<string, any> = { updatedAt: FieldValue.serverTimestamp() }

  if (body.name !== undefined) updates.name = body.name
  if (body.audienceSource !== undefined) updates.audienceSource = body.audienceSource
  if (body.messages !== undefined) updates.messages = body.messages
  // `C-213`：發完幫收到的人貼的標籤（選填）。⛔ 一律正規化成字串陣列，
  // 壞掉的值進了資料庫，發送當下才會在貼標那一步炸——而那時訊息已經送出去了。
  if (body.completionTagIds !== undefined) {
    updates.completionTagIds = Array.isArray(body.completionTagIds)
      ? body.completionTagIds.map((t: unknown) => String(t ?? '').trim()).filter(Boolean)
      : []
  }

  if (body.scheduleAt !== undefined) {
    if (body.scheduleAt === null) {
      updates.scheduleAt = null
      updates.status = 'draft'
    }
    else {
      updates.scheduleAt = assertFutureBroadcastScheduleAt(body.scheduleAt)
      updates.status = 'scheduled'
    }
  }

  await ref.update(updates)

  // 稽核（`C-254`）：只記摘要層的前後差異，沒有變就不寫（免得每次存檔都留一筆噪音）
  const summarize = (d: Record<string, unknown>) => ({
    ...auditSnapshot(d, { keep: ['name', 'status'], count: ['messages', 'completionTagIds'] }),
    audienceSource: (d.audienceSource as { type?: string } | null)?.type ?? null,
    scheduleAt: auditTimeText(d.scheduleAt),
  })
  const diff = diffChangedFields(summarize(current), summarize({ ...current, ...updates }))
  if (diff.changedKeys.length) {
    await writeAuditLog({
      workspaceId,
      uid,
      actor: 'human',
      action: 'broadcast.put',
      targetId: id,
      before: diff.before,
      after: diff.after,
      note: String(current.name ?? ''),
    }, db)
  }

  return { id, ...current, ...updates }
})
