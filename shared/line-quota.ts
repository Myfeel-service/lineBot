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
 */

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

/** 剩不到上限的這個比例就換成提醒色 */
const LOW_RATIO = 0.1

const n = (x: number) => x.toLocaleString('en-US')

const WHO_USES = '推播、真人在後台回覆、試發、活動頁加好友後送的那則、LINE 通知都會用到，AI 回客人不算。'

/**
 * 推播頁左邊那一行；`title` 是滑過去看到的補充。
 * ⚠️ 上限＝**方案內含＋願意加購的**（LINE 只給合計，不給方案內含幾則）：MYFEEL 2026-10 是 306,000，
 * 不補這句會被看成「免費的還剩這麼多」。
 * ⛔ 上限不放進那一行：側欄 240px，「（共 306,000）」會從括號中間斷到第二行（實機量到），跟著補充一起放滑過去那句。
 */
export function lineQuotaHint(q: LineMessageQuota | null | undefined): { text: string, title: string, warn: boolean } | null {
  if (!q) return null
  if (q.limit === null || q.remaining === null) {
    return {
      text: `LINE 這個月已送約 ${n(q.used)} 則（沒設上限）`,
      title: `沒設每月上限：超過方案內含的則數，LINE 會另外收費。${WHO_USES}`,
      warn: false,
    }
  }
  const title = `上限 ${n(q.limit)} 則，是在 LINE 官方帳號後台設的（方案內含＋加購的則數）；這個月已送約 ${n(q.used)} 則。${WHO_USES}`
  if (q.remaining === 0) return { text: `LINE 這個月的 ${n(q.limit)} 則用完了`, title, warn: true }
  return { text: `LINE 這個月還剩約 ${n(q.remaining)} 則`, title, warn: q.remaining < q.limit * LOW_RATIO }
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
