/**
 * 對話列表的「人工標記」：釘選、待跟進。
 *
 * ⚠️ 為什麼叫「待跟進」而不是「待處理」——
 *    「待處理」這個詞在收件匣側欄已經有主人了：`conversationSessions.status === 'open'`，
 *    意思是「這場對話還需不需要**人**處理」，由系統依實際訊息流判定，而且同時餵統計看板的
 *    首接／結案率（見 docs/CONVERSATION-STATS-DEFINITIONS.md）。
 *    這裡是客服自己手動標的「我要回頭跟這筆」，兩件事不同：
 *
 *      待處理（分頁）＝ 系統說「還沒有人處理」
 *      待跟進（標記）＝ 人說「我等一下要回來看」
 *
 *    同一頁出現兩個「待處理」會被誤讀成同一個數字，所以人工標記讓位，改叫待跟進。
 *
 * 兩個標記都存在 `conversations/{docId}` 上、獨立欄位、**不進任何統計**，
 * 只影響對話列表怎麼排序與顯示。全 workspace 共用（誰標記的同事都看得到）。
 */

/** 釘選上限：釘到蓋滿第一頁就等於沒有釘選 */
export const MAX_PINNED_CONVERSATIONS = 50

/** 「只看待跟進」一次顯示的上限（超過就在畫面上明講被截斷，不假裝全部都在） */
export const FOLLOW_UP_LIST_LIMIT = 200

export interface ConversationManualFlags {
  /** 釘在對話列表最上面 */
  pinned: boolean
  /** 客服手動標「我要回頭跟這筆」；與會話狀態無關 */
  followUp: boolean
}

/** 由 `conversations` 文件資料讀出人工標記（欄位不存在 = 沒標記） */
export function readConversationFlags(
  data: { pinnedAt?: unknown; followUpAt?: unknown } | undefined,
): ConversationManualFlags {
  return {
    pinned: Boolean(data?.pinnedAt),
    followUp: Boolean(data?.followUpAt),
  }
}

/**
 * 把釘選那幾筆放到這一頁最前面。
 *
 * `pinnedRows` 只有第一頁會給（其他頁不重複顯示釘選區）；但 `pinnedIds` **每一頁都要給**，
 * 因為釘選的對話在時間序裡本來就有自己的位置——不從本頁濾掉的話，它會在第一頁的釘選區
 * 和它原本的頁次各出現一次（v-for 重複 key，畫面上就是同一個人出現兩次）。
 *
 * 注意：這裡會讓某些頁次少於 limit 筆，那是對的；hasMore 要用「Firestore 原始這一頁抓了幾筆」
 * 去算，不能用這個函式的回傳長度，否則會提早判定沒有下一頁。
 */
export function withPinnedFirst<T extends { userId: string }>(
  pinnedRows: T[],
  pageRows: T[],
  pinnedIds: ReadonlySet<string>,
): T[] {
  return [...pinnedRows, ...pageRows.filter(row => !pinnedIds.has(row.userId))]
}
