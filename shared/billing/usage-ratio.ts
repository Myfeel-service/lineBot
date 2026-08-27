/**
 * 「呼叫／答出」比值的內部警示判定（C-7，2026-08-10 拍板；C-91 收進超管全站異常總覽）。
 *
 * 為什麼：計費收在「答出」不收在呼叫（BILLING-UNIT-POLICY-20260810.md）——
 * 「呼叫很多、答出很少」的帳號，AI 成本掛在我們身上卻收不到錢。拍板的做法是
 * **不改收費、靠內部警示**盯住這種帳號。
 *
 * 門檻的由來：正常帳號 answered 約佔 invocations 四成（2026-07-27 成本盤點實測），
 * 即比值約 2～2.5；超過 5 倍＝正常值的兩倍以上，值得看一眼。
 *
 * 低量護欄：本月呼叫太少時比值全是噪音（新帳號頭幾天、測試帳號），不判。
 * answered=0 而呼叫夠多＝最極端的一種，一樣要標（此時比值除不出來，回 null 讓顯示層自己講）。
 */
export const USAGE_RATIO_FLAG_THRESHOLD = 5
export const USAGE_RATIO_MIN_INVOCATIONS = 30

export interface UsageRatioVerdict {
  invocations: number
  answered: number
  /** invocations ÷ answered；answered=0 時為 null（顯示層決定怎麼講，別硬塞 Infinity） */
  ratio: number | null
  flagged: boolean
}

export function evaluateUsageRatio(invocations: number, answered: number): UsageRatioVerdict {
  const inv = Math.max(0, Math.round(Number(invocations) || 0))
  const ans = Math.max(0, Math.round(Number(answered) || 0))
  const ratio = ans > 0 ? inv / ans : null
  const flagged = inv >= USAGE_RATIO_MIN_INVOCATIONS
    && (ans === 0 || (ratio !== null && ratio > USAGE_RATIO_FLAG_THRESHOLD))
  return { invocations: inv, answered: ans, ratio, flagged }
}
