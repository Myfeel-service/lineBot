import { isSuperAdmin, trustedEmail, verifyRequestToken } from '~~/server/utils/workspace-auth'
import { getBillingPlan } from '~~/shared/billing/plans'
import { ROLE_LEVEL } from '~~/shared/permissions'
import type { WorkspaceMemberRole } from '~~/shared/types/organization'
import { isInviteExpired } from '~~/shared/workspace-invite'

/**
 * 帳號選單用的精簡方案標籤。只給 owner/admin 看（計費屬管理層資訊）；
 * 其他角色或未訂閱回 null。
 */
function planTag(role: string, planId: unknown): { id: string; name: string } | null {
  if (role !== 'owner' && role !== 'admin') return null
  if (!planId || typeof planId !== 'string') return null
  const p = getBillingPlan(planId)
  return { id: p.id, name: p.name }
}

/**
 * GET /api/admin/workspaces/my
 * 回傳目前登入者可存取的所有 workspace（含角色、組織名稱）。
 *
 * 存取來源：
 *   - Super admin：所有 workspace
 *   - 一般用戶：直接 workspace 成員 + 透過 org admin（email-based）取得的 workspace
 *   - 已停用組織的 workspace 對一般用戶隱藏
 *
 * ⚠️ 角色的算法必須跟 requireWorkspaceAccess 一模一樣，不然清單上寫的跟實際進得去的對不上。
 */
