import { getInsightClient } from '~~/server/utils/line'
import type { LineFollowerDay } from '~~/shared/friend-report'

/**
 * 跟 LINE 要「好友數／封鎖數」逐日的數字（`D-155` 好友統計最上面兩格＋推播那天封鎖幾位）。
 *
 * - 唯讀、不吃訊息則數（Messaging API 的 insight `GET /v2/bot/insight/followers?date=`）。
 * - 日期是**日本時間**（LINE 的日界）；每天一次查詢，一份報告約 31 次。
 * - ⚠️ `followers` 是**累計加過好友的人次**，封鎖了也不會減（2026-10-28 MYFEEL 121,370，跟 LINE 官方後台一致）。
 *   ⛔ 不可以拿它減封鎖說成「收得到訊息的人」，LINE 沒保證這樣減得出來。
 * - 某天 LINE 回 `unready`（隔天才算好）或問失敗：那天回 `null`，⛔ 不補 0。
 */

/** 同時問幾天（一份報告約 31 天，一次全丟出去不必要） */
const CONCURRENCY = 6

export interface FollowerDaysResult {
  /** no_token＝這個帳號還沒接 LINE；failed＝每一天都問不到 */
  status: 'ok' | 'no_token' | 'failed'
  byDate: Record<string, LineFollowerDay | null>
}

/** `dates` 是日本時間的 YYYY-MM-DD */
export async function fetchFollowerDays(workspaceId: string, dates: readonly string[]): Promise<FollowerDaysResult> {
  const byDate: Record<string, LineFollowerDay | null> = {}
  let client: Awaited<ReturnType<typeof getInsightClient>>
  try {
    client = await getInsightClient(workspaceId)
  }
  catch (e) {
    console.warn('[line-follower-insight] 沒有 LINE 憑證：', workspaceId, String((e as Error)?.message ?? e).slice(0, 120))
    for (const d of dates) byDate[d] = null
    return { status: 'no_token', byDate }
  }

  let errors = 0
  const queue = [...dates]
  async function worker() {
    for (let d = queue.shift(); d !== undefined; d = queue.shift()) {
      try {
        const r = await client.getNumberOfFollowers(d.replace(/-/g, ''))
        byDate[d] = r.status === 'ready' && typeof r.followers === 'number' && typeof r.blocks === 'number'
          ? { followers: r.followers, blocks: r.blocks }
          : null
      }
      catch (e) {
        errors++
        byDate[d] = null
        if (errors === 1) console.warn('[line-follower-insight] 問 LINE 失敗：', workspaceId, d, String((e as Error)?.message ?? e).slice(0, 160))
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, dates.length) }, worker))
  return { status: dates.length && errors === dates.length ? 'failed' : 'ok', byDate }
}
