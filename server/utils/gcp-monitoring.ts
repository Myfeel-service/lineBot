import { GoogleAuth } from 'google-auth-library'
import { taipeiDateKey } from '~~/shared/taipei-day'

/**
 * Cloud Monitoring 用量查詢（給超管成本頁用）。
 *
 * 用的是既有的 Firebase service account（`FIREBASE_CLIENT_EMAIL`／`FIREBASE_PRIVATE_KEY`），
 * 不必另外開帳號：它預設就有 `monitoring.viewer`。2026-08-09 實測 timeSeries.list 可讀，
 * 但 `metricDescriptors.get` 會 403 —— 所以這裡只用 timeSeries，不要去讀 descriptor。
 *
 * ⚠️ 只查得到「這套系統自己連的那個 Firebase 專案」。雙租戶是兩個獨立專案、
 * 各自部署各自的憑證，A 站看不到 B 站的用量（要看就到 B 站的後台看）。
 */

let cachedAuth: GoogleAuth | undefined

export class MonitoringUnavailableError extends Error {}

function getAuth(): GoogleAuth {
  const config = useRuntimeConfig()
  const clientEmail = String(config.firebaseClientEmail || '')
  const privateKey = String(config.firebasePrivateKey || '')
  if (!clientEmail || !privateKey)
    throw new MonitoringUnavailableError('伺服器未設定 Firebase 憑證，無法讀取用量')

  if (!cachedAuth) {
    cachedAuth = new GoogleAuth({
      credentials: { client_email: clientEmail, private_key: privateKey.replace(/\\n/g, '\n') },
      scopes: ['https://www.googleapis.com/auth/monitoring.read'],
    })
  }
  return cachedAuth
}

/** 把 Google API 的錯誤翻成看得懂的原因（權限／API 未啟用是最常見的兩種） */
function describeError(e: any): string {
  const msg = String(e?.response?.data?.error?.message || e?.message || e)
  if (/API has not been used|is disabled/i.test(msg)) return 'Google Cloud Monitoring API 尚未啟用'
  if (/permission|denied|forbidden/i.test(msg)) return '服務帳號沒有讀取用量的權限（需 monitoring.viewer）'
  return msg.slice(0, 200)
}

/**
 * 撈一支指標的每日序列，回傳 `台北日期 → 數值`。
 *
 * 分日對齊：把查詢起點對到台北 00:00，`alignmentPeriod=86400s` 的每一桶就剛好是一個台北日。
 * （Google 的免費額度其實在**太平洋時間**半夜重置；2026-08-09 用小時級資料實測兩種分法
 * 的月費用只差約 2%，不值得為此把畫面上的日期改成看不懂的時區，故一律用台北日。）
 */
export async function fetchDailyMetric(opts: {
  projectId: string
  metricType: string
  start: Date
  end: Date
  /** 累計型指標（次數）用 SUM；存量型（bytes）用 MEAN */
  aligner: 'ALIGN_SUM' | 'ALIGN_MEAN'
}): Promise<Map<string, number>> {
  const client = await getAuth().getClient()
  const url = `https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(opts.projectId)}/timeSeries?`
    + new URLSearchParams({
      'filter': `metric.type="${opts.metricType}"`,
      'interval.startTime': opts.start.toISOString(),
      'interval.endTime': opts.end.toISOString(),
      'aggregation.alignmentPeriod': '86400s',
      'aggregation.perSeriesAligner': opts.aligner,
      'aggregation.crossSeriesReducer': 'REDUCE_SUM',
    })

  let res: any
  try {
    res = await client.request({ url })
  }
  catch (e) {
    throw new MonitoringUnavailableError(describeError(e))
  }

  const out = new Map<string, number>()
  for (const series of (res.data?.timeSeries ?? []) as any[]) {
    for (const p of series.points ?? []) {
      // 每桶涵蓋 [end-24h, end)：取 end 前一毫秒換算台北日，才不會落到隔天
      const day = taipeiDateKey(new Date(new Date(p.interval.endTime).getTime() - 1))
      const v = Number(p.value?.int64Value ?? p.value?.doubleValue ?? 0)
      out.set(day, (out.get(day) ?? 0) + v)
    }
  }
  return out
}

/** 多區域位置（費率約為單一區域的兩倍） */
const MULTI_REGIONS = new Set(['nam5', 'eur3'])

let cachedLocation: { projectId: string; locationId: string; multiRegion: boolean } | undefined

/**
 * 查資料庫實際位置以決定費率。查不到就當多區域（估高不估低，寧可讓帳單比預期低）。
 * 位置建好就不會變，快取整個 process 生命週期。
 */
export async function fetchDatabaseLocation(projectId: string): Promise<{ locationId: string; multiRegion: boolean }> {
  if (cachedLocation?.projectId === projectId) return cachedLocation

  try {
    const auth = new GoogleAuth({
      credentials: {
        client_email: String(useRuntimeConfig().firebaseClientEmail || ''),
        private_key: String(useRuntimeConfig().firebasePrivateKey || '').replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    })
    const client = await auth.getClient()
    const res: any = await client.request({
      url: `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)`,
    })
    const locationId = String(res.data?.locationId || '')
    const result = { locationId, multiRegion: MULTI_REGIONS.has(locationId) }
    cachedLocation = { projectId, ...result }
    return result
  }
  catch {
    return { locationId: '', multiRegion: true }
  }
}
