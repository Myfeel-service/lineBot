import { requireSuperAdmin } from '~~/server/utils/workspace-auth'
import { fetchDailyMetric, fetchDatabaseLocation, MonitoringUnavailableError } from '~~/server/utils/gcp-monitoring'
import {
  computeFirebaseCost,
  forwardFill,
  FIRESTORE_FREE_TIER,
  FILE_STORAGE_FREE_GIB,
  FIRESTORE_PRICING,
  EGRESS_PER_GIB,
  ASSUMED_BYTES_PER_READ,
  type DayUsage,
} from '~~/server/utils/firestore-cost'
import {
  billingDateKey,
  billingDayTaipeiSpan,
  billingMidnightAfter,
  billingMonthStart,
  enumerateBillingDays,
} from '~~/shared/google-billing-day'
import { USD_TO_TWD } from '~~/shared/usd-twd'

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
 * ⚠️ **「日」與「月」一律用 Google 帳單的切法（太平洋時間）**，不是台北：這張卡的工作是
 *    預告帳單，切法跟帳單不一樣就永遠對不上（2026-09-07 老闆比對主控台抓到，原委見
 *    `shared/google-billing-day.ts`）。同一個 `period` 在 AI 那張卡是台北月、在主機那張卡
 *    是 AWS 的月，三張卡的月界本來就不同——畫面要講出來，不要假裝是同一個窗。
 */

const CACHE_TTL_MS = 10 * 60_000

type CacheEntry = { at: number; data: unknown }
const cache = new Map<string, CacheEntry>()

/**
 * YYYYMM → 該**帳單月**（太平洋時間）的起訖。
 *
 * ⛔ **`end` 一定要落在太平洋午夜上**（本月就用「今天結束的那個午夜」，即使那是未來時間）。
 * Cloud Monitoring 的 alignmentPeriod 是**從 endTime 往回切**的：end 給「現在」的話，
 * 切出來是「每天 00:18 分界」的滾動 24 小時窗，標成日曆日會整批偏移一天
 * （2026-08-10 實測：8/4 的尖峰被標到 8/5）。未來的 endTime 是合法的，會回傳到目前為止的資料。
 */
function billingMonthRange(period: string) {
  const year = Number(period.slice(0, 4))
  const month = Number(period.slice(4, 6))
  const start = billingMonthStart(year, month)
  const nextMonth = billingMonthStart(year, month + 1)
  const now = new Date()
  const isCurrentMonth = nextMonth.getTime() > now.getTime()
  const end = isCurrentMonth ? billingMidnightAfter(now) : nextMonth
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { start, end, nextMonth, daysInMonth, isCurrentMonth }
}

export default defineEventHandler(async (event) => {
  await requireSuperAdmin(event)

  const config = useRuntimeConfig(event)
  const projectId = String(config.firebaseProjectId || '')
  const query = getQuery(event)
  const now = new Date()
  // 預設月份也用帳單日曆：台灣 9/1 凌晨打開這頁時，Google 那邊還是八月
  const fallbackPeriod = billingDateKey(now).slice(0, 7).replace('-', '')
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

  const { start, end, daysInMonth, isCurrentMonth } = billingMonthRange(period)
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

    const dayKeys = enumerateBillingDays(start, end)
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
      /**
       * 「Google 的一天」在台灣是幾點換日——夏令／冬令時不一樣（下午 3 點／4 點），
       * 所以由後端當場算、不要在前端寫死一個季節才對的數字。
       */
      dayBoundaryTaipei: billingDayTaipeiSpan(dayKeys[dayKeys.length - 1] ?? billingDateKey(now)).from
        .replace(/^\d+\/\d+\s*/, ''),
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
