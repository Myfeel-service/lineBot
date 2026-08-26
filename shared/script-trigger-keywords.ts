/**
 * 觸發關鍵字的「會惹禍」判斷——單一事實來源。
 *
 * 為什麼搬到 shared（2026-08-26 `D-33` P1）：這份名單原本只住在 `server/utils/ai-script-generate.ts`，
 * 只在 **AI 生成腳本** 時把爛關鍵字剔掉。人手打進編輯器的完全沒人檢查——而 `C-25` 那場
 * 「觸發詞劫持正常訊息」的災情，正是人手設的關鍵字造成的。
 *
 * ⛔ 兩邊的力度刻意不同，別統一：
 * - 生成端＝**剔除**（模型產的東西沒人看過，寧可少不可錯）。
 * - 編輯器＝**只提醒、不阻擋**。既有腳本可能刻意這樣設（範本的「人工客服」就是），
 *   回頭報錯會擋住本來好好在跑的設定。
 */

/**
 * 高頻通用詞：拿來當觸發關鍵字，子字串比對會把大量不相關的訊息攔進這條流程
 * （「我的訂單有問題」裡的「問題」）。
 */
export const GENERIC_TRIGGER_KEYWORDS: ReadonlySet<string> = new Set([
  '你好', '您好', '哈囉', '在嗎', '請問', '謝謝', '感謝', '麻煩', '拜託',
  '客服', '服務', '問題', '怎麼', '什麼', '多少', '幫我', '想問', '請教',
  'hi', 'hello', 'ok', '好的', '是的',
])

/** 這個關鍵字會不會攔到一大堆不相關的訊息：單一個字，或高頻通用詞。 */
export function isRiskyTriggerKeyword(raw: string): boolean {
  const k = raw.trim().toLowerCase()
  if (!k)
    return false
  // 單一個字：中文一個字幾乎一定會誤中（「單」會命中「單身」「單車」…）
  if ([...k].length <= 1)
    return true
  return GENERIC_TRIGGER_KEYWORDS.has(k)
}

/** 一組關鍵字裡有問題的那幾個（順序照原輸入，重複只回一次）。 */
export function riskyTriggerKeywords(keywords: readonly string[]): string[] {
  const out: string[] = []
  for (const k of keywords) {
    const t = k.trim()
    if (t && isRiskyTriggerKeyword(t) && !out.includes(t))
      out.push(t)
  }
  return out
}
