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
  //
  // ⛔ **而且不能用 `set(..., { merge: true })`**（2026-09-16 code review 抓到）：
  //    merge 對 map 欄位是**逐鍵合併**，`withSeenTour` 砍掉的那幾把舊鑰匙不會出現在
  //    payload 裡，Firestore 就原封不動留著它們——200 筆上限形同虛設，文件會一直長大，
  //    連 `readSeenTours` 丟掉的壞資料也永遠清不掉。
  //    `update()` 對 map 欄位是**整個取代**，正是這裡要的語意；文件還不存在時才用 set 建。
  const seenTours = withSeenTour(prev, key, Date.now())
  const payload = { seenTours, updatedAt: FieldValue.serverTimestamp() }
  if (snap.exists) {
    // 極罕見：這中間文件被刪掉 → update 會失敗，退回建立一份
    await ref.update(payload).catch(() => ref.set(payload))
  }
  else {
    await ref.set(payload)
  }
  return { ok: true }
})
