import { requireCapability } from '~~/server/utils/workspace-auth'
import { getDb } from '~~/server/utils/firebase'
import { can } from '~~/shared/permissions'
import { AUDIT_LOGS_COLLECTION } from '~~/server/utils/audit-log'
import { applyRevert, planRevert, type AuditRecordForRevert } from '~~/server/utils/audit-revert'

/**
 * POST /api/admin/audit-logs/revert —— 把某一筆改動改回去（`C-31` Phase 2 收尾）。
 *
 * ⛔ 門檻用**那個動作原本的門檻**，不是「看得到紀錄就能還原」：
 *    能看紀錄的是 admin，但還原流程上下架這種事，要求的是改流程的權限。
 * ⛔ 還原本身也是一次操作，會再寫一筆稽核；原本那一筆不刪不改。
 */
export default defineEventHandler(async (event) => {
  // 先確認他至少看得到紀錄（audit.read＝admin），再依動作本身的門檻二次把關
  const { workspaceId, uid, role } = await requireCapability(event, 'audit.read')
  const body = await readBody(event)
  const id = String(body?.id ?? '').trim().slice(0, 200)
  if (!id) throw createError({ statusCode: 400, statusMessage: '要指定還原哪一筆紀錄' })

  const db = getDb()
  const snap = await db.collection(AUDIT_LOGS_COLLECTION).doc(id).get()
  if (!snap.exists) throw createError({ statusCode: 404, statusMessage: '找不到這筆紀錄' })

  const data = snap.data() as Record<string, unknown>
  // 跨租戶防線：紀錄必須屬於這個工作區
  if (data.workspaceId !== workspaceId)
    throw createError({ statusCode: 403, statusMessage: '這筆紀錄不屬於這個官方帳號' })

  const row: AuditRecordForRevert = {
    id,
    action: String(data.action ?? ''),
    before: (data.before ?? null) as Record<string, unknown> | null,
    after: (data.after ?? null) as Record<string, unknown> | null,
    ...(data.targetId ? { targetId: String(data.targetId) } : {}),
    lossy: data.lossy === true,
  }

  const plan = planRevert(row)
  if (!plan.ok) throw createError({ statusCode: 400, statusMessage: plan.reason })
  if (!can(role, plan.capability))
    throw createError({ statusCode: 403, statusMessage: '這個帳號的權限不能還原這種操作。' })

  const message = await applyRevert(row, { db, workspaceId, uid })
  return { ok: true, message }
})
