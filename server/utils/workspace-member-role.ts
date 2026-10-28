import type { Firestore } from 'firebase-admin/firestore'
import { invalidateWorkspaceMemberCache } from './workspace-auth'
import { removeFromHandoffNotify } from './member-line-bind'
import { wouldLeaveNoManager } from './workspace-member-guard'
import type { WorkspaceMemberRole } from '~~/shared/types/organization'

/** 能改成的角色。⛔ 誰都不能把人**改成**擁有者（`G-96`） */
export const ASSIGNABLE_MEMBER_ROLES: WorkspaceMemberRole[] = ['admin', 'agent', 'viewer']

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
 * 把一位成員改成某個角色（2026-10-28 從 `PUT .../members/:uid` 抽出來，`D-156`：
 * 操作紀錄的「還原」改回原本的權限也要守同一套護欄，⛔ 不另寫一份）。
 *
 * 呼叫端自己擋：「不能改自己」（超管例外）、角色在不在 `ASSIGNABLE_MEMBER_ROLES`。
 * 這裡守：擁有者只有組織管理員／超管動得了、不能讓帳號變成零管理員（人數檢查跟寫入在同一個交易）、
 * 降成觀察者時順手從 LINE 通知名單拿掉（`G-101`④）。
 * 回傳改之前的角色，以及有沒有真的從通知名單拿掉。
 */
export async function changeWorkspaceMemberRole(
  db: Firestore,
  input: { workspaceId: string, targetUid: string, role: WorkspaceMemberRole, canTouchOwner: boolean },
): Promise<{ before: string, notifyRemoved: boolean }> {
  const { workspaceId, targetUid, role, canTouchOwner } = input
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
  return { before, notifyRemoved }
}
