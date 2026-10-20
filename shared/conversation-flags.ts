/**
 * 對話列表的人工標記：**待跟進**（客服手動標「我要回頭跟這筆」，排在列表最上面）。
 *
 * ── `H-17`（2026-10-20 老闆「照建議」）：原本的「釘選」直接改名叫「待跟進」 ──
 * 以前有兩個標記：釘選（`pinnedAt`，置頂＋📌）與待跟進（`followUpAt`，一顆膠囊＋要先開篩選才看得到）。
 * 正式庫 10-19／10-20 盤點：MYFEEL 釘選 10 筆、待跟進 0 筆——那 10 筆的內容全是
 * 「已協助您詢問廠商，待廠商回應」這種**等外部回覆的案子**，大家其實都拿釘選當待跟進用。
 * 所以把釘選改名成待跟進（圖示 🚩、用字、區塊標題一起改），舊的待跟進標記與入口拿掉。
 *
 * ⚠️ **資料欄位沿用 `pinnedAt`，不搬資料**：現有 10 筆照樣是待跟進。
 *    舊的 `followUpAt` **不再讀也不再寫**：兩個專案合計只有 1 筆（「Myfeel Test」08-06 功能上線當天測的那筆），
 *    而那一筆同時也有 `pinnedAt`＝已經算在待跟進裡，所以不併、不寫遷移腳本。
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
 * 標記存在 `conversations/{docId}` 上、**不進任何統計**，只影響對話列表怎麼排序與顯示。
 * 全 workspace 共用（誰標記的同事都看得到）。
 */

/** 待跟進上限：標到蓋滿第一頁就等於沒有標（列表第一頁也只撈這麼多筆置頂） */
export const MAX_PINNED_CONVERSATIONS = 50

/** 待跟進的圖示與名字：右鍵選單、列上、區塊標題、客人檔案都吃這一份（⛔ 不要各寫各的） */
export const FOLLOW_UP_ICON = '🚩'
export const FOLLOW_UP_LABEL = '待跟進'

export interface ConversationManualFlags {
  /** 待跟進（欄位名沿用 `pinnedAt`：`H-17` 之前叫「釘選」） */
  pinned: boolean
}

/** 由 `conversations` 文件資料讀出人工標記（欄位不存在 = 沒標記）。⛔ 舊的 `followUpAt` 不讀（見檔頭） */
export function readConversationFlags(
  data: { pinnedAt?: unknown } | undefined,
): ConversationManualFlags {
  return {
    pinned: Boolean(data?.pinnedAt),
  }
}

/**
 * 右鍵／⋯ 選單上的那一項（`H-17`：只剩待跟進一項）。
 * key 沿用 `pin`：送出去的欄位還是 `pinned`。
 */
export function followUpMenuItems(target: { pinned?: boolean }): Array<{ key: 'pin', icon: string, label: string }> {
  return [{
    key: 'pin',
    icon: FOLLOW_UP_ICON,
    label: target.pinned ? `取消${FOLLOW_UP_LABEL}` : `標記${FOLLOW_UP_LABEL}`,
  }]
}

/**
 * 把待跟進那幾筆放到這一頁最前面。
 *
 * `pinnedRows` 只有第一頁會給（其他頁不重複顯示待跟進區）；但 `pinnedIds` **每一頁都要給**，
 * 因為待跟進的對話在時間序裡本來就有自己的位置——不從本頁濾掉的話，它會在第一頁的待跟進區
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
