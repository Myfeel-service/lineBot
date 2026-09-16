import { FieldValue } from 'firebase-admin/firestore'
import { requireFirebaseAuth } from '~~/server/utils/admin-auth'
import { getDb } from '~~/server/utils/firebase'
import {
  ADMIN_USER_PREFS_COLLECTION,
  isValidSeenTourKey,
  readSeenTours,
  withSeenTour,
} from '~~/server/utils/admin-user-prefs'

/**
 * POST /api/admin/tour-seen  { key: 'broadcasts' }
 * 記下「這個帳號已經被自動帶過這一頁的導覽」。詳見 GET 端與 admin-user-prefs.ts。
 */
export default defineEventHandler(async (event) => {
  const decoded = await requireFirebaseAuth(event)
  const body = await readBody<{ key?: unknown }>(event)
  const key = typeof body?.key === 'string' ? body.key.trim() : ''
  if (!isValidSeenTourKey(key))
    throw createError({ statusCode: 400, statusMessage: 'Invalid key' })

  const ref = getDb().collection(ADMIN_USER_PREFS_COLLECTION).doc(decoded.uid)
  const snap = await ref.get()
  const prev = readSeenTours(snap.exists ? snap.data() : null)
  // 已經記過就不重寫：同一頁重新整理很多次是常態，沒必要每次都動到文件
  if (prev[key])
    return { ok: true }

  // ⛔ 整包寫回、不要用 `seenTours.${key}` 這種欄位路徑：鑰匙裡有 `|`，而欄位路徑的
  //    分隔符是點——一旦哪天有人在鑰匙裡放進點，寫進去的就是巢狀結構而不是一個鍵。
  await ref.set(
    { seenTours: withSeenTour(prev, key, Date.now()), updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  )
  return { ok: true }
})
