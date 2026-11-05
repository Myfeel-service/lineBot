/**
 * 接在回覆後面一起送的系統訊息（`C-57` 加好友時的「告訴我生日」卡）這次能不能附上；不能就回原因（記 log 用），能就回 ''。
 *
 * ⛔ **最後一則有快速回覆就不附**（2026-11-04 code review 第 1 條）：LINE 只在最後一則底下顯示快速回覆按鈕，
 *    附在後面＝那排按鈕消失、歡迎腳本等的那一題客人按不到（跟模組存檔的 `QUICK_REPLY_NOT_LAST_MESSAGE` 同一條規矩）。
 * ⛔ 一次回覆最多 5 則：放不下就不附（⛔ 不切掉店家自己的訊息去塞）。
 */
export const LINE_REPLY_MAX_MESSAGES = 5

/** 附不上的兩種情況（`C-468`：後台要照**他的**歡迎訊息講是哪一種，不是對每個人念一遍規則） */
export type AppendBlockKind = 'quickReply' | 'full'

export function appendBlockedKind(out: readonly unknown[], append: readonly unknown[]): AppendBlockKind | null {
  if (!append.length) return null
  const last = out[out.length - 1] as { quickReply?: unknown } | undefined
  if (last?.quickReply) return 'quickReply'
  if (out.length + append.length > LINE_REPLY_MAX_MESSAGES) return 'full'
  return null
}

export function appendBlockedReason(out: readonly unknown[], append: readonly unknown[]): string {
  const kind = appendBlockedKind(out, append)
  if (kind === 'quickReply') return '最後一則帶快速回覆按鈕（附在後面那排按鈕會消失）'
  if (kind === 'full') return `放不下（已經 ${out.length} 則，一次最多 ${LINE_REPLY_MAX_MESSAGES} 則）`
  return ''
}
