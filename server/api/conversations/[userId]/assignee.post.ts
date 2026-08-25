import { FieldValue } from 'firebase-admin/firestore'
import { getDb, getFirebaseAuth } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { lineUserFirestoreDocId, lineUserIdFromFirestoreDocId } from '~~/shared/line-workspace'
import { NO_ASSIGNEE, type ConversationAssignee } from '~~/shared/conversation-assignee'

/**
 * POST /api/conversations/:userId/assignee — 指派／取消「負責人員」（G-27 功能缺口②）
 *
 * Body: { uid: string }  — 空字串／null ＝ 取消指派
 * Response: ConversationAssignee
 *
 * ⛔ 只准指派給**這個工作區、而且回得了訊息**的成員（同 assignees.get.ts 的名單）：
 *    不驗的話任何一組 uid 都寫得進去，清單上就會出現查無此人的名字。
 * ⛔ 不動會話狀態：負責人員與「機器人有沒有閉嘴」是兩件事（見 shared/conversation-assignee.ts）。
 */
const ASSIGNABLE_ROLES = new Set(['owner', 'admin', 'agent'])

export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')

  const userIdParam = getRouterParam(event, 'userId')
  if (!userIdParam) throw createError({ statusCode: 400, statusMessage: 'userId is required' })
  const docId = lineUserFirestoreDocId(lineUserIdFromFirestoreDocId(userIdParam, workspaceId), workspaceId)

  const body = await readBody(event)
  const uid = String(body?.uid ?? '').trim()

  const db = getDb()
  const convRef = db.collection('conversations').doc(docId)
  const convSnap = await convRef.get()
  if (!convSnap.exists || convSnap.data()?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到此對話' })
  }

  if (!uid) {
    await convRef.update({
      assigneeUid: FieldValue.delete(),
      assigneeName: FieldValue.delete(),
      assignedAt: FieldValue.delete(),
    })
    return NO_ASSIGNEE
  }

  const memberSnap = await db.collection('workspaceMembers')
    .where('workspaceId', '==', workspaceId)
    .where('uid', '==', uid)
    .limit(1)
    .get()
  const member = memberSnap.docs[0]?.data()
  if (!member || !ASSIGNABLE_ROLES.has(String(member.role ?? ''))) {
    throw createError({ statusCode: 400, statusMessage: '這個人不在這個官方帳號的客服名單裡，無法指派' })
  }

  const name = await resolveMemberName(uid, String(member.invitedEmail ?? '').trim())
  const now = new Date()
  await convRef.update({ assigneeUid: uid, assigneeName: name, assignedAt: now })

  return { uid, name, assignedAtMs: now.getTime() } satisfies ConversationAssignee
})

/** 名字只有 Auth 有；查不到就退回 email，⛔ 不要寫入空名字（清單會出現一顆沒有字的圓章） */
async function resolveMemberName(uid: string, fallbackEmail: string): Promise<string> {
  try {
    const user = await getFirebaseAuth().getUser(uid)
    return String(user.displayName ?? '').trim() || String(user.email ?? '').trim() || fallbackEmail || uid
  }
  catch {
    return fallbackEmail || uid
  }
}
