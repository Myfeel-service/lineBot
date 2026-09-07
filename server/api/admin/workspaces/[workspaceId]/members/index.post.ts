import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import { requireWorkspaceAccess, invalidateWorkspaceMemberCache } from '~~/server/utils/workspace-auth'
import { getFirebaseAuth } from '~~/server/utils/firebase'
import { getWorkspacePlan } from '~~/server/utils/billing'
import { planLimitMessage } from '~~/shared/billing/plans'
import type { WorkspaceMemberRole } from '~~/shared/types/organization'

const VALID_ROLES: WorkspaceMemberRole[] = ['admin', 'agent', 'viewer']

function normalizeEmail(raw: string): string {
  return String(raw ?? '').trim().toLowerCase()
}

async function deleteWorkspaceInvitesForEmail(db: Firestore, workspaceId: string, email: string) {
  const snap = await db.collection('workspaceInvites')
    .where('workspaceId', '==', workspaceId)
    .where('email', '==', email)
    .get()
  if (snap.empty) return
  const batch = db.batch()
  snap.docs.forEach(d => batch.delete(d.ref))
  await batch.commit()
}

/**
 * POST /api/admin/workspaces/:workspaceId/members
 * 邀請成員。需 admin 以上角色。
 * - 若對方已有 Firebase 帳號：直接建立 workspaceMembers
 * - 若尚無帳號：寫入 workspaceInvites（email），與組織管理員邀請相同模式，註冊後首次進入後台即轉成成員
 *
 * Body: { email: string, role: 'admin' | 'agent' | 'viewer' }
 */
export default defineEventHandler(async (event) => {
  const { uid: inviterUid, workspaceId, isSuperAdmin } = await requireWorkspaceAccess(event, 'admin')

  const body = await readBody(event)
  const { email, role } = body

  if (!email?.trim()) throw createError({ statusCode: 400, statusMessage: 'email is required' })
  if (!VALID_ROLES.includes(role)) {
    throw createError({ statusCode: 400, statusMessage: `role must be one of: ${VALID_ROLES.join(', ')}` })
  }

  const emailNorm = normalizeEmail(email)
  const db = getDb()

  const pendingSnap = await db.collection('workspaceInvites')
    .where('workspaceId', '==', workspaceId)
    .where('email', '==', emailNorm)
    .limit(1)
    .get()
  if (!pendingSnap.empty) {
    throw createError({ statusCode: 409, statusMessage: '此 Email 已有待處理的邀請' })
  }

  /**
   * 席次上限（`D-69` 拍板④）。2026-09-07 之前 `plan.seats` 只印在方案表上、後端零攔截。
   *
   * 口徑：**已加入的成員（含 owner）＋ 還沒被接受的邀請**。邀請要算進去，否則一次送出
   * 二十封邀請就整批繞過上限；而且畫面上本來就把待處理邀請跟成員列在同一份清單裡
   * （members/index.get.ts），數法跟客人看到的一致才不會吵架。
   *
   * ⚠️ 已接受的邀請不會重複計算：materializeWorkspaceInviteIfAny 是刪一筆邀請、
   * 建一筆成員，淨額 0。super admin 豁免（比照 org/workspaces 建立上限的既有慣例）。
   */
  if (!isSuperAdmin) {
    const plan = await getWorkspacePlan(workspaceId, db)
    if (plan?.seats != null) {
      const [memberAgg, inviteAgg] = await Promise.all([
        db.collection('workspaceMembers').where('workspaceId', '==', workspaceId).count().get(),
        db.collection('workspaceInvites').where('workspaceId', '==', workspaceId).count().get(),
      ])
      const used = memberAgg.data().count + inviteAgg.data().count
      if (used >= plan.seats) {
        throw createError({
          statusCode: 403,
          statusMessage: planLimitMessage('團隊成員數', used, plan.seats, plan.name),
        })
      }
    }
  }

  const workspaceSnap = await db.collection('workspaces').doc(workspaceId).get()
  const organizationId = workspaceSnap.data()?.organizationId ?? null

  let targetUid: string | null = null
  try {
    const userRecord = await getFirebaseAuth().getUserByEmail(emailNorm)
    targetUid = userRecord.uid
  } catch {
    targetUid = null
  }

  if (targetUid) {
    const memberDocId = `${targetUid}_${workspaceId}`
    const existing = await db.collection('workspaceMembers').doc(memberDocId).get()
    if (existing.exists) {
      throw createError({ statusCode: 409, statusMessage: 'User is already a member of this workspace' })
    }

    await deleteWorkspaceInvitesForEmail(db, workspaceId, emailNorm)

    await db.collection('workspaceMembers').doc(memberDocId).set({
      uid: targetUid,
      workspaceId,
      organizationId,
      role,
      invitedBy: inviterUid,
      invitedEmail: emailNorm,
      joinedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    })
    invalidateWorkspaceMemberCache(targetUid, workspaceId)

    return { id: memberDocId, uid: targetUid, workspaceId, role, invitedEmail: emailNorm, pending: false }
  }

  const ref = await db.collection('workspaceInvites').add({
    workspaceId,
    organizationId,
    email: emailNorm,
    role,
    invitedBy: inviterUid,
    createdAt: FieldValue.serverTimestamp(),
  })

  return {
    id: ref.id,
    uid: null,
    workspaceId,
    role,
    invitedEmail: emailNorm,
    pending: true,
  }
})
