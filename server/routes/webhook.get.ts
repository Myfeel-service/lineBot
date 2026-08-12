/**
 * Messaging API Webhook 僅應接收 LINE 伺服器的 POST。
 * 若 LIFF 的 Endpoint URL 誤設成與 Webhook 相同路徑，使用者的瀏覽器會 GET /webhook?liff.state=…
 * 並得到 Nuxt 404；此處轉到活動 LIFF 頁並保留 query。
 */
import { LEAD_PATH } from '~~/shared/liff-lead-path'

export default defineEventHandler((event) => {
  const url = getRequestURL(event)
  const dest = `${LEAD_PATH}${url.search || ''}`
  return sendRedirect(event, dest, 302)
})
