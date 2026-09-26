import { getDb } from '~~/server/utils/firebase'
import { isValidNotifyLinkCode, NOTIFY_LINKS_COLLECTION, resolveNotifyRedirect } from '~~/server/utils/notify-links'

/**
 * GET /c/:code — LINE 通知裡的短網址（`C-270`，規則見 `server/utils/notify-links.ts`）。
 * 在 LINE 裡點：先轉回自己加上 `openExternalBrowser=1`，LINE 改用手機瀏覽器開，再轉去後台那一頁。
 * ⛔ 查不到、過期、打錯一律導去後台首頁，不顯示錯誤頁（跟推播點擊追蹤 `/api/r` 同一個做法）。
 */
export default defineEventHandler(async (event) => {
  const code = String(event.context.params?.code ?? '')
  const query = getQuery(event)
  const userAgent = getRequestHeader(event, 'user-agent') ?? ''
  let doc: { path?: unknown, createdAt?: unknown } | null = null
  if (isValidNotifyLinkCode(code)) {
    try {
      const snap = await getDb().collection(NOTIFY_LINKS_COLLECTION).doc(code).get()
      doc = snap.exists ? (snap.data() ?? null) : null
    }
    catch (err) {
      console.warn('[notify-links] lookup failed:', err)
    }
  }
  const dest = resolveNotifyRedirect({
    code,
    userAgent,
    hasExternalParam: query.openExternalBrowser === '1',
    doc,
    nowMs: Date.now(),
  })
  return sendRedirect(event, dest, 302)
})
