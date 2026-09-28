import type { Firestore } from 'firebase-admin/firestore'
import { getFirebaseAuth } from './firebase'
import { invalidateWorkspaceMemberCache } from './workspace-auth'
import { removeFromHandoffNotify } from './member-line-bind'
import { writeAuditLog } from './audit-log'

export interface OrgMemberCascadeResult {
  /** 真的移掉的帳號成員身分（每個帳號一筆） */
  removed: { workspaceId: string, uid: string, role: string }[]
  /** 收掉的待處理邀請張數 */
  invitesDeleted: number
  /** 通知名單拿不掉、所以**沒移**的那幾個帳號（⛔ 呼叫端一定要看：有東西就不能往下刪組織那一筆） */
  failedWorkspaceIds: string[]
}

/**
 * 組織管理員被移出組織時，一併把他從組織底下**每一個**官方帳號移掉（`G-96` 2026-09-29 拍板）。
 *
 * 為什麼：原本只刪組織名單那一筆（orgMembers），他在各帳號的成員身分（workspaceMembers）原封不動——
 * 他自己開的帳號裡他是擁有者、誰都拿不掉，離職的人照樣看得到客人對話、改得動 LINE 金鑰、付款、邀人。
 * 組織頁的確認文字卻寫「將失去管理權限」。現在連客服、觀察者的身分也一起拿掉（拍板：「組織底下全部帳號」）。
 *
 * 怎麼認人（orgMembers 是 email、workspaceMembers 是 uid，兩邊要對起來）：
 *   ① 用 email 查 Firebase Auth 拿 uid（查不到＝還沒註冊或信箱改過，略過這一路）→ 他所有的成員身分
 *   ② 成員文件上的 `invitedEmail` 跟這個 email 相同的（被邀請加入時記下的信箱；①查不到時靠這個）
 *   兩路取聯集，只留**現在**屬於這個組織的帳號（以 workspaces.organizationId 為準，不信成員文件上抄的那格）。
 *   ⚠️ 沒註冊、信箱也改過、邀請時又沒記 invitedEmail 的舊成員，兩路都認不出來——這種要手動處理。
 *
 * 順序（`C-271`⑥ 同一條）：每個帳號都是**先從 LINE 通知名單拿掉、拿掉了才刪成員**；拿不掉的那個帳號
 * 就先不刪、記進 failedWorkspaceIds。呼叫端看到有失敗就**不要**刪組織那一筆——
 * 組織那一筆一刪，這個人就從組織頁消失，連重試的入口都沒有。
 *
 * ⚠️ 不套帳號層的「不能移除最後一位管理員」：拍板就是全部拿掉；帳號還有組織管理員管得到
 *    （組織層自己擋最後一位組織管理員；超管那條路本來就不擋）。
 */
export async function removeOrgMemberFromWorkspaces(params: {
  db: Firestore
  orgId: string
  email: string
  /** 誰按的（寫進各帳號操作紀錄） */
  actorUid: string
  /** 各帳號操作紀錄的備註，講清楚「為什麼這個人不見了」 */
  note: string
}): Promise<OrgMemberCascadeResult> {
  const { db, orgId, actorUid, note } = params
  const email = String(params.email ?? '').trim().toLowerCase()
  const result: OrgMemberCascadeResult = { removed: [], invitesDeleted: 0, failedWorkspaceIds: [] }
  if (!email) return result

  const wsSnap = await db.collection('workspaces').where('organizationId', '==', orgId).get()
  const orgWorkspaceIds = new Set(wsSnap.docs.map(d => d.id))
  if (!orgWorkspaceIds.size) return result

  let uid: string | null = null
  try {
    uid = (await getFirebaseAuth().getUserByEmail(email)).uid
  }
  catch { /* 查不到＝還沒註冊或信箱改過：靠 invitedEmail 那一路 */ }

  const [byUid, byEmail, invites] = await Promise.all([
    uid ? db.collection('workspaceMembers').where('uid', '==', uid).get() : Promise.resolve(null),
    db.collection('workspaceMembers').where('invitedEmail', '==', email).get(),
    db.collection('workspaceInvites').where('email', '==', email).get(),
  ])

  const memberDocs = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>()
  for (const d of [...(byUid?.docs ?? []), ...byEmail.docs]) {
    if (orgWorkspaceIds.has(String(d.data().workspaceId ?? ''))) memberDocs.set(d.id, d)
  }

  for (const d of memberDocs.values()) {
    const workspaceId = String(d.data().workspaceId)
    const memberUid = String(d.data().uid ?? '')
    const role = String(d.data().role ?? '')
    const lineUserId = String(d.data().lineUserId ?? '').trim()
    if (lineUserId && await removeFromHandoffNotify(workspaceId, lineUserId) === 'failed') {
      result.failedWorkspaceIds.push(workspaceId)
      continue
    }
    await d.ref.delete()
    if (memberUid) invalidateWorkspaceMemberCache(memberUid, workspaceId)
    result.removed.push({ workspaceId, uid: memberUid, role })

    // 每個帳號自己的操作紀錄都要有一筆：那個帳號的管理員會發現「這個人怎麼不見了」
    await writeAuditLog({
      workspaceId,
      orgId,
      uid: actorUid,
      actor: 'human',
      action: 'members.remove',
      targetId: memberUid || d.id,
      before: { email, role },
      note: lineUserId ? `${note}；順手把他從 LINE 通知名單移掉了` : note,
    }, db)
  }

  // 還沒轉正的邀請也收掉：不然他之後拿這個信箱登入，又自動變回成員
  const orgInvites = invites.docs.filter(d => orgWorkspaceIds.has(String(d.data().workspaceId ?? '')))
  for (const inv of orgInvites) await inv.ref.delete()
  result.invitesDeleted = orgInvites.length

  return result
}
