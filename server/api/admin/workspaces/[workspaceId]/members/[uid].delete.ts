import { getDb } from '~~/server/utils/firebase'
import { requireCapability, invalidateWorkspaceMemberCache } from '~~/server/utils/workspace-auth'
import { removeFromHandoffNotify } from '~~/server/utils/member-line-bind'
import { wouldLeaveNoManager } from '~~/server/utils/workspace-member-guard'
import { writeAuditLog } from '~~/server/utils/audit-log'

type MemberDoc = { id: string, data: () => Record<string, unknown> | undefined }

/**
 * 移除前的檢查（`G-101`②）：交易外先看一次、交易裡再看一次，兩次同一套規則。
 * `canTouchOwner`：呼叫者是組織管理員或超管（`G-96`）。
 */
function checkRemoval(docs: MemberDoc[], memberDocId: string, canTouchOwner: boolean): MemberDoc {
  const target = docs.find(d => d.id === memberDocId)
  if (!target) throw createError({ statusCode: 404, statusMessage: 'Member not found' })
  if (target.data()?.role === 'owner' && !canTouchOwner) {
    throw createError({ statusCode: 403, statusMessage: '擁有者只有組織管理員能移除' })
  }
  if (wouldLeaveNoManager(docs.map(d => ({ id: d.id, role: d.data()?.role })), memberDocId, null)) {
    throw createError({ statusCode: 400, statusMessage: '不能移除最後一位管理員，帳號會沒有人能管理' })
  }
  return target
}

/**
 * DELETE /api/admin/workspaces/:workspaceId/members/:uid
 * 移除成員。需 admin 以上角色。
 * 擁有者**只有組織管理員與超管**能移除（`G-96` 2026-09-29 拍板；原本誰都拿不掉、錯誤訊息叫人去
 * 「轉移所有權」，全站卻沒有這個功能）。帳號管理員照樣移不掉擁有者。
 *
 * 護欄（`G-101`②，比照組織層 org/[orgId]/members/[docId].delete.ts）：
 *   ① **不能移除自己**——手滑一下就把自己踢出去，而且馬上就沒有權限再加回來
 *   ② **不能移除最後一位管理員**——人數檢查跟刪除在同一個 transaction 裡（理由同組織層：
 *      剩 A、B 兩人互刪同時發生時，「先數再刪」兩邊都會通過）
 */
export default defineEventHandler(async (event) => {
  const { uid: callerUid, workspaceId, isSuperAdmin, isOrgAdmin } = await requireCapability(event, 'members.manage')
  const canTouchOwner = isOrgAdmin || isSuperAdmin

  const targetUid = event.context.params?.uid
  if (!targetUid) throw createError({ statusCode: 400, statusMessage: 'uid is required' })

  // 超管不受「不能移除自己」限制：他的權限不是靠這筆成員文件來的，移掉也不會把自己鎖在門外
  if (targetUid === callerUid && !isSuperAdmin) {
    throw createError({ statusCode: 400, statusMessage: '不能移除自己。請由其他管理員操作' })
  }

  const db = getDb()
  const memberDocId = `${targetUid}_${workspaceId}`
  const memberRef = db.collection('workspaceMembers').doc(memberDocId)
  const membersQuery = db.collection('workspaceMembers').where('workspaceId', '==', workspaceId)

  // 交易外先看一次：擋得下來的先擋掉，才不會通知名單已經拿掉、人卻因為護欄沒移成
  const snap = checkRemoval((await membersQuery.get()).docs, memberDocId, canTouchOwner)
  const lineUserId = String(snap.data()?.lineUserId ?? '').trim()

  // 人都移除了通知還一直推,名單上還會留一筆對不上任何成員的 Uxxx。
  // ⚠️ 先拿掉、拿掉了才刪成員（`C-271`⑥）：反過來的話名單拿不掉時成員已經刪了，連重試都找不到要拿掉誰
  if (lineUserId && await removeFromHandoffNotify(workspaceId, lineUserId) === 'failed')
    throw createError({ statusCode: 500, statusMessage: '通知名單改不進去，請再試一次' })

  // 把整份成員清單讀進 transaction：Firestore 鎖住讀取集合，人數檢查才成立
  await db.runTransaction(async (tx) => {
    const all = await tx.get(membersQuery)
    checkRemoval(all.docs, memberDocId, canTouchOwner)
    tx.delete(memberRef)
  })

  // 被移除的人在這台機器上不能再靠快取多用 15 秒（`G-101`③；其他實例等 TTL）
  invalidateWorkspaceMemberCache(targetUid, workspaceId)

  // 稽核（`C-254`）：把人踢出去是權限邊界的變動，⛔ 這種事沒有紀錄是不行的
  await writeAuditLog({
    workspaceId,
    uid: callerUid,
    actor: 'human',
    action: 'members.remove',
    targetId: targetUid,
    before: {
      email: String(snap.data()?.invitedEmail ?? ''),
      role: String(snap.data()?.role ?? ''),
    },
    ...(lineUserId ? { note: '順手把他從轉真人的通知名單移掉了' } : {}),
  }, db)

  return { ok: true, removed: targetUid }
})
