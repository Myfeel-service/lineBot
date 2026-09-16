import { requireFirebaseAuth } from '~~/server/utils/admin-auth'
import { getDb } from '~~/server/utils/firebase'
import { ADMIN_USER_PREFS_COLLECTION, readSeenTours } from '~~/server/utils/admin-user-prefs'

/**
 * GET /api/admin/tour-seen
 * 回傳「這個帳號已經自動跑過哪幾頁的導覽」。
 *
 * ⛔ 為什麼記在後端不記瀏覽器（2026-09-16 拍板）：舊的一次性提示記在 localStorage，
 *    那是「這台瀏覽器看過了」不是「這個帳號看過了」。實際會壞的三種情況——
 *    老闆用辦公室電腦看完，下午會計用同一台電腦登入自己的帳號就再也看不到；
 *    同一個人早上用電腦晚上用手機，每頁再跳一次；清快取或無痕，全部重跳。
 *
 * 刻意不分官方帳號（workspace）：導覽內容跟你在哪一家無關，同一個人不該因為
 * 多開一個官方帳號就把 21 頁的導覽再被帶一遍。
 */
export default defineEventHandler(async (event) => {
  const decoded = await requireFirebaseAuth(event)
  const snap = await getDb().collection(ADMIN_USER_PREFS_COLLECTION).doc(decoded.uid).get()
  return { seen: Object.keys(readSeenTours(snap.exists ? snap.data() : null)) }
})
