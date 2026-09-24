import { FieldValue } from 'firebase-admin/firestore'
import { requireSuperAdmin, invalidateOrgStatusCache } from '~~/server/utils/workspace-auth'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * POST /api/admin/super/organizations/:id/disable
 * 切換組織停用狀態。Body: { disabled: boolean }
 */
export default defineEventHandler(async (event) => {
  const { uid } = await requireSuperAdmin(event)

  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id is required' })

  const body = await readBody(event)
  const disabled = Boolean(body.disabled)

  const db = getDb()
  const ref = db.collection('organizations').doc(id)
  const snap = await ref.get()
  if (!snap.exists) throw createError({ statusCode: 404, statusMessage: '找不到此組織' })

  await ref.update({ disabled, updatedAt: FieldValue.serverTimestamp() })
  invalidateOrgStatusCache(id)

  // 稽核（`C-254`）：停用＝整個組織底下的人**全部登不進後台**，是影響最大的一顆開關
  await writeAuditLog({
    workspaceId: '',
    orgId: id,
    scope: 'platform',
    uid,
    actor: 'human',
    action: 'super.orgDisable',
    targetId: id,
    before: { disabled: snap.data()?.disabled === true },
    after: { disabled },
    note: disabled
      ? `停用了組織「${String(snap.data()?.name ?? id)}」，底下的人都登不進後台了`
      : `把組織「${String(snap.data()?.name ?? id)}」重新啟用`,
  }, db)

  return { id, disabled }
})
