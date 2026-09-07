/**
 * Google 帳單的「一天」與「一個月」＝**美國太平洋時間**的日曆日／日曆月。
 *
 * 為什麼要有這一份（2026-09-07 老闆比對主控台抓到）：
 * Firestore 的每日免費額度（5 萬讀／2 萬寫／2 萬刪）是在**太平洋時間半夜**重置的，
 * 換算台灣是**下午 3 點**（夏令時；冬令時是下午 4 點）。成本頁原本用台北午夜切，
 * 於是同一批用量在兩邊被切成不同的「天」，免費額度扣法就跟帳單對不上：
 *
 *   2026-09-06 的寫入，用台北日切 → 9/6 12,907 次、9/7 11,486 次，兩天都沒破 2 萬
 *   → 畫面寫「都在免費額度內」；
 *   同一批用太平洋日切 → 9/6 共 21,893 次、**超出 1,893 次**
 *   → 主控台顯示「2.2 萬（超出免付費配額 1,792）」。
 *
 * 錢只差約 NT$0.1，但畫面上那句話是錯的，而且會**永遠**跟主控台打架。
 * 這張卡的工作就是「預告帳單」，所以帳單怎麼切、這裡就怎麼切。
 *
 * ⛔ 不要為了「畫面上的日期比較好懂」改回台北日：一改回去，長條圖上那條
 * 「每天免費的 5 萬次」灰底就會變成另一種謊（那條線的位置只有按 Google 的日界才成立）。
 * 要讓人看得懂是**加一句說明**的事，不是改口徑的事。
 *
 * ⚠️ 太平洋時間有夏令時間，所以不能寫死 -7／-8，一律走 `Intl` 查當下的實際偏移。
 * 一年有兩天長度是 23 或 25 小時；Cloud Monitoring 的 86400 秒分桶是固定 24 小時，
 * 那兩天（三月與十一月的轉換日）分桶會與日曆日差一小時。金額影響是那一天的一小時，
 * 不值得為此改抓小時級資料（會讓每次查詢從 7 個點變成 168 個點）。
 */
export const GOOGLE_BILLING_TZ = 'America/Los_Angeles'

/** `YYYY-MM-DD`（en-CA 的預設格式就是這個，不要自己拼字串） */
const DAY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: GOOGLE_BILLING_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
})

const PARTS_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: GOOGLE_BILLING_TZ,
  hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
})

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * 該時刻在太平洋時區的偏移（毫秒，夏令時 -7h、冬令時 -8h）。
 * 做法＝把太平洋牆上時間當成 UTC 讀回來，再跟真實時刻相減。
 */
function offsetMsAt(at: Date): number {
  const p: Record<string, string> = {}
  for (const part of PARTS_FMT.formatToParts(at)) p[part.type] = part.value
  const asIfUtc = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour) % 24, Number(p.minute), Number(p.second),
  )
  return asIfUtc - at.getTime()
}

/** 絕對時刻 → Google 帳單日 `YYYY-MM-DD` */
export function billingDateKey(at: Date): string {
  return DAY_FMT.format(at)
}

/**
 * 帳單日 `YYYY-MM-DD` → 該日太平洋 00:00 的絕對時刻。
 *
 * 偏移本身跟「是哪一刻」互相依賴（DST 換日那天尤其），所以先用「假裝是 UTC」當種子
 * 再依實際偏移修正，收斂後才回傳。跑兩圈就會停，第三圈是給邊界的保險。
 */
export function billingDayStart(key: string): Date {
  const m = DAY_RE.exec(key)
  if (!m) throw new Error(`billingDayStart：日期格式要 YYYY-MM-DD，收到 ${key}`)
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  let ts = wall
  for (let i = 0; i < 3; i++) {
    const next = wall - offsetMsAt(new Date(ts))
    if (next === ts) break
    ts = next
  }
  return new Date(ts)
}

/**
 * 下一個太平洋午夜（**嚴格大於** at）。
 *
 * 用途同 `taipeiMidnightAfter`：Cloud Monitoring 的分桶是從查詢的**結束時間往回切**的，
 * 結束時間沒有落在日界上，切出來就是滾動 24 小時窗，標成日曆日會整批偏移。
 */
export function billingMidnightAfter(at: Date): Date {
  const start = billingDayStart(billingDateKey(at))
  if (start.getTime() > at.getTime()) return start
  // 一天最短 23 小時、最長 25 小時，往後跳 26 小時必定落在隔天之內
  return billingDayStart(billingDateKey(new Date(start.getTime() + 26 * 3600_000)))
}

/** 該月太平洋 1 日 00:00 的絕對時刻（`month` 是 1–12） */
export function billingMonthStart(year: number, month: number): Date {
  const y = month > 12 ? year + 1 : month < 1 ? year - 1 : year
  const m = ((month - 1) % 12 + 12) % 12 + 1
  return billingDayStart(`${y}-${String(m).padStart(2, '0')}-01`)
}

/** 列出 [start, end) 之間每一個帳單日（`YYYY-MM-DD`） */
export function enumerateBillingDays(start: Date, end: Date): string[] {
  const out: string[] = []
  let cur = billingDayStart(billingDateKey(start))
  while (cur.getTime() < end.getTime()) {
    out.push(billingDateKey(cur))
    cur = billingMidnightAfter(cur)
  }
  return out
}

/**
 * 帳單日 → 「台灣看是哪一天的幾點到幾點」，給畫面講人話用。
 * 例：`2026-09-06` → `{ from: '9/6 下午 3 點', to: '9/7 下午 3 點' }`
 */
export function billingDayTaipeiSpan(key: string): { from: string; to: string } {
  const label = (d: Date) => {
    const t = new Date(d.getTime() + 8 * 3600_000)
    const h = t.getUTCHours()
    const ampm = h < 12 ? '上午' : '下午'
    const h12 = h % 12 === 0 ? 12 : h % 12
    return `${t.getUTCMonth() + 1}/${t.getUTCDate()} ${ampm} ${h12} 點`
  }
  const start = billingDayStart(key)
  return { from: label(start), to: label(billingMidnightAfter(start)) }
}
