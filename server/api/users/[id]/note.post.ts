import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { lineUserFirestoreDocId, lineUserIdFromFirestoreDocId } from '~~/shared/line-workspace'
import { isEmptyCustomerNote, normalizeCustomerNote } from '~~/shared/customer-note'

/**
 * POST /api/users/:id/note — 存客人備註（G-27 功能缺口①）
 *
 * Body: { text: string }
 * Response: { text, updatedByName, updatedAtMs }
 *
 * 存在 `users/{docId}` 自己身上（不開子集合）：一位客人一則、每次覆蓋，
 * 讀的時候本來就會撈這份 user 文件（detail 端點），等於零額外讀取。
 *
 * ⛔ 這個欄位**永遠不會進入送給客人的任何路徑**——它只被後台的 detail 端點讀。
 * ⛔ 清空備註要用 FieldValue.delete() 把欄位整組拿掉，不要留一個空字串：
 *    留著的話「誰在什麼時候寫的」會變成一筆指向空內容的假紀錄。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, token } = await requireWorkspaceAccess(event, 'agent')

  const userIdParam = getRouterParam(event, 'id')
  if (!userIdParam) throw createError({ statusCode: 400, statusMessage: 'userId is required' })
  const fsUserDocId = lineUserFirestoreDocId(lineUserIdFromFirestoreDocId(userIdParam, workspaceId), workspaceId)

  const body = await readBody(event)
  const text = normalizeCustomerNote(body?.text)

  const db = getDb()
  const userRef = db.collection('users').doc(fsUserDocId)
  const userSnap = await userRef.get()
  if (!userSnap.exists || userSnap.data()?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到此使用者' })
  }

  if (isEmptyCustomerNote(text)) {
    await userRef.update({
      note: FieldValue.delete(),
      noteUpdatedByName: FieldValue.delete(),
      noteUpdatedAt: FieldValue.delete(),
    })
    return { text: '', updatedByName: '', updatedAtMs: 0 }
  }

  // 同 send.post.ts 的寫法：有名字用名字，沒有就退回 email（兩者都沒有才空）
  const updatedByName = String(token.name || token.email || '').trim()
  const now = new Date()
  await userRef.update({
    note: text,
    noteUpdatedByName: updatedByName,
    noteUpdatedAt: now,
  })

  return { text, updatedByName, updatedAtMs: now.getTime() }
})
