import { requireSuperAdmin } from '~~/server/utils/workspace-auth'
import { fetchAwsCost, AwsCostUnavailableError } from '~~/server/utils/aws-cost'

/**
 * GET /api/admin/super/host-costs?period=YYYYMM
 *
 * 主機（AWS）花費。與 AI／資料庫不同，這裡是 AWS 自己算好的**實際帳單金額**。
 *
 * 三態回報（`status`）：ok／unavailable，查不到一律帶原因、**不可回 0**
 * （沒接上 vs 這個月沒花錢，畫面上必須分得出來）。
 *
 * ⚠️ Cost Explorer 每次查詢要 US$0.01 → 快取 6 小時（帳單資料一天才更新一次）。
 */

const USD_TO_TWD = 32
// 帳單一天更新一次，快取久一點；主要是為了不要每次重整都付 US$0.01
const CACHE_TTL_MS = 6 * 60 * 60_000

type CacheEntry = { at: number; data: unknown }
const cache = new Map<string, CacheEntry>()

const ymd = (d: Date) => d.toISOString().slice(0, 10)

/**
 * YYYYMM → Cost Explorer 的查詢區間（UTC 日，End 不含當日）。
 * 本月查到「明天」，才會包含今天已產生的部分；過去的月份就整月。
 */
function monthRange(period: string) {
  const year = Number(period.slice(0, 4))
  const month = Number(period.slice(4, 6))
  const start = new Date(Date.UTC(year, month - 1, 1))
  const nextMonth = new Date(Date.UTC(year, month, 1))
  const now = new Date()
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
  const isCurrentMonth = nextMonth.getTime() > now.getTime()
  const end = isCurrentMonth ? tomorrow : nextMonth
  return { start: ymd(start), end: ymd(end), isCurrentMonth, valid: end.getTime() > start.getTime() }
}

export default defineEventHandler(async (event) => {
  await requireSuperAdmin(event)

  const query = getQuery(event)
  const now = new Date()
  const fallbackPeriod = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  const period = String(query.period ?? fallbackPeriod).replace(/\D/g, '').slice(0, 6) || fallbackPeriod

  const cached = cache.get(period)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data

  const base = { period, usdToTwd: USD_TO_TWD }
  const { start, end, isCurrentMonth, valid } = monthRange(period)
  if (!valid) return { ...base, status: 'unavailable' as const, reason: '這個月份還沒開始' }

  try {
    const res = await fetchAwsCost(start, end)
    const data = {
      ...base,
      status: 'ok' as const,
      isCurrentMonth,
      currency: res.currency,
      totalCost: res.totalCost,
      services: res.services,
      days: res.days,
    }
    cache.set(period, { at: Date.now(), data })
    return data
  }
  catch (e) {
    const reason = e instanceof AwsCostUnavailableError ? e.message : String((e as Error)?.message ?? e).slice(0, 200)
    console.warn('[host-costs] 讀取 AWS 花費失敗:', reason)
    return { ...base, status: 'unavailable' as const, reason }
  }
})
