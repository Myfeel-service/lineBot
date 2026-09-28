import { getDb } from '~~/server/utils/firebase'
import { invalidateOrgMemberCache, requireActiveOrgAdmin } from '~~/server/utils/workspace-auth'
import { removeOrgMemberFromWorkspaces } from '~~/server/utils/org-member-cascade'
import { writeAuditLog } from '~~/server/utils/audit-log'
import type { OrganizationDoc } from '~~/shared/types/organization'

type OrgMemberDoc = { id: string, data: () => Record<string, unknown> }

/**
 * 三道護欄（交易外先看一次、交易裡再看一次，兩次同一套規則）。回傳要移除的那個 email。
 */
function checkRemoval(docs: OrgMemberDoc[], docId: string, ownerEmail: string, myEmail: string | null): string {
  const target = docs.find(d => d.id === docId)

  // 找不到 = 不存在，或屬於別的組織（路徑上的 orgId 只是宣稱，要跟文件內容對上）
  if (!target) throw createError({ statusCode: 404, statusMessage: '找不到此成員' })

  const email = String(target.data().email ?? '').trim().toLowerCase()

  if (docs.length <= 1) {
    throw createError({ statusCode: 400, statusMessage: '不能移除最後一位管理員，組織會沒有人能管理' })
  }
  if (ownerEmail && email === ownerEmail) {
    throw createError({ statusCode: 400, statusMessage: '不能移除組織的登記擁有者' })
  }
  if (myEmail && email === myEmail) {
    throw createError({ statusCode: 400, statusMessage: '不能移除自己。請由其他管理員操作' })
  }
  return email
}

/**
 * DELETE /api/admin/org/:orgId/members/:docId — 移除組織管理員。
 *
 * 三道護欄。少了任何一道，客戶都可能把自己鎖在門外，然後只能來找你：
 *   ① **不能移除最後一個管理員** —— 組織會變成沒人管得到的孤兒
 *   ② **不能移除登記擁有者** —— 那是帳務歸屬對象
 *   ③ **不能移除自己** —— 手滑一下就把自己踢出去，而且他馬上就沒有權限再加回來
 *
 * ⚠️ **刪除必須在 transaction 裡。**
 *    「先數人數、再刪除」在併發下會破功：組織剩 A、B 兩人，A 刪 B、B 刪 A 同時發生，
 *    兩邊都讀到 count=2、都通過「不能刪最後一人」的檢查、都刪成功 → 組織變成
 *    **零管理員**，所有 /api/admin/org/* 都會 403，連把人加回來的端點都進不去，
 *    只能請 super admin 救。把整份成員清單讀進 transaction，讓 Firestore 鎖住讀取集合。
 *
 * ⭐ 一併移出組織底下**每一個**官方帳號（`G-96` 2026-09-29 拍板，含客服／觀察者身分與待處理邀請）：
 *    原本只刪組織名單這一筆，他在各帳號的成員身分原封不動，自己開的帳號裡還是誰都拿不掉的擁有者。
 *    順序：交易外先過一次護欄 → 移出各帳號 → 交易裡再過一次護欄、刪組織那一筆。
 *    ⛔ 各帳號有任何一個沒移成（通知名單拿不掉）就**不刪組織那一筆**、回 500 請他再按一次：
 *    組織那一筆一刪，這個人就從組織頁消失，連重試的入口都沒有（`C-271`⑥ 同一條）。
 *    ⚠️ 極少數併發下交易裡才被護欄擋（例如另一位同時刪了別人）：各帳號已經移掉、組織那一筆還在——
 *    他仍是組織管理員、各帳號照樣進得去（組織管理員至少是 admin），只少了直接成員那一列，不會鎖死任何人。
 *
 * （super admin 走 /api/admin/super/... 那條路，不受這些護欄限制；一樣會移出各帳號。）
 */
export default defineEventHandler(async (event) => {
  const orgId = event.context.params?.orgId
  const docId = event.context.params?.docId
  if (!orgId || !docId) throw createError({ statusCode: 400, statusMessage: 'orgId / docId is required' })

  const { email: myEmail, uid } = await requireActiveOrgAdmin(event, orgId)

  const db = getDb()
  const orgSnap = await db.collection('organizations').doc(orgId).get()
  const ownerEmail = String((orgSnap.data() as OrganizationDoc | undefined)?.ownerEmail ?? '')
    .trim().toLowerCase()

  const memberRef = db.collection('orgMembers').doc(docId)
  const membersQuery = db.collection('orgMembers').where('orgId', '==', orgId)

  // 交易外先過一次護欄：擋得下來的先擋掉，才不會人已經被移出各帳號、組織這邊卻因為護欄沒刪成
  const email = checkRemoval((await membersQuery.get()).docs, docId, ownerEmail, myEmail)

  const cascade = await removeOrgMemberFromWorkspaces({
    db, orgId, email, actorUid: uid, note: `${email} 被移出組織，一併從這個帳號移除`,
  })
  if (cascade.failedWorkspaceIds.length) {
    throw createError({
      statusCode: 500,
      statusMessage: `有 ${cascade.failedWorkspaceIds.length} 個官方帳號的 LINE 通知名單改不進去，他還沒被移除，請再按一次`,
    })
  }

  const removed = await db.runTransaction<string>(async (tx) => {
    // 把整份成員清單讀進 transaction：Firestore 會鎖住這個讀取集合，
    // 併發的另一個刪除若動到同一批文件就會被重試，人數檢查因此才真的成立。
    const all = await tx.get(membersQuery)
    const e = checkRemoval(all.docs, docId, ownerEmail, myEmail)
    tx.delete(memberRef)
    return e
  })

  invalidateOrgMemberCache(removed, orgId)

  // 稽核（`C-254`）：被移掉的人會離開底下**所有**官方帳號，而且不會收到通知（各帳號自己那一筆由 cascade 寫）
  await writeAuditLog({
    workspaceId: '',
    orgId,
    uid,
    actor: 'human',
    action: 'org.memberRemove',
    targetId: docId,
    before: { email: removed, role: 'admin' },
    note: `一併從 ${cascade.removed.length} 個官方帳號移除${cascade.invitesDeleted ? `，收回 ${cascade.invitesDeleted} 張還沒接受的邀請` : ''}`,
  }, db)

  return { ok: true, email: removed, removedFromWorkspaces: cascade.removed.length, invitesDeleted: cascade.invitesDeleted }
})
