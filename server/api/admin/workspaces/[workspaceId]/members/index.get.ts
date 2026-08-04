import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { getDb, getFirebaseAuth } from '~~/server/utils/firebase'

function normEmail(e: string | undefined | null): string {
  return String(e ?? '').trim().toLowerCase()
}

/**
 * GET /api/admin/workspaces/:workspaceId/members
 * 列出 workspace 成員、待加入邀請，以及（若 workspace 有綁組織）組織層級的擁有者登記與組織管理員（僅顯示、不可在此頁變更）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')

  const db = getDb()
  const auth = getFirebaseAuth()

  const wsRef = db.collection('workspaces').doc(workspaceId)
  const [memberSnap, inviteSnap, wsSnap] = await Promise.all([
    db.collection('workspaceMembers')
      .where('workspaceId', '==', workspaceId)
      .get(),
    db.collection('workspaceInvites')
      .where('workspaceId', '==', workspaceId)
      .get(),
    wsRef.get(),
  ])

  // lineBindCode 是一次性密碼:誰拿到就能把自己綁成這位成員。列表允許 viewer 讀,
  // 所以只回「有沒有待輸入的碼」,碼本身僅在產碼那一次回給 admin。
  const members = memberSnap.docs.map((d) => {
    const { lineBindCode, lineBindCodeExpiresAt, ...rest } = d.data() as Record<string, any>
    return {
      id: d.id,
      ...rest,
      hasPendingBindCode: Boolean(lineBindCode) && Number(lineBindCodeExpiresAt ?? 0) > Date.now(),
    }
  }) as Record<string, any>[]

  const pending = inviteSnap.docs.map(d => ({
    id: d.id,
    inviteId: d.id,
    pendingInvite: true,
    uid: null as string | null,
    workspaceId,
    role: d.data().role,
    invitedEmail: d.data().email,
    invitedBy: d.data().invitedBy ?? null,
    createdAt: d.data().createdAt ?? null,
  }))

  const merged: any[] = [...members, ...pending]

  const uids = [...new Set(
    members.filter(m => m.uid && !normEmail(m.invitedEmail)).map(m => String(m.uid)),
  )]
  const uidToEmail: Record<string, string> = {}
  if (uids.length) {
    const res = await auth.getUsers(uids.map(uid => ({ uid })))
    for (const u of res.users)
      uidToEmail[u.uid] = normEmail(u.email)
  }

  const emailSeen = new Set<string>()
  for (const row of merged) {
    const fromInvite = normEmail(row.invitedEmail)
    if (fromInvite) {
      emailSeen.add(fromInvite)
      continue
    }
    if (row.uid) {
      const ue = uidToEmail[row.uid]
      if (ue) emailSeen.add(ue)
    }
  }

  const organizationId = wsSnap.exists ? (wsSnap.data()?.organizationId as string | null | undefined) : null
  if (!organizationId)
    return merged

  const [orgSnap, orgMemberSnap] = await Promise.all([
    db.collection('organizations').doc(organizationId).get(),
    db.collection('orgMembers').where('orgId', '==', organizationId).get(),
  ])

  const linkedRows: any[] = []

  for (const om of orgMemberSnap.docs) {
    const raw = String(om.data().email ?? '').trim()
    const email = normEmail(raw)
    if (!email || emailSeen.has(email))
      continue
    emailSeen.add(email)
    linkedRows.push({
      id: `orgMember:${om.id}`,
      linkedSource: 'org_member',
      uid: null,
      invitedEmail: raw || email,
      role: 'org_admin',
      pendingInvite: false,
      readOnly: true,
    })
  }

  if (orgSnap.exists) {
    const od = orgSnap.data() as Record<string, unknown>
    const rawOwner = String(od.ownerEmail ?? '').trim()
    let ownerNorm = normEmail(rawOwner)
    if (!ownerNorm && od.ownerId) {
      try {
        ownerNorm = normEmail((await auth.getUser(String(od.ownerId))).email)
      } catch { /* */ }
    }
    const displayOwner = rawOwner || ownerNorm
    if (ownerNorm && !emailSeen.has(ownerNorm)) {
      linkedRows.push({
        id: 'orgOwner:registered',
        linkedSource: 'org_owner',
        uid: null,
        invitedEmail: displayOwner,
        role: 'org_owner',
        pendingInvite: false,
        readOnly: true,
      })
      emailSeen.add(ownerNorm)
    }
  }

  return [...merged, ...linkedRows]
})
