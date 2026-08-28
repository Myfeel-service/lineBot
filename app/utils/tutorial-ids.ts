/**
 * 教學主題 id 常數——**刻意獨立成一個沒有相依的小檔**（2026-08-28 code review 修）。
 *
 * 為什麼不放在 `tutorial-topics.ts`：那支檔案是一千行的教學內容，而且會 import 二十幾個
 * Element Plus 圖示元件。開通頁（`layout: false`）原本完全不碰教學系統，只為了讀一個
 * 十個字的字串就把整套內容與圖示拉進它的 chunk——那是新客戶開的第一個頁面，最在意快不快。
 *
 * ⛔ 這個檔案永遠不要 import 任何東西。加新常數可以，加相依不行。
 */

/** 「認識後台」總覽導覽：開通結尾交棒過去的那一支 */
export const OVERVIEW_TOPIC_ID = 'overview'
