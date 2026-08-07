/**
 * 「這個網址還活著嗎」的存活探測。
 *
 * 用途：LINE 上登記的 Webhook／LIFF Endpoint 填的是舊網域時，「填錯但還能動」與
 * 「填錯而且已經連不上」是兩種嚴重度——前者黃牌（訊息還進得來），後者紅牌
 * （客人正在受影響）。LINE 的查詢 API 只講「有設定、有開啟」，網域死了它照樣回
 * 正常，所以要自己戳一下。
 *
 * 判定刻意寬鬆：只要對方有回任何 HTTP 狀態（含 3xx/4xx/5xx）就算活著——我們要抓的
 * 是「網域停掉／DNS 移除／憑證失效」這種整個斷掉的狀態，不是在驗頁面內容。
 * 失敗會重試一次：一次網路抖動就掛紅牌說「客人收不到」是狼來了。
 */

const REACHABLE_TIMEOUT_MS = 8000
const RETRY_DELAY_MS = 500

export async function isUrlReachable(url: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(REACHABLE_TIMEOUT_MS),
      })
      return true
    }
    catch {
      if (attempt === 0)
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
    }
  }
  return false
}
