/**
 * LINE 官方帳號這個月還能送幾則（`C-380`）。
 *
 * 以前後台從來沒問過 LINE 剩幾則，只有送出去被 LINE 擋下來（429「monthly limit」）才知道用完了——
 * 那時推播已經送到一半，真人在後台回覆也一起送不出去。
 *
 * LINE 給兩個數字：本月上限（`GET /v2/bot/message/quota`）、本月已送（`GET /v2/bot/message/quota/consumption`）。
 * ⚠️ 照 LINE 文件（2026-10-22 查）：
 *   · 兩個數字都**含在 LINE 官方帳號後台手動發的**，不只是我們送的。
 *   · 「已送」是**大約數**，所以畫面上一律寫「約」。
 *   · 上限沒設（`type: none`）＝付費方案沒設每月上限、超過方案內含的會另外計費；這時只講已送幾則。
 *
 * 會用掉則數的：推播、真人在後台回覆（含客服預存回覆）、試發、活動頁加好友後送的那則、傳給店家的 LINE 通知
 * （2026-10-22 逐支查過送訊息的程式：只有這幾條走 push／multicast）。
 * AI／自動回應回客人不算（那是回覆客人剛傳來的那則，LINE 不計）。
 * LINE 一位收件人算一則（一次最多 5 個對話框也只算一則），所以「要送幾位」＝「會用掉幾則」。
 *
 * `D-146`（2026-10-22）起放在四個地方，句子全在這一份：推播頁、登入後第一頁那一條、小幫手、八成那則 LINE 通知／用完那封信。
 */
import { taipeiDate } from './time'

export type LineMessageQuota = {
  /** 本月上限；null＝沒設上限 */
  limit: number | null
  /** 本月已送（大約數） */
  used: number
  /** 還剩幾則；沒設上限時 null。⛔ 不會是負數（已送是大約數，可能比上限多一點） */
  remaining: number | null
}

/** 把 LINE 回的兩個數字合成一份；看不懂的格式回 null（畫面整行不顯示，⛔ 不拿 0 冒充「用完了」） */
export function lineQuotaFromLine(
  quota: { type?: string, value?: number } | null | undefined,
  consumption: { totalUsage?: number } | null | undefined,
): LineMessageQuota | null {
  const used = Number(consumption?.totalUsage)
  if (!Number.isFinite(used) || used < 0) return null
  if (quota?.type === 'none') return { limit: null, used, remaining: null }
  const limit = Number(quota?.value)
  if (quota?.type !== 'limited' || !Number.isFinite(limit) || limit < 0) return null
  return { limit, used, remaining: Math.max(0, limit - used) }
}

/** 加購、升級 LINE 方案要去的地方（LINE 官方帳號管理後台）：登入後第一頁那一條、每一頁紅條、用完那封信的按鈕 */
export const LINE_OA_MANAGER_URL = 'https://manager.line.biz/'

/**
 * 「快用完」的尺：用到上限的八成（`D-146`，跟 AI 回覆則數的 80% 同一把）。
 * 推播頁那一行、登入後第一頁那一條、小幫手黃色那一項、八成那則 LINE 通知全吃這一支——⛔ 不要各自再寫一個門檻。
 */
export const LINE_QUOTA_NEAR_RATIO = 0.8

export type LineQuotaLevel = 'ok' | 'near' | 'over'

/** 沒設上限＝永遠 ok（沒有用完這回事）；讀不到＝null（⛔ 不當成 ok：畫面整條不顯示、小幫手照「這次查不到」講） */
export function lineQuotaLevel(q: LineMessageQuota | null | undefined): LineQuotaLevel | null {
  if (!q) return null
  if (q.limit === null || q.remaining === null) return 'ok'
  if (q.remaining === 0) return 'over'
  return q.used >= q.limit * LINE_QUOTA_NEAR_RATIO ? 'near' : 'ok'
}

/** 每月 1 號重算：回「11/1」這種寫法（台灣時間的下個月 1 號） */
export function lineQuotaResetLabel(now: Date = new Date()): string {
  const month = Number(taipeiDate(now).slice(5, 7))
  return `${month === 12 ? 1 : month + 1}/1`
}

/**
 * 快用完／用完了會怎樣（全站同一句：登入後第一頁那一條、每一頁紅條、用完那封信）。
 * ⛔ 「AI 回客人」那半句不能拿掉：沒有它，看到的人會以為整個 LINE 都停了、客人全部沒人回。
 */
export function lineQuotaConsequence(level: 'near' | 'over', reset: string): string {
  return level === 'over'
    ? `推播、你在後台回客人的訊息、傳給你的 LINE 通知現在都送不出去，要等 ${reset} 才恢復（AI 回客人照常）。`
    : `用完後，推播、你在後台回客人的訊息、傳給你的 LINE 通知都會送不出去，要等 ${reset} 才恢復（AI 回客人不受影響）。`
}

const n = (x: number) => x.toLocaleString('en-US')

const WHO_USES = '推播、真人在後台回覆、試發、活動頁加好友後送的那則、LINE 通知都會用到，AI 回客人不算。'

/** 滑過去那句（推播頁那一行、登入後第一頁那一條共用） */
function quotaTitle(q: LineMessageQuota): string {
  if (q.limit === null) return `沒設每月上限：超過方案內含的則數，LINE 會另外收費。${WHO_USES}`
  return `上限 ${n(q.limit)} 則，是在 LINE 官方帳號後台設的（方案內含＋加購的則數）；這個月已送約 ${n(q.used)} 則。${WHO_USES}`
}

