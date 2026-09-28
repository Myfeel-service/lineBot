import { getDb } from '~~/server/utils/firebase'
import { requireCapability, invalidateWorkspaceMemberCache } from '~~/server/utils/workspace-auth'
import { removeFromHandoffNotify } from '~~/server/utils/member-line-bind'
import { wouldLeaveNoManager } from '~~/server/utils/workspace-member-guard'
import { writeAuditLog } from '~~/server/utils/audit-log'
import type { WorkspaceMemberRole } from '~~/shared/types/organization'

const VALID_ROLES: WorkspaceMemberRole[] = ['admin', 'agent', 'viewer']

type MemberDoc = { id: string, data: () => Record<string, unknown> | undefined }

/**
 * 改角色前的檢查（`G-101`②）。交易外先看一次、交易裡再看一次，兩次同一套規則。
 * 回傳目標那一筆（找不到／動不了擁有者／會變成零管理員都直接擋）。
 * `canTouchOwner`：呼叫者是組織管理員或超管（`G-96`）。
 */
function checkRoleChange(docs: MemberDoc[], memberDocId: string, role: WorkspaceMemberRole, canTouchOwner: boolean): MemberDoc {
  const target = docs.find(d => d.id === memberDocId)
  if (!target) throw createError({ statusCode: 404, statusMessage: 'Member not found' })
  if (target.data()?.role === 'owner' && !canTouchOwner) {
    throw createError({ statusCode: 403, statusMessage: '擁有者的角色只有組織管理員能改' })
  }
  if (wouldLeaveNoManager(docs.map(d => ({ id: d.id, role: d.data()?.role })), memberDocId, role)) {
    throw createError({ statusCode: 400, statusMessage: '不能把最後一位管理員改掉，帳號會沒有人能管理' })
  }
  return target
}

/**
 * PUT /api/admin/workspaces/:workspaceId/members/:uid
 * 更改成員角色。需 admin 以上角色。
 * 擁有者的角色**只有組織管理員與超管**能改（`G-96` 2026-09-29 拍板）：原本誰都改不掉、錯誤訊息
 * 叫人去「轉移所有權」，全站卻沒有這個功能——離職的擁有者只能到 Firestore 主控台手動刪。
 * 帳號管理員照樣動不了擁有者。⛔ 誰都不能把人**改成**擁有者（VALID_ROLES 沒有 owner）。
 *
 * 護欄（`G-101`②，比照組織層的移除管理員）：
 *   ① **不能改自己**——手滑把自己改成觀察者會立刻被踢出設定頁，而且沒有權限再改回來
 *   ② **不能讓帳號變成零管理員**——人數檢查跟寫入在同一個 transaction 裡，
 *      否則剩兩位管理員互相降級同時發生時，兩邊都讀到「還有另一位」、都通過
 * 降成觀察者時順手從 LINE 通知名單拿掉（`G-101`④）：觀察者不收通知（`C-271`⑬）。
 *
 * Body: { role: 'admin' | 'agent' | 'viewer' }
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid, isSuperAdmin, isOrgAdmin } = await requireCapability(event, 'members.manage')
  const canTouchOwner = isOrgAdmin || isSuperAdmin

  const targetUid = event.context.params?.uid
  if (!targetUid) throw createError({ statusCode: 400, statusMessage: 'uid is required' })

  const body = await readBody(event)
  const { role } = body

  if (!VALID_ROLES.includes(role)) {
    throw createError({ statusCode: 400, statusMessage: `role must be one of: ${VALID_ROLES.join(', ')}` })
  }

  // 超管不受「不能改自己」限制：他的權限不是靠這筆成員文件來的，改了也不會把自己鎖在門外
  if (targetUid === uid && !isSuperAdmin) {
    throw createError({ statusCode: 400, statusMessage: '不能改自己的角色。請由其他管理員操作' })
  }

  const db = getDb()
  const memberDocId = `${targetUid}_${workspaceId}`
  const memberRef = db.collection('workspaceMembers').doc(memberDocId)
  const membersQuery = db.collection('workspaceMembers').where('workspaceId', '==', workspaceId)

  // 交易外先看一次：擋得下來的先擋掉，才不會通知名單已經拿掉、角色卻因為護欄沒改成
  const pre = checkRoleChange((await membersQuery.get()).docs, memberDocId, role, canTouchOwner)
  const lineUserId = String(pre.data()?.lineUserId ?? '').trim()

  // 降成觀察者 → 從通知名單拿掉（`G-101`④）。
  // ⚠️ 先拿掉、拿掉了才改角色（`C-271`⑥ 同一條）：反過來的話名單拿不掉時人已經是觀察者，
  //    卻還在收客人的名字與原話。這裡失敗的話什麼都還沒改，他再按一次就好。
  let notifyRemoved = false
  if (role === 'viewer' && lineUserId) {
    const r = await removeFromHandoffNotify(workspaceId, lineUserId)
    if (r === 'failed') throw createError({ statusCode: 500, statusMessage: '通知名單改不進去，請再試一次' })
    notifyRemoved = r === 'removed'
  }

  // 把整份成員清單讀進 transaction：Firestore 鎖住讀取集合，併發的另一個改動會被重試，人數檢查才成立
  const before = await db.runTransaction(async (tx) => {
    const all = await tx.get(membersQuery)
    const target = checkRoleChange(all.docs, memberDocId, role, canTouchOwner)
    tx.update(memberRef, { role })
    return String(target.data()?.role ?? '')
  })

  // 角色是安全邊界：這台機器的權限快取立刻清掉（其他實例等 15 秒 TTL；`G-101`③）
  invalidateWorkspaceMemberCache(targetUid, workspaceId)

  // 誰把誰改成什麼權限，是出事時第一個要查的東西
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'members/role.put',
    targetId: targetUid,
    before: { role: before },
    after: { role },
    ...(notifyRemoved ? { note: '改成觀察者，順手把他從 LINE 通知名單移掉了' } : {}),
  })

  return { id: memberDocId, uid: targetUid, workspaceId, role }
})
