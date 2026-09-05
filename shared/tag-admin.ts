/** 後台標籤／好友／推播共用的選項與色票（單一來源，避免各頁複製） */

import type { UserTagSourceType } from './types/tag-broadcast'

/**
 * 這個來源算不算「客人自己表現出來的」，而不是「我們自己圈的」。
 *
 * ⛔ `manual` 不算：`pushSupportPresetActionToUser`（真人客服按預存回覆順帶貼標）走的是
 *   這條路，那是**我們的動作**。把它算進去，「這個月追了四次出貨」就會混進
 *   「客服幫他貼了四次標」，而那兩件事的下一步完全不同。
 * ⛔ `import` 也不算（名單匯入是一次性資料搬運，不是誰在意什麼）。
 * 算的是：`system`（客人按按鈕／腳本／自己輸入觸發）、`ai`（從對話判到）、`rule`（規則命中客人的話）。
 *
 * **2026-09-04 從 `server/utils/tagging.ts` 搬到 shared**（`D-63`）：原本只有計次（`D-55`）在用，
 * 現在貼標分析的「客人自己表現出來的興趣」排行也要吃同一條界線。
 * ⛔ 不可以在別處另寫一份判斷——那等於讓「客人的訊號」有兩種定義。
 * 為什麼排行非用它不可：`batch-add`（批次貼標）與單人手動貼標寫進資料庫的東西**一模一樣**
 * （都是 `sourceType: 'manual'`、`sourceRefId: null`），事後**分不出來**；不靠這條界線的話，
 * 自己批次貼 300 人就會霸佔排行第一名而且濾不掉（`G-22`⑤ 當時留著沒解的就是這件事）。
 * `tagging.ts` 仍 re-export 同一支，既有匯入不受影響。
 */
export function countsAsCustomerHit(sourceType: UserTagSourceType): boolean {
  return sourceType === 'system' || sourceType === 'ai' || sourceType === 'rule'
}

export const TAG_CATEGORY_OPTIONS = [
  // ⛔ 顯示文字 2026-08-23 由「會員狀態」改「好友狀態」（「會員」全面退場，見 STATUS G-23）。
  // **`value` 刻意不動**：它是既有標籤存在資料庫裡的分類值，改了等於要遷移全部既有標籤，
  // 而使用者只看得到 label。日後若真要改 value，記得連 tags 集合一起搬。
  { value: 'member_status', label: '好友狀態' },
  { value: 'interest', label: '興趣偏好' },
  { value: 'behavior', label: '消費行為' },
  { value: 'activity', label: '活動參與' },
  { value: 'custom', label: '自訂' },
] as const

export type TagCategoryValue = (typeof TAG_CATEGORY_OPTIONS)[number]['value']

export const TAG_PRESET_COLORS = [
  '#6B7280', '#EF4444', '#F97316', '#EAB308',
  '#22C55E', '#14B8A6', '#3B82F6', '#8B5CF6',
  '#EC4899', '#0EA5E9', '#10B981', '#F59E0B',
] as const

export function tagCategoryLabel(value: string) {
  return TAG_CATEGORY_OPTIONS.find((c) => c.value === value)?.label ?? value
}

/**
 * 標籤列表的「AI 分段」（`D-30`①，2026-08-26）。
 *
 * 老闆問「所有標籤混在一個列表是好的嗎」。結論是**列表維持一個**（標籤只有一種身分，
 * 推播選名單與好友頁篩選吃的都是同一批；拆頁之後同一顆標籤改設定還得搬家），
 * 但要把「哪些在讓 AI 判」這個最常用的切法**放到檯面上**，不是藏在下拉裡。
 *
 * ⛔ 這三段只分「AI 判不判」，不分 suggest／auto：
 *    細節由表格的「AI 判斷」欄的徽章負責（那裡本來就分得出先建議／直接貼）。
 *    膠囊是粗篩、欄位是細節——四顆膠囊裡會有一顆長期是 0，點進去是死路。
 *    （API 仍收 aiMode=suggest|auto，深連結不受影響。）
 */
export const TAG_AI_SEGMENTS = [
  { value: '', label: '全部' },
  { value: 'ai', label: '🤖 AI 判斷中' },
  { value: 'off', label: '手動／系統' },
] as const

export type TagAiSegment = (typeof TAG_AI_SEGMENTS)[number]['value']

/**
 * 進了「AI 判斷中」之後才出現的細分（2026-08-26 補）。
 *
 * ⛔ **不是把上面那排改成四顆**——那是上面刻意拍板不做的（會有一顆長期是 0、
 * 點進去是死路）。這排只在已經選了「AI 判斷中」時才出現：那時你已經在這一段裡面，
 * 看到「直接貼 0」是**有意義的答案**（沒有任何一顆在自動貼），不是一顆沒用的死膠囊。
 *
 * 為什麼要補：`aiMode='auto'`（AI 判到就直接貼、不用人點頭）是**風險最高的那一種**
 * ——貼錯的下游是下次推播發錯人。先前要盤點它只能自己翻完整份清單一列一列看徽章，
 * 而程式碼註解卻寫著「深連結不受影響」，實際上那一頁根本沒讀網址參數（已一併補上）。
 */
export const TAG_AI_SUB_SEGMENTS = [
  { value: 'suggest', label: 'AI 先建議', hint: 'AI 判到會放進建議，等人按「採用」才貼上' },
  { value: 'auto', label: 'AI 直接貼', hint: 'AI 判到就直接貼上，不用人點頭——風險最高的一種，值得定期看一眼' },
] as const

export type TagAiSubSegment = (typeof TAG_AI_SUB_SEGMENTS)[number]['value']

/** 網址帶進來的 `?aiMode=` 是不是我們認得的值（認不得就當沒帶，不要篩出一片空白） */
export function isTagAiFilterValue(raw: unknown): raw is TagAiSegment | TagAiSubSegment {
  const v = String(raw ?? '')
  return v === 'ai' || v === 'off' || v === 'suggest' || v === 'auto'
}

/** 一顆標籤算不算「AI 判斷中」。⛔ 缺欄位＝off（全系統口徑，舊標籤不誤判） */
export function isAiJudgedTag(tag: { aiMode?: string | null }): boolean {
  return tag.aiMode === 'suggest' || tag.aiMode === 'auto'
}

/**
 * 算三段的數字（純函式，可測）。
 *
 * ⛔ **傳進來的清單必須是「套過其他條件、但沒套 aiMode」的**：
 *    分面篩選的通則是「每一面的計數要排除它自己」，否則點了「AI 判斷中」之後
 *    「手動／系統」會顯示 0，看起來像那 21 顆消失了。
 */
export function tagSegmentCounts(
  tagsWithoutAiFilter: Array<{ aiMode?: string | null }>,
): { all: number, ai: number, manual: number, suggest: number, auto: number } {
  let suggest = 0
  let auto = 0
  for (const t of tagsWithoutAiFilter) {
    if (t.aiMode === 'suggest') suggest++
    else if (t.aiMode === 'auto') auto++
  }
  const ai = suggest + auto
  return { all: tagsWithoutAiFilter.length, ai, manual: tagsWithoutAiFilter.length - ai, suggest, auto }
}
