/**
 * 「呼叫／答出」比值的內部警示判定（C-7，2026-08-10 拍板；C-91 收進超管全站異常總覽）。
 *
 * 為什麼：**成本按「呼叫」走、收入按「計費則數」走**——「呼叫很多、收得到的則數很少」
 * 的帳號，AI 成本掛在我們身上卻收不到錢。拍板的做法是**不改收費、靠內部警示**盯住這種帳號。
 *
 * ⛔ 分母是 `billable`（答出＋反問）**不是** `answered`：2026-09-07（`D-69`）反問開始計費，
 * 拿 answered 當分母等於把「已經收到錢的反問」算成收不到錢，愛反問的帳號會被系統性地
 * 過度標記——那正好違背這支警示自己的立論。
 *
 * 門檻的由來：正常帳號答出約佔 invocations 四成（2026-07-27 成本盤點實測），
 * 即比值約 2～2.5；超過 5 倍＝正常值的兩倍以上，值得看一眼。
 * ⚠️ 反問納入計費後分母變大、比值會略降，門檻 5 因此偏保守（寧可少標不要誤標），暫不調。
 *
 * 低量護欄：本月呼叫太少時比值全是噪音（新帳號頭幾天、測試帳號），不判。
 * 計費則數=0 而呼叫夠多＝最極端的一種，一樣要標（此時比值除不出來，回 null 讓顯示層自己講）。
 */
export const USAGE_RATIO_FLAG_THRESHOLD = 5
export const USAGE_RATIO_MIN_INVOCATIONS = 30

export interface UsageRatioVerdict {
  invocations: number
  /** 這個月收得到的則數（答出＋反問）。⛔ 不是 answered，見檔頭。 */
  billable: number
  /** invocations ÷ billable；billable=0 時為 null（顯示層決定怎麼講，別硬塞 Infinity） */
  ratio: number | null
  flagged: boolean
}

export function evaluateUsageRatio(invocations: number, billable: number): UsageRatioVerdict {
  const inv = Math.max(0, Math.round(Number(invocations) || 0))
  const bil = Math.max(0, Math.round(Number(billable) || 0))
  const ratio = bil > 0 ? inv / bil : null
  const flagged = inv >= USAGE_RATIO_MIN_INVOCATIONS
    && (bil === 0 || (ratio !== null && ratio > USAGE_RATIO_FLAG_THRESHOLD))
  return { invocations: inv, billable: bil, ratio, flagged }
}