export default defineEventHandler(async (event) => {
  // 跟守門同一支：超管那條路會多驗「有沒有被撤銷」（`G-104`②）
  const decoded = await verifyRequestToken(event)

  const db = getDb()

  // ── Super admin ──────────────────────────────────────────────────
  if (isSuperAdmin(decoded)) {
    const [wsSnap, orgSnap] = await Promise.all([
      db.collection('workspaces').get(),
      db.collection('organizations').get(),
    ])
    const orgMap: Record<string, { name: string; disabled: boolean }> = {}
    orgSnap.forEach(d => {
      orgMap[d.id] = { name: d.data().name ?? d.id, disabled: d.data().disabled === true }
    })
    const workspaces = wsSnap.docs.map(d => {
      const orgId = d.data().organizationId ?? null
      return {
        workspaceId: d.id,
        name: d.data().name ?? d.id,
        role: 'owner' as const,
        organizationId: orgId,
        organizationName: orgId ? (orgMap[orgId]?.name ?? null) : null,
        organizationDisabled: orgId ? (orgMap[orgId]?.disabled ?? false) : false,
        viaOrgAdmin: false,
        plan: planTag('owner', d.data().subscription?.planId),
      }
    })
    const orgAdminOf = orgSnap.docs
      .filter(d => !d.data().disabled)
      .map(d => ({ id: d.id, name: d.data().name ?? d.id }))
    return { workspaces, orgAdminOf }
  }

  // ── 一般用戶 ─────────────────────────────────────────────────────
  const uid = decoded.uid
  // 跟守門同一個口徑（`G-107`⑦、`G-99`）：原本這裡沒轉小寫，大小寫不同時清單跟實際權限對不上；
  // 沒驗證過的信箱不認，組織管理員與 email 邀請就都不列
  const email = trustedEmail(decoded) ?? ''

  // 並行取得：workspace 成員資格 + org 成員資格（email-based）
  const [membersSnap, orgMembersSnap] = await Promise.all([
    db.collection('workspaceMembers').where('uid', '==', uid).get(),
    email ? db.collection('orgMembers').where('email', '==', email).get() : Promise.resolve(null),
  ])

  const adminOrgIds: string[] = orgMembersSnap?.docs.map(d => d.data().orgId as string) ?? []

  // 收集所有相關 org ID
  const wsMemberOrgIds = membersSnap.docs
    .map(d => d.data().organizationId as string | null)
    .filter(Boolean) as string[]
  const allOrgIds = [...new Set([...wsMemberOrgIds, ...adminOrgIds])]

  // 批次取得 org 資料
  const orgDocs = allOrgIds.length > 0
    ? await db.getAll(...allOrgIds.map(id => db.collection('organizations').doc(id)))
    : []

  const orgMap: Record<string, { name: string; disabled: boolean }> = {}
  orgDocs.forEach((d: any) => {
    if (d.exists) orgMap[d.id] = { name: d.data()?.name ?? d.id, disabled: d.data()?.disabled === true }
  })

  // 取得直接成員的 workspace 名稱
  const directWorkspaceIds = membersSnap.docs.map(d => d.data().workspaceId as string)
  const directWsDocs = directWorkspaceIds.length > 0
    ? await db.getAll(...directWorkspaceIds.map(id => db.collection('workspaces').doc(id)))
    : []

  const wsDataMap: Record<string, { name: string; organizationId: string | null; planId: string | null }> = {}
  directWsDocs.forEach((d: any) => {
    if (d.exists) {
      wsDataMap[d.id] = {
        name: d.data()?.name ?? d.id,
        organizationId: d.data()?.organizationId ?? null,
        planId: d.data()?.subscription?.planId ?? null,
      }
    }
  })

  const result: any[] = []
  const includedWorkspaceIds = new Set<string>()
  /** 直接成員那幾列，組織管理員那段要拿來把角色往上拉（`G-101`①） */
  const directRows = new Map<string, any>()

  // 直接 workspace 成員（過濾停用組織）
  for (const doc of membersSnap.docs) {
    const data = doc.data()
    const workspaceId = data.workspaceId as string
    const orgId = wsDataMap[workspaceId]?.organizationId ?? data.organizationId ?? null
    if (orgId && orgMap[orgId]?.disabled) continue

    const row = {
      workspaceId,
      name: wsDataMap[workspaceId]?.name ?? workspaceId,
      role: data.role as string,
      organizationId: orgId,
      organizationName: orgId ? (orgMap[orgId]?.name ?? null) : null,
      organizationDisabled: false,
      viaOrgAdmin: false,
      plan: planTag(data.role as string, wsDataMap[workspaceId]?.planId),
    }
    result.push(row)
    directRows.set(workspaceId, row)
    includedWorkspaceIds.add(workspaceId)
  }

  // Org admin 額外可存取的 workspace（排除已停用組織）
  const activeAdminOrgIds = adminOrgIds.filter(id => !orgMap[id]?.disabled)
  if (activeAdminOrgIds.length > 0) {
    const orgWsSnaps = await Promise.all(
      activeAdminOrgIds.map(orgId =>
        db.collection('workspaces').where('organizationId', '==', orgId).get(),
      ),
    )
    orgWsSnaps.forEach((snap, i) => {
      const orgId = activeAdminOrgIds[i]
      if (!orgId) return
      snap.docs.forEach(d => {
        // 同時是直接成員：取兩者較高的（`G-101`①，跟 requireWorkspaceAccess 同一條規則）。
        // 原本直接跳過，先被邀成客服、後來才升組織管理員的人，清單上永遠寫客服
        const direct = directRows.get(d.id)
        if (direct) {
          if ((ROLE_LEVEL[direct.role as WorkspaceMemberRole] ?? 0) < ROLE_LEVEL.admin) {
            direct.role = 'admin'
            direct.viaOrgAdmin = true
            direct.plan = planTag('admin', d.data().subscription?.planId)
          }
          return
        }
        if (includedWorkspaceIds.has(d.id)) return
        result.push({
          workspaceId: d.id,
          name: d.data().name ?? d.id,
          role: 'admin' as const,
          organizationId: orgId,
          organizationName: orgMap[orgId]?.name ?? null,
          organizationDisabled: false,
          viaOrgAdmin: true,
          plan: planTag('admin', d.data().subscription?.planId),
        })
        includedWorkspaceIds.add(d.id)
      })
    })
  }

  // Email 邀請（workspaceInvites）：對方尚未註冊 Firebase 時仍可出現在帳號選擇列表
  if (email) {
    const invSnap = await db.collection('workspaceInvites').where('email', '==', email).get()
    for (const doc of invSnap.docs) {
      const wid = doc.data().workspaceId as string
      if (includedWorkspaceIds.has(wid)) continue
      // 過期的邀請進不去（守門不轉正，`G-107`⑥），⛔ 不列：列了他點進去只會被擋
      if (isInviteExpired(doc.data())) continue
      const wSnap = await db.collection('workspaces').doc(wid).get()
      if (!wSnap.exists) continue
      const orgId = wSnap.data()?.organizationId ?? null
      if (orgId) {
        const oSnap = await db.collection('organizations').doc(orgId).get()
        if (!oSnap.exists || oSnap.data()?.disabled === true) continue
        result.push({
          workspaceId: wid,
          name: wSnap.data()?.name ?? wid,
          role: doc.data().role as string,
          organizationId: orgId,
          organizationName: (oSnap.data()?.name as string) ?? orgId,
          organizationDisabled: false,
          viaOrgAdmin: false,
          viaWorkspaceInvite: true,
          plan: planTag(doc.data().role as string, wSnap.data()?.subscription?.planId),
        })
      }
      else {
        result.push({
          workspaceId: wid,
          name: wSnap.data()?.name ?? wid,
          role: doc.data().role as string,
          organizationId: null,
          organizationName: null,
          organizationDisabled: false,
          viaOrgAdmin: false,
          viaWorkspaceInvite: true,
          plan: planTag(doc.data().role as string, wSnap.data()?.subscription?.planId),
        })
      }
      includedWorkspaceIds.add(wid)
    }
  }

  const orgAdminOf = adminOrgIds
    .map(id => ({ id, org: orgMap[id] }))
    .filter((x): x is { id: string; org: NonNullable<typeof x.org> } => Boolean(x.org && !x.org.disabled))
    .map(x => ({ id: x.id, name: x.org.name }))

  return { workspaces: result, orgAdminOf }
})
