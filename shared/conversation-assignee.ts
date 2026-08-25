/**
 * 對話的「負責人員」（G-27 功能缺口②）——**哪一位同事在跟這個客人**。
 *
 * 為什麼需要：我們原本只知道「有沒有人接手」（會話狀態 human_handling），
 * 不知道是誰。多人客服時兩個人會同時回同一位客人，或兩個人都以為對方在處理。
 * 清單上完全看不出來，只有訊息泡泡旁的「真人」標籤與 tooltip 裡才有名字——
 * 那要點進去、還要滑到那一則才看得到，防不了撞車。
 *
 * ⛔ 這是**對話層級**的記號（存在 `conversations/{docId}`），不是會話層級：
 *    同一位客人隔天開新的一場，負責的人通常還是同一個；記在會話上每天都要重指派。
 * ⛔ 與會話狀態是兩件事，刻意不連動：
 *      會話狀態 human_handling ＝ 機器人閉嘴了（影響自動回覆）
 *      負責人員              ＝ 誰在跟（只影響人怎麼分工，不影響任何自動行為）
 *    綁在一起的話，「交還機器人」就會把負責人一起清掉——但那個人明明還在跟這條線。
 * ⛔ 不進任何統計：首接／結案率的口徑見 docs/CONVERSATION-STATS-DEFINITIONS.md，
 *    那些吃的是會話事件，不是這個欄位。
 */

export interface ConversationAssignee {
  /** Firebase Auth uid；空字串＝沒有人負責 */
  uid: string
  /**
   * 指派當下的顯示名稱（快照）。
   * ⛔ 刻意存名字不是只存 uid：清單一頁 30 列，要現查 30 次 Auth 才畫得出名字。
   *    代價是這個人改名之後舊的指派還是舊名字——可接受（重新指派就會更新），
   *    比每次列表多打 30 次外部 API 好。
   */
  name: string
  assignedAtMs: number
}

export const NO_ASSIGNEE: ConversationAssignee = { uid: '', name: '', assignedAtMs: 0 }

function toMillis(raw: unknown): number {
  if (!raw) return 0
  const v = raw as { toMillis?: () => number; seconds?: number; _seconds?: number }
  if (typeof v.toMillis === 'function') return v.toMillis()
  const sec = v.seconds ?? v._seconds
  return typeof sec === 'number' ? sec * 1000 : 0
}

/** 由 `conversations` 文件資料讀出負責人員（欄位不存在＝沒有人負責） */
export function readConversationAssignee(
  data: { assigneeUid?: unknown; assigneeName?: unknown; assignedAt?: unknown } | undefined,
): ConversationAssignee {
  const uid = String(data?.assigneeUid ?? '').trim()
  if (!uid) return NO_ASSIGNEE
  return {
    uid,
    name: String(data?.assigneeName ?? '').trim(),
    assignedAtMs: toMillis(data?.assignedAt),
  }
}

/**
 * 清單那顆小圓章要印的字。
 *
 * 中文名取**最後一個字**（「王小明」→「明」）：中文姓氏重複率極高，
 * 一排「王」「王」「陳」分不出人；名字的最後一字辨識度高得多。
 * 英文名取第一個字母（大寫）。都取不到就回空字串（呼叫端不要畫那顆章）。
 */
export function assigneeInitial(name: string): string {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) return ''
  const firstWord = trimmed.split(/[\s@]+/)[0] ?? ''
  if (!firstWord) return ''
  // 有 CJK 字元就當中文名處理
  if (/[一-鿿㐀-䶿]/.test(firstWord)) {
    return firstWord.slice(-1)
  }
  return firstWord.slice(0, 1).toUpperCase()
}
