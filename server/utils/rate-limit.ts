import type { H3Event } from 'h3'
import { capMapSize } from './bounded-cache'

/**
 * 公開（或只要登入就能打）端點共用的節流（`G-105`）。
 *
 * 為什麼要有：`/api/onboarding/events`（任何 Google 帳號）、`/api/liff/lead-error`（不用登入）
 * 原本不限次數，每打一次就是一筆 Firestore 寫入——拿來灌寫入費不需要任何權限。
 * `/api/leads` 原本自己寫了一份，但 key 沒上限、每個 key 底下的時間戳也沒上限（猛送就一直長）。
 *
 * 性質：**best-effort**，跟 `agent-rate-limit.ts` 同款——模組級 Map 只在同一個暖啟動的
 * Lambda 實例內有效。擋的是「同一個來源連續猛送」，⛔ 不是跨實例的精準配額。
 *
 * 做法：每個 key 一個固定視窗（從第一次打進來開始算），視窗內最多給 `max` 個名額。
 * - 記的是「給出去的名額」而不是每一次請求的時間戳：一個 key 只佔一個小物件，
 *   ⛔ 不會因為被猛打而把陣列養胖。
 * - key 的數量用 `capMapSize` 壓住：換 key 猛打（例如亂編 IP）最多擠掉別人的計數＝那些人
 *   多拿到一個新視窗，⛔ 不會讓記憶體無上限成長。
 */
export interface RateLimitResult {
  /** 這次實際給了幾個名額（`cost` 超過剩餘額度時只給得出剩下的） */
  granted: number
  /** 有沒有少給（granted < cost） */
  limited: boolean
  /** 還要等多久才會換新視窗；⛔ 沒被擋時是 0 */
  retryAfterMs: number
  /**
   * 這是這個視窗裡**第一次**少給。呼叫端拿來決定要不要留一行 log：
   * 被擋下來的要說得出丟了什麼（記憶 `feedback_filters_must_report_what_they_dropped`），
   * ⛔ 但每一次都記的話，猛打的人就順便幫我們灌 log。
   */
  firstRejection: boolean
}

export interface RateLimiter {
  take(key: string, cost?: number, now?: number): RateLimitResult
  /** 測試用：清掉累積的計數 */
  reset(): void
}

export function createRateLimiter(opts: { windowMs: number, max: number, maxKeys?: number }): RateLimiter {
  const { windowMs, max } = opts
  const maxKeys = opts.maxKeys ?? 5000
  const buckets = new Map<string, { windowStart: number, used: number, rejected: number }>()

  return {
    take(key, cost = 1, now = Date.now()) {
      const want = Math.max(0, Math.floor(Number(cost) || 0))
      let b = buckets.get(key)
      if (!b || now - b.windowStart >= windowMs) {
        // 換新視窗時先刪再放：Map 的順序＝插入順序，這樣 capMapSize 淘汰的永遠是最久沒開新視窗的
        buckets.delete(key)
        b = { windowStart: now, used: 0, rejected: 0 }
        buckets.set(key, b)
        capMapSize(buckets, maxKeys)
      }
      const granted = Math.min(want, Math.max(0, max - b.used))
      b.used += granted
      const limited = granted < want
      if (limited) b.rejected++
      return {
        granted,
        limited,
        retryAfterMs: limited ? Math.max(0, b.windowStart + windowMs - now) : 0,
        firstRejection: limited && b.rejected === 1,
      }
    },
    reset() {
      buckets.clear()
    },
  }
}

/**
 * 從 `X-Forwarded-For` 挑出「拿來當節流 key」的那個位址（純函式）。
 *
 * ⛔ **不用 h3 的 `getRequestIP(event, { xForwardedFor: true })`**：它取的是**最左邊**那一格
 * （h3 1.15：`split(",").shift()`），而最左邊是客人自己帶上來的——每次換一個亂編的值，
 * 節流就等於沒有（`G-105`）。
 *
 * 取**最右邊**那一格：正式站是 AWS Amplify Hosting，前面是 CloudFront；CloudFront 會把
 * 「連到它的那個位址」**接在**這個標頭的最後面，客人自己帶的舊值原封不動留在前面。
 * 所以客人能控制的只有左邊，最右邊是 CloudFront 親眼看到的連線來源。
 *
 * ⚠️ 前提是 CloudFront 之後沒有別的代理再往後接一格。若 Amplify 內部又多接一跳，最右邊會
 * 變成那一跳的位址（很多人共用）＝節流變成「同一個入口一起算」：擋得比較兇，但**不會被繞過**。
 * 所以各端點的上限都刻意留寬（見各自的說明）。
 *
 * 沒有這個標頭（本機 dev、直連）回空字串，呼叫端改用連線位址。
 */
export function clientIpFromForwardedFor(xff: string | null | undefined): string {
  const hops = String(xff || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  return hops[hops.length - 1] ?? ''
}

/** 節流用的來源位址：`X-Forwarded-For` 最右邊 → 連線位址 → `'unknown'`（⛔ 永遠不回空字串，免得所有人共用一個空 key 還看不出來） */
export function rateLimitClientIp(event: H3Event): string {
  const forwarded = event.node?.req?.headers?.['x-forwarded-for']
  const fromHeader = clientIpFromForwardedFor(Array.isArray(forwarded) ? forwarded.join(',') : forwarded)
  return fromHeader || event.node?.req?.socket?.remoteAddress || 'unknown'
}
