/**
 * 「舊訊息的可搜尋片段補到哪了」——回填腳本寫、搜尋 API 讀。
 *
 * 為什麼需要這份狀態：片段（`messages.searchTokens`）是 2026-09-11 才開始寫的，
 * 在那之前的訊息要靠 scripts/backfill-message-search-tokens.ts 補。沒補之前，
 * 對話內容搜尋只找得到新進來的訊息——那是一個「看起來正常但漏掉九成內容」的狀態，
 * 畫面一定要說得出來，否則客服搜不到上個月那句話會以為客人沒講過。
 *
 * 刻意放在自己的集合、不寄在 `workspaces/{id}` 上：那份文件放的是 LINE 憑證，
 * 為了一個進度欄位去 merge 它，風險與好處完全不成比例。
 */
export const MESSAGE_SEARCH_STATE_COLLECTION = 'messageSearchIndex'

export type MessageSearchIndexState = {
  /** 這一輪回填開始的時間 */
  startedAt?: unknown
  /** 跑完整輪才寫。沒有這個值＝還沒回填完，搜尋要降級說明 */
  completedAt?: unknown
  /** 回填涵蓋到的最舊訊息時間（毫秒）：畫面用它講「找得到 X 月 X 日之後的訊息」 */
  oldestIndexedMs?: number
  /** 這一輪補了幾則（只是給人看的紀錄，不參與判斷） */
  indexedMessages?: number
  /** 回填時用的片段規則版本：規則改了就得重跑，對不上時看這個 */
  tokenVersion?: number
}

/**
 * 片段規則版本。改了 shared/message-search.ts 的切法（長度、折疊規則）就要 +1，
 * 並重跑回填——否則新舊訊息用兩套規則存片段，搜尋會時好時壞。
 */
export const MESSAGE_SEARCH_TOKEN_VERSION = 1
