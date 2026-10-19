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
 * 取**倒數第二格**：正式站是 AWS Amplify Hosting，前面是 CloudFront；CloudFront 會把
 * 「連到它的那個位址」**接在**這個標頭的最後面，客人自己帶的舊值原封不動留在前面；
 * Amplify 內部再往後接一格（CloudFront 節點自己的位址，很多訪客共用）。
 * 所以客人能控制的只有左邊，倒數第二格是 CloudFront 親眼看到的連線來源。
 *
 * ⛔ 2026-10-19 線上實測（`G-110`）：沒帶這個標頭的請求打到 Lambda 時是 **2 格**、自己帶一格假的是 3 格
 * ——以前取最右邊，拿到的是 CloudFront 節點位址＝同一個節點後面的訪客共用一份額度（官網留名單會誤擋）。
 * 後面接幾格寫在 `TRUSTED_TRAILING_HOPS`；`/api/warmup` 每次回報實際格數，對不上會留一行 log。
 *
 * 格數比預期少（本機 dev 自己帶一格之類）就取最左邊那格；沒有這個標頭回空字串，呼叫端改用連線位址。
 */
export function clientIpFromForwardedFor(xff: string | null | undefined): string {
  const hops = forwardedForHops(xff)
  return hops[Math.max(0, hops.length - 1 - TRUSTED_TRAILING_HOPS)] ?? ''
}

/**
 * CloudFront 之後還會往 `X-Forwarded-For` 後面接幾格（Amplify 內部那一跳）。
 * 沒帶這個標頭的請求走公開網址進來，Lambda 看到的格數＝這個值 + 1（CloudFront 自己那格）。
 */
export const TRUSTED_TRAILING_HOPS = 1

/**
 * `X-Forwarded-For` 拆成一格一格（去空白、丟空格）。
 *
 * 另外給 `/api/warmup` 回報**格數**用（2026-09-30 code review）：子保溫是從 Lambda 走公開網址打回來的、
 * 自己沒帶這個標頭——看到的格數＝`TRUSTED_TRAILING_HOPS + 1` 才對；不一樣＝前面的代理換了，
 * 節流 key 會變成大家共用（格數變多）或客人自己帶的值（格數變少）。
 */
export function forwardedForHops(xff: string | null | undefined): string[] {
  return String(xff || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

/** 節流用的來源位址：`X-Forwarded-For` 倒數第二格 → 連線位址 → `'unknown'`（⛔ 永遠不回空字串，免得所有人共用一個空 key 還看不出來） */
export function rateLimitClientIp(event: H3Event): string {
  const forwarded = event.node?.req?.headers?.['x-forwarded-for']
  const fromHeader = clientIpFromForwardedFor(Array.isArray(forwarded) ? forwarded.join(',') : forwarded)
  return fromHeader || event.node?.req?.socket?.remoteAddress || 'unknown'
}
