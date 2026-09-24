import { getDb } from '~~/server/utils/firebase'
import { invalidateOrgMemberCache, requireActiveOrgAdmin } from '~~/server/utils/workspace-auth'
import { writeAuditLog } from '~~/server/utils/audit-log'
import type { OrganizationDoc } from '~~/shared/types/organization'

/**
 * DELETE /api/admin/org/:orgId/members/:docId — 移除組織管理員。
 *
 * 三道護欄。少了任何一道，客戶都可能把自己鎖在門外，然後只能來找你：
 *   ① **不能移除最後一個管理員** —— 組織會變成沒人管得到的孤兒
 *   ② **不能移除登記擁有者** —— 那是帳務歸屬對象
 *   ③ **不能移除自己** —— 手滑一下就把自己踢出去，而且他馬上就沒有權限再加回來
 *
 * ⚠️ **整段必須在 transaction 裡。**
 *    「先數人數、再刪除」在併發下會破功：組織剩 A、B 兩人，A 刪 B、B 刪 A 同時發生，
 *    兩邊都讀到 count=2、都通過「不能刪最後一人」的檢查、都刪成功 → 組織變成
 *    **零管理員**，所有 /api/admin/org/* 都會 403，連把人加回來的端點都進不去，
 *    只能請 super admin 救。把整份成員清單讀進 transaction，讓 Firestore 鎖住讀取集合。
 *
 * （super admin 走 /api/admin/super/... 那條路，不受這些限制。）
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

  const removed = await db.runTransaction<string>(async (tx) => {
    // 把整份成員清單讀進 transaction：Firestore 會鎖住這個讀取集合，
    // 併發的另一個刪除若動到同一批文件就會被重試，人數檢查因此才真的成立。
    const all = await tx.get(db.collection('orgMembers').where('orgId', '==', orgId))
    const target = all.docs.find(d => d.id === docId)

    // 找不到 = 不存在，或屬於別的組織（路徑上的 orgId 只是宣稱，要跟文件內容對上）
    if (!target) throw createError({ statusCode: 404, statusMessage: '找不到此成員' })

    const email = String(target.data().email ?? '').trim().toLowerCase()

    if (all.size <= 1) {
      throw createError({ statusCode: 400, statusMessage: '不能移除最後一位管理員，組織會沒有人能管理' })
    }
    if (ownerEmail && email === ownerEmail) {
      throw createError({ statusCode: 400, statusMessage: '不能移除組織的登記擁有者' })
    }
    if (myEmail && email === myEmail) {
      throw createError({ statusCode: 400, statusMessage: '不能移除自己。請由其他管理員操作' })
    }

    tx.delete(memberRef)
    return email
  })

  invalidateOrgMemberCache(removed, orgId)

  // 稽核（`C-254`）：被移掉的人會失去底下**所有**官方帳號的管理權，而且不會收到通知
  await writeAuditLog({
    workspaceId: '',
    orgId,
    uid,
    actor: 'human',
    action: 'org.memberRemove',
    targetId: docId,
    before: { email: removed, role: 'admin' },
  }, db)

  return { ok: true, email: removed }
})
