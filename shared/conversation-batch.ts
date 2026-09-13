/**
 * 對話列表「勾選 → 批次處理」的共用定義（上限、結果型別、略過原因的人話）。
 *
 * 為什麼要有這一份：
 *
 * 1. **上限只能有一個數字**。畫面上那句「一次最多 100 筆」和後端的擋門若各寫一份，
 *    改一邊就會出現「按了說太多、畫面卻說沒超過」。
 * 2. **批次結果一定要分三堆**（做了／略過／失敗）。這個專案為「過濾掉東西卻不吭聲」
 *    付過三次帳：批次關 8 場只回「完成」，其中 2 場其實是別人先關掉的、
 *    或是資料被清掉找不到——那兩位客人就這樣從客服的視野裡消失。
 *    所以端點一律回三堆的 id，畫面照實講。
 * 3. **略過原因的措辭放這裡**：兩支批次端點（結束會話、待跟進）共用同一套說法，
 *    前端不要自己編字串（編出來的說法會和另一支不一致）。
 */

/**
 * 一次批次最多幾筆。
 *
 * 100 這個數字的理由是成本與逾時，不是畫面：關一場要 2 次讀（會話＋對話）＋3 次寫
 * （會話、對話、事件），100 筆＝約 200 讀 300 寫，在 Lambda 的回應時間內做得完。
 * 想一次清掉整個「待處理」分頁（myfeel 有上千筆從沒開口的殭屍場，見 STATUS `E-10`）
 * 不是這個功能的工作——那是排程要治本的事，不該由人按一顆按鈕關掉上千場沒人看過的對話。
 */
export const CONVERSATION_BATCH_LIMIT = 100

/** 這一筆沒被處理的原因（⛔ 不要合併成一句「略過」：下一步完全不同） */
export type ConversationBatchSkipReason =
  /** 查不到這場／這位客人，或不屬於這個官方帳號（資料被清掉、或畫面停在很舊的清單上） */
  | 'not_found'
  /** 已經是結束狀態（多半是同事先關掉了） */
  | 'already_closed'
  /** 標記本來就是要設成的那個值（重複按，不算失敗） */
  | 'already_set'

/** 略過原因對使用者的說法（前端直接印，不要自己造句） */
export const CONVERSATION_BATCH_SKIP_LABELS: Record<ConversationBatchSkipReason, string> = {
  not_found: '查不到（資料可能已被清掉，請按重整）',
  already_closed: '已經是結束狀態（可能同事先關掉了）',
  already_set: '標記本來就是這樣',
}

export interface ConversationBatchSkip {
  /** 結束會話回 sessionId、待跟進回對話主鍵（前端拿它對回清單上那一列的名字） */
  id: string
  reason: ConversationBatchSkipReason
}

export interface ConversationBatchFailure {
  id: string
  /** 寫入時真的炸了的訊息（截短）。⛔ 不可以併進 skip：這種要重試，略過的不用 */
  message: string
}

export interface ConversationBatchResult {
  /** 這次送來幾筆（去重後） */
  requested: number
  /** 真的做完幾筆 */
  done: number
  /** 不需要做的（原因見 reason） */
  skipped: ConversationBatchSkip[]
  /** 想做但失敗的（要重試） */
  failed: ConversationBatchFailure[]
  /** 真的做完的那幾筆 id（前端拿去就地更新畫面，不必整份重載） */
  doneIds: string[]
}

/**
 * 把批次結果講成一句人話。
 *
 * ⛔ 不可以只在「全部成功」時才講數字：客服要的是「我按下去的 8 筆，現在怎麼樣了」，
 *    所以三堆都不是 0 的時候都要出現在這句話裡。
 */
export function describeConversationBatchResult(
  result: Pick<ConversationBatchResult, 'done' | 'skipped' | 'failed'>,
  unit: string,
  verb: string,
): string {
  const parts = [`${result.done} ${unit}${verb}`]
  if (result.skipped.length) parts.push(`${result.skipped.length} ${unit}略過`)
  if (result.failed.length) parts.push(`${result.failed.length} ${unit}失敗`)
  return parts.join('、')
}
