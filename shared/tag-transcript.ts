/**
 * 「哪些訊息算得上『這位客人在這一場說過的話』」——兩支貼標掃描器共用的唯一一份規則。
 *
 * 為什麼放 shared 而不是各寫一份：`ai-tag-suggest`（每場挑既有標籤）與 `tag-discovery`
 * （每週找新主題）都要從訊息堆裡抽同一種東西，2026-09-03 稽核時發現**兩支都抽錯**，
 * 而只修了一支就會變成同一個 bug 修一半（`C-131`／`C-132`）。規則只留一份。
 *
 * 三條紅線都是線上實害，不是預防性設計：
 *
 * ⛔ **只算這一場**（`startMs` ≤ 訊息時間 ≤ `endMs`）。先前撈的是「這位客人最近 N 則」，
 *   跟觸發它的那一場沒有任何時間關係：Sam 在 8/29 只點了一次問卷登記、那場一個字都沒說，
 *   系統翻出他 **5 月**的退貨對話貼「退換貨處理中」（另有三位是拿 6、7 月的舊對話貼今天的
 *   標籤）。下游是推播分眾——「這個月要退貨的人」名單混進三個月前結案的客人＝發錯人。
 * ⛔ **上界一樣要守**。只設下界的話，排程晚一點跑到某場時，**後面那場**的訊息會變成
 *   前一場的證據（同一位客人一天內講兩輪很常見），錯的方向不同、性質一模一樣。
 * ⛔ **只留客人說的話**（`outgoing` 全部不要，含真人客服）。先前店家與機器人的訊息也在
 *   裡面，問卷登記的自動回覆「恭喜你成功啟動專屬開賣通知」就這樣繞回來當證據：Alice 本人
 *   只問過一次麥克風，卻拿到 5 條建議，其中 3 條的理由白紙黑字寫著「客人收到多則開賣通知」
 *   「店家傳送了…專屬折扣碼」。prompt 本來就有「店家說的話不能當依據」這條規則，但那些話
 *   佔了逐字稿一大半，一句規則擋不住權重——**唯一可靠的做法是不給看**。
 *   ⚠️ 真人客服的話也排除是刻意的：所有標籤的判斷條件都是「客人詢問／回報／提出…」，
 *   我們自己說的話本來就不構成依據，留著就是留一條同款的洩漏路徑（實例：Benjamin Chen
 *   的建議理由是「店家回覆將於 9 月中旬出貨」）。
 */
import { isCustomerActionMessage } from './customer-action'

/** 一則訊息在這支眼中的形狀（抽出來讓測試不用組 Firestore doc） */
export interface TranscriptRow {
  direction?: string
  text?: string
  messageType?: string
  /** Firestore Timestamp；測試給 `{ toMillis: () => ms }` 就好 */
  timestamp?: unknown
}

/** 一場對話的時間範圍（兩端都含） */
export interface SessionWindow {
  startMs: number
  endMs: number
}

/** 一行逐字稿最多帶幾個字（`ai-tag-suggest` 用整句、`tag-discovery` 會再壓一次） */
export const TRANSCRIPT_LINE_MAX = 300

/** 一場對話的上限（24h 換場規則）；只在會話文件缺 `openedAt` 時當退路 */
export const SESSION_MAX_MS = 24 * 60 * 60 * 1000

function toMs(raw: unknown): number {
  const v = raw as { toMillis?: () => number } | null | undefined
  return typeof v?.toMillis === 'function' ? v.toMillis() : 0
}

/**
 * 從會話文件算出「這一場」的時間範圍。
 *
 * ⛔ **算不出來就回 `null`，呼叫端要跳過這一場**，不可以退回「不限時間」：
 *   舊版的退路是 `lastActivityAt - 24h`，而 `lastActivityAt` 讀不到時 `tsToMs` 回 0，
 *   結果是 **-86400000**＝比不設下界更寬鬆，剛修好的過濾當場失效（審查抓到的）。
 *   這支的失敗方向一律選「這場不產生建議」，那是安全的那一邊。
 */
export function sessionWindow(sess: {
  openedAt?: unknown
  closedAt?: unknown
  lastActivityAt?: unknown
}): SessionWindow | null {
  // 上界：關閉時間優先（關閉後不該再有訊息屬於這場），退路是最後活動時間
  const endMs = toMs(sess.closedAt) || toMs(sess.lastActivityAt)
  if (!endMs) return null
  const startMs = toMs(sess.openedAt) || Math.max(0, endMs - SESSION_MAX_MS)
  if (startMs > endMs) return null
  return { startMs, endMs }
}

/**
 * 挑出「這一場裡、客人自己說過的話」，順序照傳進來的順序（呼叫端負責由舊到新）。
 *
 * ⛔ 沒有時間戳的訊息一律丟掉（不是當成 0 保留）：分不出它屬於哪一場，寧可少一行也不要
 *   把舊帳算進來。
 */
export function pickCustomerLines(rows: TranscriptRow[], win: SessionWindow): string[] {
  return rows
    .filter((m) => {
      if (m.direction !== 'incoming') return false
      if (isCustomerActionMessage(m.messageType)) return false // 按鈕、加好友、活動登記不是「說的話」
      const ts = toMs(m.timestamp)
      return ts > 0 && ts >= win.startMs && ts <= win.endMs
    })
    .map(m => String(m.text ?? '').trim().slice(0, TRANSCRIPT_LINE_MAX))
    .filter(Boolean)
}
