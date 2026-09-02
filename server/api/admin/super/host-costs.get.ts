import { requireSuperAdmin } from '~~/server/utils/workspace-auth'
import { fetchAwsCost, fetchAwsServiceUsage, AwsCostUnavailableError, type AwsUsageItem } from '~~/server/utils/aws-cost'

/**
 * GET /api/admin/super/host-costs?period=YYYYMM
 *
 * 主機（AWS）花費。與 AI／資料庫不同，這裡是 AWS 自己算好的**實際帳單金額**。
 * `totalCost` 是**原價**（不含折抵金），`creditTotal`／`netTotal` 讓畫面能講清楚
 * 「原價 − 折抵 ＝ 實付」——帳號還有折抵金時淨額是 0，只顯示淨額會被誤讀成沒花錢。
 *
 * `amplifyUsage` 是 Amplify 那一筆再往下拆的逐項用量（建置分鐘／執行時間／流量…）。
 * 2026-09-02 加的：Amplify 一家就佔帳單九成五，只給一個總數答不出「這是客人變多、
 * 還是我們一直推程式上線」——而這兩件事該做的事完全相反。
 *
 * 三態回報（`status`）：ok／unavailable，查不到一律帶原因、**不可回 0**
 * （沒接上 vs 這個月沒花錢，畫面上必須分得出來）。逐項用量另有自己的
 * `amplifyUsageReason`：主查詢成功但拆項失敗時要說得出來，不可以靜靜少一塊。
 *
 * ⚠️ Cost Explorer 每次查詢要 US$0.01 → 快取 12 小時（帳單資料一天才更新一次）。
 */

const USD_TO_TWD = 32
// 帳單一天更新一次，快取久一點；主要是為了不要每次重整都付 US$0.01。
// 2026-09-02 從 6 小時拉長到 12：拆項查詢讓每次冷載從 1 次變 2 次，拉長快取正好抵掉。
const CACHE_TTL_MS = 12 * 60 * 60_000

/** 需要再往下拆用量的服務——只有 Amplify 值得多付一次查詢費（它佔帳單九成五） */
const ITEMIZED_SERVICE = 'AWS Amplify'

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
    // 兩支查詢一起打：拆項失敗不可以拖垮主帳單（少一塊 ≠ 整頁掛掉），
    // 但也不可以靜靜消失——失敗時把原因一起回給畫面講。
    const [res, usage] = await Promise.all([
      fetchAwsCost(start, end),
      fetchAwsServiceUsage(ITEMIZED_SERVICE, start, end)
        .then(items => ({ items, reason: '' }))
        .catch((e: unknown) => {
          const reason = e instanceof AwsCostUnavailableError ? e.message : String((e as Error)?.message ?? e).slice(0, 200)
          console.warn('[host-costs] 讀取 Amplify 逐項用量失敗:', reason)
          return { items: null as AwsUsageItem[] | null, reason }
        }),
    ])
    const data = {
      ...base,
      status: 'ok' as const,
      isCurrentMonth,
      currency: res.currency,
      totalCost: res.totalCost,
      creditTotal: res.creditTotal,
      netTotal: res.netTotal,
      services: res.services,
      days: res.days,
      itemizedService: ITEMIZED_SERVICE,
      /** null＝這次拆不開（原因見 amplifyUsageReason），⛔ 不可與「空陣列＝真的沒用量」混為一談 */
      amplifyUsage: usage.items,
      amplifyUsageReason: usage.reason,
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
