import { getDb, getFirebaseAuth } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'

/**
 * GET /api/conversations/assignees — 可以被指派為「負責人員」的同事（G-27 功能缺口②）
 *
 * Response: { members: Array<{ uid, name, email, role }> }
 *
 * 為什麼不共用 `/api/admin/workspaces/:id/members`：那支是成員管理頁用的，
 * 會一併回待加入邀請、組織管理員、擁有者登記等**還不能被指派的人**（沒有 uid），
 * 塞進指派選單只會讓人選了才發現指派不了。這支只回「已經有帳號、而且回得了訊息」的人。
 *
 * ⛔ viewer 不列進去：他們連送訊息的權限都沒有，指派給他們等於把線丟進黑洞。
 */
const ASSIGNABLE_ROLES = new Set(['owner', 'admin', 'agent'])

export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')

  const db = getDb()
  const snap = await db.collection('workspaceMembers')
    .where('workspaceId', '==', workspaceId)
    .get()

  const rows = snap.docs
    .map(d => d.data())
    .filter(m => String(m.uid ?? '').trim() && ASSIGNABLE_ROLES.has(String(m.role ?? '')))

  if (!rows.length) return { members: [] }

  // 名字只有 Firebase Auth 有（workspaceMembers 只存 uid/role/email）。
  // 成員數是個位數到數十，一次 getUsers 打完；查不到的人退回 email，不要整列消失。
  const auth = getFirebaseAuth()
  const authById: Record<string, { name: string; email: string }> = {}
  try {
    const res = await auth.getUsers(rows.map(m => ({ uid: String(m.uid) })))
    for (const u of res.users) {
      authById[u.uid] = {
        name: String(u.displayName ?? '').trim(),
        email: String(u.email ?? '').trim(),
      }
    }
  }
  catch (e: unknown) {
    // ⛔ 查不到不要回空陣列假裝「這個帳號沒有同事」（08-09「查不到≠沒問題」）：
    //    照樣把成員列出來，名字退回 workspaceMembers 上存的 email。
    console.warn('[assignees] Auth 查名字失敗，改用 email:', String((e as Error)?.message ?? e).slice(0, 200))
  }

  const members = rows.map((m) => {
    const uid = String(m.uid)
    const fallbackEmail = String(m.invitedEmail ?? '').trim()
    const email = authById[uid]?.email || fallbackEmail
    return {
      uid,
      name: authById[uid]?.name || email || uid,
      email,
      role: String(m.role ?? ''),
    }
  })

  members.sort((a, b) => a.name.localeCompare(b.name, 'zh-TW'))
  return { members }
})
