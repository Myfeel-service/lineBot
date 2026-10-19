/**
 * 對話頁一打開就要直接開哪一位客人（`D-105`，2026-10-19）。
 *
 * LINE 通知裡的「打開這段對話」短網址，轉過來就是 `/admin/{wid}/conversations?userId=U…`
 * （`server/utils/notify-links.ts` 的 `conversationPath`）。手機上一次只看一邊（清單或對話），
 * 頁面要在**第一個畫面**就知道「這次是來看某一位的」，才能直接停在對話那一邊、不先閃一下清單。
 *
 * 帶了會話分頁（`?tab=pending_human` 這種，統計頁下鑽）的照舊：那種是來看清單的，
 * 而且頁面只在「全部」分頁才會照 `?userId=` 直接選人（見 AdminPanel 的 onMounted）。
 */
function pick(v: unknown): string {
  return String((Array.isArray(v) ? v[0] : v) ?? '').trim()
}

export function deepLinkUserIdFromQuery(query: Record<string, unknown>): string {
  const tab = pick(query.tab)
  if (tab && tab !== 'all') return ''
  return pick(query.userId)
}