/**
 * 推播頁左邊那一行；`title` 是滑過去看到的補充。
 * ⚠️ 上限＝**方案內含＋願意加購的**（LINE 只給合計，不給方案內含幾則）：MYFEEL 2026-10 是 306,000，
 * 不補這句會被看成「免費的還剩這麼多」。
 * ⛔ 上限不放進那一行：側欄 240px，「（共 306,000）」會從括號中間斷到第二行（實機量到），跟著補充一起放滑過去那句。
 */
export function lineQuotaHint(q: LineMessageQuota | null | undefined): { text: string, title: string, level: LineQuotaLevel } | null {
  const level = lineQuotaLevel(q)
  if (!q || !level) return null
  const title = quotaTitle(q)
  if (q.limit === null || q.remaining === null) return { text: `LINE 這個月已送約 ${n(q.used)} 則（沒設上限）`, title, level }
  // `D-146`：八成黃、用完紅，跟登入後第一頁那一條、小幫手同一把尺同一組顏色（原本剩不到一成才換色、用完也是黃）
  if (level === 'over') return { text: `LINE 這個月的 ${n(q.limit)} 則用完了`, title, level }
  return { text: `LINE 這個月還剩約 ${n(q.remaining)} 則`, title, level }
}

export type LineQuotaStrip = {
  level: LineQuotaLevel
  /** 主句：這個月還剩約 N 則／這個月的 N 則用完了／這個月已送約 N 則 */
  main: string
  /** 右邊小字：已送約／上限・幾號重算 */
  meta: string
  /** 進度條（0～100）；沒設上限＝null，不畫 */
  usedPercent: number | null
  /** 快用完、用完時多一行講後果；平常 null */
  note: string | null
  /** 滑過去（同推播頁那一行） */
  title: string
}

/**
 * 登入後第一頁那一條（`D-146`①，示意畫布 ①②）。
 * ⛔ 不放進那一頁的數字列：那排跟著右上角的日期區間變，這個數字不會（每月 1 號重算），放進去會被讀成「近 7 天剩幾則」。
 */
export function lineQuotaStrip(q: LineMessageQuota | null | undefined, now: Date = new Date()): LineQuotaStrip | null {
  const level = lineQuotaLevel(q)
  if (!q || !level) return null
  const reset = lineQuotaResetLabel(now)
  const title = quotaTitle(q)
  if (q.limit === null || q.remaining === null) {
    return { level, main: `這個月已送約 ${n(q.used)} 則`, meta: `沒設每月上限・${reset} 重算`, usedPercent: null, note: null, title }
  }
  return {
    level,
    main: level === 'over' ? `這個月的 ${n(q.limit)} 則用完了` : `這個月還剩約 ${n(q.remaining)} 則`,
    meta: `已送約 ${n(q.used)}／上限 ${n(q.limit)}・${reset} 重算`,
    usedPercent: q.limit > 0 ? Math.min(100, Math.round((q.used / q.limit) * 1000) / 10) : 100,
    note: level === 'over'
      ? lineQuotaConsequence('over', reset)
      : level === 'near' ? `快用完了：${lineQuotaConsequence('near', reset)}` : null,
    title,
  }
}

/** 小幫手那兩項的補充那一行（示意畫布 ③）：用完＝已送／上限；快用完＝多帶百分比 */
export function lineQuotaAlertDetail(q: LineMessageQuota, now: Date = new Date()): string {
  const reset = lineQuotaResetLabel(now)
  if (q.limit === null) return `這個月已送約 ${n(q.used)} 則，${reset} 重算`
  if (lineQuotaLevel(q) === 'over') return `已送約 ${n(q.used)}／${n(q.limit)} 則，${reset} 重算`
  const pct = q.limit ? Math.round((q.used / q.limit) * 100) : 0
  return `這個月已送約 ${n(q.used)}／${n(q.limit)} 則（${pct}%），${reset} 重算`
}

/**
 * 用到八成那則 LINE 通知（`D-146`③，示意畫布 ③）：跟「⚠️ AI 用量預警」同一個樣子。
 * ⚠️ 說「還有這類通知」不說「傳給你的 LINE 通知」：讀的人就是在 LINE 上收到這則的那一位。
 */
export function lineQuotaWarnNotifyText(q: LineMessageQuota, now: Date = new Date()): string {
  const pct = q.limit ? Math.round((q.used / q.limit) * 100) : 0
  return [
    '⚠️ LINE 訊息快用完了',
    `這個月已送約 ${n(q.used)}／${n(q.limit ?? 0)} 則（約 ${pct}%），${lineQuotaResetLabel(now)} 重算。`,
    '用完後，推播、你在後台回客人的訊息、還有這類通知都會送不出去。',
    '要加購或升級，請到 LINE 官方帳號後台。',
  ].join('\n')
}

/** 這次要送的人數比 LINE 剩下的則數多幾位；0＝夠送或沒設上限 */
export function lineQuotaShortfall(q: LineMessageQuota | null | undefined, recipients: number): number {
  if (!q || q.remaining === null) return 0
  const want = Math.max(0, Math.floor(Number(recipients) || 0))
  return Math.max(0, want - q.remaining)
}

/**
 * 發送前確認視窗的那句警告；夠送回 null。
 * ⛔ 句子裡不重複數字：視窗上「預估發送人數」「LINE 這個月還剩約」兩格就並排在上面。
 * 只警告不擋：剩幾則是大約數，而且送得到幾位算幾位，要不要照送由他決定。
 */
export function lineQuotaWarning(q: LineMessageQuota | null | undefined, recipients: number): string | null {
  if (!lineQuotaShortfall(q, recipients)) return null
  const where = '請先到 LINE 官方帳號後台升級方案，或等下個月再送。'
  if (q!.remaining === 0) return `LINE 這個月的則數用完了，現在送出去誰都收不到。${where}`
  return `LINE 剩下的則數不夠送給這麼多人，超過的人會收不到。要全部送到，${where}`
}
