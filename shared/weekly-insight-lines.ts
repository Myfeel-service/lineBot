/**
 * 「本週顧客觀察」那一段的純格式化（D-25 第二階）。
 *
 * 2026-09-28 `C-273`（`D-107`）從 `server/utils/weekly-insights.ts` 搬過來：
 * 後台「設定 → LINE 通知」的手機預覽要畫出同一段，而 server 那支引了 firebase-admin、前端用不到。
 * ⛔ 預覽跟送出端必須是**同一支函式**——原本預覽傳空陣列，勾了「本週顧客觀察」預覽裡什麼都沒有。
 * 查資料的部分（tagLogs 聚合、沉睡客人數）仍在 server 那支。
 */

/** 本週 tagLogs 取樣上限：超過就講明是取樣（批次貼標一次幾千筆的週會撞到） */
export const WEEKLY_TAG_LOG_SCAN_LIMIT = 1000

export interface WeeklyInsightInput {
  /** 「8/17–8/23」這種區間字樣 */
  rangeText: string
  /** 本週被貼最多的一般標籤（已排除系統的「沒互動」標） */
  topTags: Array<{ name: string; count: number }>
  /** 本週被標成「沒互動」的人數與標籤名（0＝不講） */
  inactiveAdds: { count: number; name: string }
  /** 上月有來訊、最近兩週安靜的客人數 */
  quietDown: number
  /** tagLogs 撞到取樣上限（要講明，否則「+1,000」會被當成精確值） */
  truncated: boolean
}

/**
 * 組出週報段落。**全部觀察都是零 → null**（整段不出現）。
 * 第一行是段落標題，呼叫端直接接在摘要後面（前面補一個空行隔開）。
 */
export function formatWeeklyInsightLines(input: WeeklyInsightInput): string[] | null {
  const lines: string[] = []

  // ⛔ 指路一律用**側欄的名字**（「好友」「AI 設定」）——人是拿著訊息對照側欄找的，
  //    寫「好友頁」這種頁面別名會找不到（G-22③：同一頁曾有三個名字）
  // ⛔ 不加「・」項目符號（2026-09-17 `D-81`）：摘要本體改版後整則都不用項目符號，
  //    只有這一段還留著的話，同一顆泡泡裡會有兩套排版。
  if (input.topTags.length) {
    const parts = input.topTags.map(t => `「${t.name}」+${t.count} 位`).join('、')
    lines.push(`這週被貼最多的標籤：${parts}——後台「好友」頁可依標籤篩出名單`)
  }
  if (input.inactiveAdds.count > 0) {
    lines.push(`${input.inactiveAdds.count} 位客人這週被標成「${input.inactiveAdds.name}」——想喚醒他們，發推播時選這個標籤`)
  }
  // ⛔ 這裡**刻意沒有**「還沒看的貼標建議」那一行（2026-09-17 移除，`D-81`）：
  // 08-31（`D-43`①）之後摘要本文已經有「N 位客人的標籤建議等你決定」，兩行同一個
  // 查詢（userTagSuggestions.hasPending）、同一個去處、同一個操作，只有名字不一樣
  // （標籤建議／貼標建議）——週一的那則訊息等於把同一件事講兩次。
  if (input.quietDown > 0) {
    // 文案跟資料窗口一字不差（14~28 天前，不是日曆上個月）＋這一行也要有下一步（G-22②④）
    lines.push(`最近一個月內有來訊、但兩週沒再出現的客人：${input.quietDown} 位——想提早喚醒，到「AI 設定」把「沒互動」天數調低，就能用標籤把他們撈出來發推播`)
  }

  if (!lines.length) return null
  if (input.truncated) lines.push(`（標籤統計為本週前 ${WEEKLY_TAG_LOG_SCAN_LIMIT.toLocaleString('en-US')} 筆取樣）`)
  return [`📈 本週顧客觀察（${input.rangeText}）`, ...lines]
}
