import { FieldValue } from 'firebase-admin/firestore'
import { requireSuperAdmin, invalidateOrgMemberCache } from '~~/server/utils/workspace-auth'
import { getFirebaseAuth } from '~~/server/utils/firebase'
import { writeAuditLog, diffChangedFields } from '~~/server/utils/audit-log'

function normEmail(e: string | undefined | null): string {
  return String(e ?? '').trim().toLowerCase()
}

/**
 * PATCH /api/admin/super/organizations/:id
 * 更新組織名稱或登記擁有者 Email。Body: { name?, ownerEmail? }
 *
 * ownerEmail：小寫正規化後寫入；若該 Email 已有 Firebase 帳號則一併寫入 ownerId，否則清除 ownerId。
 * 若新 Email 尚不在 orgMembers，會新增為組織管理員（與建立組織時相同）；既有 org 管理員列不會自動移除。
 */
export default defineEventHandler(async (event) => {
  const { uid: callerUid } = await requireSuperAdmin(event)

  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id is required' })

  const body = await readBody(event)
  const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() }

  if (body.name !== undefined) {
    if (!String(body.name).trim()) throw createError({ statusCode: 400, statusMessage: 'name cannot be empty' })
    updates.name = String(body.name).trim()
  }

  // 官方帳號數量上限（濫用防護）。空字串 / null → 特批不限（代理商、多品牌客戶）。
  if (body.maxWorkspaces !== undefined) {
    if (body.maxWorkspaces === null || body.maxWorkspaces === '') {
      updates.maxWorkspaces = null
    }
    else {
      const n = Number(body.maxWorkspaces)
      if (!Number.isFinite(n) || n < 1) {
        throw createError({ statusCode: 400, statusMessage: '官方帳號上限需為 1 以上的整數，或留空表示不限' })
      }
      updates.maxWorkspaces = Math.floor(n)
    }
  }

  const db = getDb()
  const auth = getFirebaseAuth()
  const ref = db.collection('organizations').doc(id)
  const snap = await ref.get()
  if (!snap.exists) throw createError({ statusCode: 404, statusMessage: '找不到此組織' })

  const prev = snap.data() as Record<string, unknown>

  if (body.ownerEmail !== undefined) {
    const newEmail = normEmail(body.ownerEmail)
    if (!newEmail)
      throw createError({ statusCode: 400, statusMessage: 'ownerEmail cannot be empty' })

    const prevEmailRaw = typeof prev.ownerEmail === 'string' ? normEmail(prev.ownerEmail) : ''
    let prevFromUid = ''
    if (prev.ownerId) {
      try {
        prevFromUid = normEmail((await auth.getUser(String(prev.ownerId))).email)
      } catch { /* */ }
    }
    const currentOwner = prevEmailRaw || prevFromUid

    if (newEmail !== currentOwner) {
      updates.ownerEmail = newEmail
      try {
        const user = await auth.getUserByEmail(newEmail)
        updates.ownerId = user.uid
      } catch {
        updates.ownerId = FieldValue.delete() as unknown as string
      }

      const existingOm = await db.collection('orgMembers')
        .where('orgId', '==', id)
        .where('email', '==', newEmail)
        .limit(1)
        .get()
      if (existingOm.empty) {
        await db.collection('orgMembers').add({
          orgId: id,
          email: newEmail,
          role: 'admin',
          invitedBy: callerUid,
          createdAt: FieldValue.serverTimestamp(),
        })
      }

      invalidateOrgMemberCache(newEmail, id)
      if (currentOwner)
        invalidateOrgMemberCache(currentOwner, id)
    }
  }

  await ref.update(updates as never)

  const after = await ref.get()
  const d = after.data() as Record<string, any>
  let ownerEmailOut = typeof d.ownerEmail === 'string' ? d.ownerEmail : ''
  if (!ownerEmailOut && d.ownerId) {
    try {
      ownerEmailOut = (await auth.getUser(String(d.ownerId))).email ?? ''
    } catch { /* */ }
  }

  // 稽核（`C-254`）：`ownerEmail` 是帳務歸屬對象、`maxWorkspaces` 是濫用防護的閘門
  const summarize = (x: Record<string, unknown>) => ({
    name: String(x.name ?? ''),
    email: normEmail(x.ownerEmail as string | undefined),
    itemsCount: x.maxWorkspaces === null ? -1 : Number(x.maxWorkspaces ?? 0),
  })
  const orgDiff = diffChangedFields(summarize(prev), summarize(d))
  if (orgDiff.changedKeys.length) {
    await writeAuditLog({
      workspaceId: '',
      orgId: id,
      scope: 'platform',
      uid: callerUid,
      actor: 'human',
      action: 'super.orgPatch',
      targetId: id,
      before: orgDiff.before,
      after: orgDiff.after,
      // ⚠️ 上限用 -1 代表「不限」（紀錄裡不能有 null 跟 0 分不出來的格子）
      ...(orgDiff.changedKeys.includes('itemsCount') ? { note: '官方帳號數量上限有變（-1 代表不限）' } : {}),
    }, db)
  }

  return {
    id,
    ...d,
    ownerEmail: ownerEmailOut,
  }
})
