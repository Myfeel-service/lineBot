// ═══════════════════════════════════════════════════════════════════
//  AI 呼叫上限（`C-8`，老闆 2026-10-20「照建議」）——純函式，前後端共用
//
//  為什麼要有：則數只數「AI 出手回答的」，答不出來轉真人不扣（那是賣點）。代價是答不出來的
//  呼叫**永遠燒不完額度**、則數攔截永遠不會觸發，成本理論上沒有上限
//  （`docs/BILLING-UNIT-POLICY-20260810.md` §4：月呼叫 2 萬次 × 答出率 5% ≈ NT$680，已超過輕量月費；免費層尤其）。
//
//  規則：**這個月（台北日曆月）AI 被叫的次數到了「則數額度」的 10 倍，就跟則數用完走同一條路**——
//  自動回應照常，需要 AI 回答的轉真人。⛔ 不改扣則規則，只加天花板。
// ═══════════════════════════════════════════════════════════════════

/**
 * 呼叫上限＝則數額度 × 這個倍數。
 *
 * 為什麼是 10：
 *   · **正常帳號碰不到**：則數比呼叫先用完的條件是「AI 答出（扣則）的比例 ≥ 1 成」——
 *     2026-08 MYFEEL 實測約 4 成（每答出 1 則伴隨 2.5 次呼叫）。只有九成以上都答不出來的帳號，
 *     才會在則數用完之前先撞到這條。
 *   · **成本封得住**：每次呼叫的對話成本約 NT$0.034（同一份實測），10 倍＝每 1 則額度最多燒
 *     NT$0.34 的呼叫：免費 50 則 → 500 次 ≈ NT$17／月；輕量 200 則 → 2,000 次 ≈ NT$68，各方案都在月費以下。
 *
 * ⛔ 改這個數字＝改了「AI 什麼時候會停」：條款（terms.vue「其他用量上限」）直接引用它，
 *    改了要一起升 `POLICY_VERSION`（shared/legal.ts）。
 */
export const AI_CALL_CEILING_MULTIPLIER = 10

/**
 * 這個帳號的呼叫上限（次／月）；null＝這條不套。
 *
 * 不套的兩種（跟則數護欄 `resolveQuotaAction` 同一套判斷）：
 *   · **內部／測試方案**：真無限，連則數都不擋。
 *   · **沒有則數上限**（企業客製沒設額度、或訂閱讀不到）：沒有則數可以乘。這種帳號本來就只靠
 *     token 護欄（AI 設定的每月用量上限）煞車——token 就是成本本身，不必再疊一層次數。
 *     企業有設額度（quotaOverride）的照套：有則數上限就有天花板，判斷只有一條。
 */
export function aiCallCeilingOf(billing: { quota: number | null, internal: boolean }): number | null {
  if (billing.internal) return null
  if (billing.quota == null || !(billing.quota > 0)) return null
  return billing.quota * AI_CALL_CEILING_MULTIPLIER
}

/**
 * 月結桶裡「AI 真的被叫了幾次」。
 *
 * `invocations` 每則交給 AI 的客人訊息都記一次（AI 表現頁的恆等式要它），但其中兩種 AI 根本沒出手、
 * 一毛錢都沒花，要扣掉：
 *   · `directHandoffs`：客人一開口就指名「找真人」。不扣的話，圖文選單有「找真人」鈕的店，
 *     客人按一下就算 AI 被叫一次——跟成本無關卻會把 AI 停掉。
 *   · `quotaBlocked`：額度用完／撞到這條之後被擋下來直接轉真人的那幾次。不扣的話，則數用完那段期間
 *     每則訊息照樣累積；訂閱換期（則數歸零）時，這個月的次數早已被灌過上限，AI 一恢復就以「呼叫太多」再停一次。
 */
export function aiCallsTowardCeiling(
  doc: { invocations?: number, directHandoffs?: number, quotaBlocked?: number } | null | undefined,
): number {
  if (!doc) return 0
  const n = Number(doc.invocations ?? 0) - Number(doc.directHandoffs ?? 0) - Number(doc.quotaBlocked ?? 0)
  return Number.isFinite(n) ? Math.max(0, n) : 0
}

/** 撞到了沒：到上限那一次就停（同則數「已用 ≥ 上限＝用完」）。上限為 null（不套）永遠 false。 */
export function isAiCallCeilingHit(calls: number, ceiling: number | null): boolean {
  return ceiling != null && calls >= ceiling
}

/** 撞到上限時給店家看的那段狀態（後台橫幅／方案頁／提醒都吃這一份） */
export interface AiCallCeilingStatus {
  /** 這個月 AI 真的被叫的次數（{@link aiCallsTowardCeiling}） */
  calls: number
  /** 上限（則數額度 × {@link AI_CALL_CEILING_MULTIPLIER}） */
  limit: number
  hit: boolean
}

/**
 * 「撞到上限、先停下來了」之後怎麼辦——後台橫幅、方案頁、提醒、LINE 通知講同一句（⛔ 別各寫一份）。
 *
 * 三件事都要講對：
 *   · 停下來的原因是「大多答不出來」：撞到上限時答出（扣則）的一定不到 1 成（則數沒用完、次數卻到 10 倍）。
 *   · 能做的事是補知識——那才會讓 AI 答得出來；升級只是把上限拉高。
 *   · 什麼時候恢復：次數按台北日曆月算，下個月 1 號歸零。
 */
export const AI_CALL_CEILING_REMEDY = '把 AI 答不出來的問題補進知識庫，AI 就答得出來；下個月 1 號自動恢復，升級方案也會提高上限。'
