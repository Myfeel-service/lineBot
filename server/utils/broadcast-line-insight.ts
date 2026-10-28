import { HTTPFetchError } from '@line/bot-sdk'
import { getInsightClient } from '~~/server/utils/line'
import { broadcastAggregationUnit } from '~~/shared/broadcast-insight'

/** Asia/Tokyo 日曆日 yyyyMMdd（LINE aggregation API 使用 UTC+9） */
export function toTokyoYyyyMMdd(d: Date): string {
  const s = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
  return s.replace(/-/g, '')
}

/**
 * LINE 單次查詢 from～to 不可超過約 30 日；自發送日起至今日（東京）取交集。
 * 結束日會多留「東京的明日」，避免剛發送完當日邊界尚未進彙總。
 */
export function broadcastInsightQueryRange(
  startedAt: Date | null,
  completedAt: Date | null,
): { from: string; to: string } {
  const anchor = startedAt ?? completedAt ?? new Date()
  const end = new Date()
  const maxSpanMs = 29 * 86400000
  let startMs = anchor.getTime()
  if (end.getTime() - startMs > maxSpanMs) startMs = end.getTime() - maxSpanMs
  const from = toTokyoYyyyMMdd(new Date(startMs))
  /** 結束日加約 1.5 天緩衝：剛發送後 LINE 彙總有時尚未落在「當天」統計 */
  const endMs = Math.max(end.getTime(), startMs) + 36 * 60 * 60 * 1000
  const to = toTokyoYyyyMMdd(new Date(endMs))
  if (from > to) return { from: to, to: from }
  return { from, to }
}

type InsightOverview = { uniqueImpression?: number | null; uniqueClick?: number | null }
type InsightMsg = { uniqueImpression?: number | null }
type InsightClick = { uniqueClick?: number | null; uniqueClickOfRequest?: number | null }

function pickUniqueImpression(overview: InsightOverview | undefined, messages: InsightMsg[] | undefined): number | null {
  const o = overview?.uniqueImpression
  if (typeof o === 'number') return o
  for (const m of messages ?? []) {
    const v = m?.uniqueImpression
    if (typeof v === 'number') return v
  }
  return null
}

function pickUniqueClick(
  overview: InsightOverview | undefined,
  clicks: InsightClick[] | undefined,
): number | null {
  const o = overview?.uniqueClick
  if (typeof o === 'number') return o
  for (const c of clicks ?? []) {
    const v = c?.uniqueClick ?? c?.uniqueClickOfRequest
    if (typeof v === 'number') return v
  }
  return null
}

export async function fetchBroadcastLineInsight(
  campaignId: string,
  workspaceId: string,
  unit: string | null | undefined,
  startedAt: Date | null,
  completedAt: Date | null,
  /**
   * `D-154`②③：用 narrowcast 送的推播沒有彙總單位，改拿 LINE 給的那一則編號問
   * （`getMessageEvent`，LINE 給的是同一種「打開的人／點連結的人」）。有這個就不看 unit。
   */
  lineRequestId?: string | null,
): Promise<{
  lineUniqueImpression: number | null
  lineUniqueClick: number | null
  lineInsightError?: string
}> {
  const requestId = String(lineRequestId || '').trim()
  if (requestId) {
    try {
      const insight = await getInsightClient(workspaceId)
      const res = await insight.getMessageEvent(requestId)
      const imp = pickUniqueImpression(res.overview as InsightOverview | undefined, res.messages as InsightMsg[] | undefined)
      const clk = pickUniqueClick(res.overview as InsightOverview | undefined, res.clicks as InsightClick[] | undefined)
      return {
        lineUniqueImpression: typeof imp === 'number' ? imp : null,
        lineUniqueClick: typeof clk === 'number' ? clk : null,
      }
    }
    catch (e: unknown) {
      const msg = e instanceof HTTPFetchError ? `${e.status} ${e.body || e.message}`.trim() : e instanceof Error ? e.message : 'insight_failed'
      console.warn('[broadcast-line-insight] requestId', requestId, msg)
      return { lineUniqueImpression: null, lineUniqueClick: null, lineInsightError: msg }
    }
  }

  let u = (unit || broadcastAggregationUnit(campaignId)).trim()
  /** LINE 僅接受 1～30 字元；舊版若曾寫入過長字串則改以 campaignId 雜湊查詢 */
  if (u.length > 30) u = broadcastAggregationUnit(campaignId)
  if (!u) {
    return { lineUniqueImpression: null, lineUniqueClick: null, lineInsightError: 'no_unit' }
  }
  const { from, to } = broadcastInsightQueryRange(startedAt, completedAt)
  console.log(`[broadcast-line-insight] unit="${u}" (len=${u.length}) from=${from} to=${to}`)
  try {
    const insight = await getInsightClient(workspaceId)
    const res = await insight.getStatisticsPerUnit(u, from, to)
    const imp = pickUniqueImpression(res.overview, res.messages)
    const clk = pickUniqueClick(res.overview, res.clicks)
    return {
      lineUniqueImpression: typeof imp === 'number' ? imp : null,
      lineUniqueClick: typeof clk === 'number' ? clk : null,
    }
  }
  catch (e: unknown) {
    let msg = 'insight_failed'
    if (e instanceof HTTPFetchError) {
      msg = `${e.status} ${e.body || e.message}`.trim()
    }
    else if (e instanceof Error) {
      msg = e.message
    }
    console.warn('[broadcast-line-insight]', u, from, to, msg)
    return {
      lineUniqueImpression: null,
      lineUniqueClick: null,
      lineInsightError: msg,
    }
  }
}
