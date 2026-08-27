import { requireSuperAdmin } from '~~/server/utils/workspace-auth'
import { fetchDailyMetric, fetchDatabaseLocation, MonitoringUnavailableError } from '~~/server/utils/gcp-monitoring'
import {
  computeFirebaseCost,
  enumerateTaipeiDays,
  forwardFill,
  FIRESTORE_FREE_TIER,
  FILE_STORAGE_FREE_GIB,
  FIRESTORE_PRICING,
  EGRESS_PER_GIB,
  ASSUMED_BYTES_PER_READ,
  type DayUsage,
} from '~~/server/utils/firestore-cost'
import { TAIPEI_OFFSET_MS, taipeiDateKey, taipeiMidnightAfter } from '~~/shared/taipei-day'

/**
 * GET /api/admin/super/infra-costs?period=YYYYMM
 *
 * 資料庫（Firebase）實際用量與費用，補上 /api/admin/super/costs 只算 AI 的缺口。
 * 數字來自 Cloud Monitoring 的真實用量指標，再依 Google 公開單價換算 —— 不是拖拉估的。
 *
 * 三態回報（`status`）：ok／unavailable。**查不到一律回 unavailable 帶原因，不可回 0**，
 * 否則畫面會把「讀取失敗」畫成「這個月沒花錢」（2026-08-09 腳本頁踩過同一個坑）。
 *
 * ⚠️ 只涵蓋本站所連的 Firebase 專案（雙租戶是兩個專案、各自部署，A 站看不到 B 站）。
 * ⚠️ 讀寫與儲存是量測值；**跨雲流量是唯一的估算項**（沒有用量指標可查，用讀取次數推），
 *    回傳時分成 `totals.measuredCostUsd`（量測）與 `totals.egressCostUsd`（估算）兩個欄位，
 *    畫面必須分開講，不可混成一個「實際花費」。
 */

const USD_TO_TWD = 32
const CACHE_TTL_MS = 10 * 60_000

type CacheEntry = { at: number; data: unknown }
const cache = new Map<string, CacheEntry>()

/**
 * YYYYMM → 該月台北 00:00 起訖。
 *
 * ⛔ **`end` 一定要落在台北午夜上**（本月就用「今天結束的那個午夜」，即使那是未來時間）。
 * Cloud Monitoring 的 alignmentPeriod 是**從 endTime 往回切**的：end 給「現在」的話，
 * 切出來是「每天 00:18 分界」的滾動 24 小時窗，標成日曆日會整批偏移一天
 * （2026-08-10 實測：8/4 的尖峰被標到 8/5）。未來的 endTime 是合法的，會回傳到目前為止的資料。
 */
function taipeiMonthRange(period: string) {
  const year = Number(period.slice(0, 4))
  const month = Number(period.slice(4, 6))
  const start = new Date(Date.UTC(year, month - 1, 1) - TAIPEI_OFFSET_MS)
  const nextMonth = new Date(Date.UTC(year, month, 1) - TAIPEI_OFFSET_MS)
  const now = new Date()
  const isCurrentMonth = nextMonth.getTime() > now.getTime()
  const end = isCurrentMonth ? taipeiMidnightAfter(now) : nextMonth
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { start, end, nextMonth, daysInMonth, isCurrentMonth }
}

export default defineEventHandler(async (event) => {
  await requireSuperAdmin(event)

  const config = useRuntimeConfig(event)
  const projectId = String(config.firebaseProjectId || '')
  const query = getQuery(event)
  const now = new Date()
  const fallbackPeriod = taipeiDateKey(now).slice(0, 7).replace('-', '')
  const period = String(query.period ?? fallbackPeriod).replace(/\D/g, '').slice(0, 6) || fallbackPeriod

  const cached = cache.get(period)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data

  const base = {
    period,
    projectId,
    usdToTwd: USD_TO_TWD,
    freeTier: { ...FIRESTORE_FREE_TIER, fileStorageGib: FILE_STORAGE_FREE_GIB },
  }

  if (!projectId) {
    return { ...base, status: 'unavailable' as const, reason: '伺服器未設定 Firebase 專案' }
  }

  const { start, end, daysInMonth, isCurrentMonth } = taipeiMonthRange(period)
  if (end.getTime() <= start.getTime()) {
    return { ...base, status: 'unavailable' as const, reason: '這個月份還沒開始' }
  }

  try {
    const [location, reads, writes, deletes, storage, fileStorage] = await Promise.all([
      fetchDatabaseLocation(projectId),
      fetchDailyMetric({ projectId, metricType: 'firestore.googleapis.com/document/read_count', start, end, aligner: 'ALIGN_SUM' }),
      fetchDailyMetric({ projectId, metricType: 'firestore.googleapis.com/document/write_count', start, end, aligner: 'ALIGN_SUM' }),
      fetchDailyMetric({ projectId, metricType: 'firestore.googleapis.com/document/delete_count', start, end, aligner: 'ALIGN_SUM' }),
      fetchDailyMetric({ projectId, metricType: 'firestore.googleapis.com/storage/data_and_index_storage_bytes', start, end, aligner: 'ALIGN_MEAN' }),
      fetchDailyMetric({ projectId, metricType: 'storage.googleapis.com/storage/v2/total_bytes', start, end, aligner: 'ALIGN_MEAN' }),
    ])

    const dayKeys = enumerateTaipeiDays(start, end)
    const storageFilled = forwardFill(dayKeys, storage)
    const fileFilled = forwardFill(dayKeys, fileStorage)

    const usage: DayUsage[] = dayKeys.map(day => ({
      day,
      reads: reads.get(day) ?? 0,
      writes: writes.get(day) ?? 0,
      deletes: deletes.get(day) ?? 0,
      storageBytes: storageFilled.get(day) ?? 0,
      fileBytes: fileFilled.get(day) ?? 0,
    }))

    // 完全沒有任何用量點＝指標還沒開始收集（新專案）或月份太久遠，別畫成「零花費」
    const hasAnySignal = usage.some(d => d.reads > 0 || d.writes > 0 || d.storageBytes > 0)
    if (!hasAnySignal) {
      return { ...base, status: 'unavailable' as const, reason: '這個月份查不到用量資料（可能超出 Google 的指標保留期）' }
    }

    const result = computeFirebaseCost(usage, { multiRegion: location.multiRegion, daysInMonth })
    const price = location.multiRegion ? FIRESTORE_PRICING.multiRegion : FIRESTORE_PRICING.regional

    const data = {
      ...base,
      status: 'ok' as const,
      location: location.locationId,
      multiRegion: location.multiRegion,
      // 估算流量用到的假設要一起回傳，畫面才講得出「依據是什麼」
      bytesPerRead: ASSUMED_BYTES_PER_READ,
      isCurrentMonth,
      daysInMonth,
      daysCounted: dayKeys.length,
      pricing: { ...price, egressPerGib: EGRESS_PER_GIB },
      days: result.days,
      totals: result.totals,
      topDays: result.topDays,
    }
    cache.set(period, { at: Date.now(), data })
    return data
  }
  catch (e) {
    const reason = e instanceof MonitoringUnavailableError ? e.message : String((e as Error)?.message ?? e).slice(0, 200)
    console.warn('[infra-costs] 讀取用量失敗:', reason)
    return { ...base, status: 'unavailable' as const, reason }
  }
})
