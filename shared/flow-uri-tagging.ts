/**
 * 「這個模組裡有幾顆**開了貼標的網址按鈕**」（`C-238`）。
 *
 * **為什麼要數它**：網址按鈕的貼標是靠「把網址換成一條**每個人專屬**的連結」做到的
 * （`resolveUriWithTagging` → `/api/t/<token>`，token 裡包著那個人的 id 與要貼的標籤）。
 * 客人從圖文選單、模組按鈕點進去都有效。
 *
 * ⛔ **但推播沒辦法**：推播是一次把**同一份**訊息送給一群人（LINE 的 multicast 一次最多 500 人），
 *    那份訊息裡只能放一條大家共用的網址，所以認不出是誰點的。
 *    程式上的表現是 `broadcast-send.ts` 沒帶 `userId`，而 `resolveUriWithTagging`
 *    在沒有 `userId` 時**安靜地退回原網址**——開關是開的、標籤就是沒貼、畫面上一個字都沒講。
 *
 * 所以推播編輯器要在選到這種模組時講一句。這支只負責「數出來」，話怎麼講在元件那邊。
 */

/**
 * 一顆按鈕算不算「開了貼標的網址按鈕」。
 *
 * ⛔ `enabled` 要用**真假值**判斷，不可以寫成 `enabled !== true`（`C-241`⑥）。
 * 這支是在回答「送出去的時候會不會被影響」，所以判斷方式必須跟**執行時**那一支一致：
 * `server/utils/handler.ts` 的 `extractTagIdsFromAction` 寫的是 `if (!action?.tagging?.enabled) return []`。
 * 兩邊不一致的話，`enabled: 1` 或 `"true"` 這種舊資料／匯入資料**執行時會貼標、這裡卻數成 0**
 * ＝那顆按鈕真的受影響，畫面上卻不提醒——正好是這支檔案要防的那件事。
 * ⚠️ `config-references.ts` 用的是嚴格 `=== true`，那是**另一個問題**（「算不算用到這顆標籤」），
 *    不要照抄過來。
 */
function isTaggedUriAction(node: Record<string, unknown>): boolean {
  if (String(node.type ?? '') !== 'uri') return false
  const tagging = node.tagging as { enabled?: unknown, addTagIds?: unknown } | undefined
  if (!tagging || typeof tagging !== 'object') return false
  if (!tagging.enabled) return false
  return Array.isArray(tagging.addTagIds) && tagging.addTagIds.some(id => String(id ?? '').trim())
}

/**
 * 走訪深度上限，純粹是防呆（防自我參照的資料把走訪變成無窮迴圈），⛔ 不是拿來省事的。
 *
 * ⚠️ **物件算一層、陣列也算一層**，所以這個數字要換算：一層巢狀 Flex box ≈ 吃掉 2，
 * 而 `messages[] → message → contents → bubble → body` 開場就先吃掉 4～6（輪播再多 2）。
 * 原本設 12 ＝ 只走得進大約 4 層巢狀 box，稍微複雜一點的卡片就會**數成 0**
 * ——而數成 0 的後果是「該提醒的時候沒提醒」，比多提醒糟（`C-241`③）。
 * 30 對應大約 12 層巢狀 box，遠超過任何看得下去的版面。
 */
const MAX_WALK_DEPTH = 30

/**
 * 深走訪整份 `messages`，數出開了貼標的網址按鈕有幾顆。
 * ⚠️ 走訪要夠深：按鈕藏在輪播的每一張卡、圖文訊息的每一格、快速回覆的每一顆裡，
 *    只看第一層會數成 0——而數成 0 的後果是「該提醒的時候沒提醒」，比多提醒糟。
 */
export function countTaggedUriButtons(messages: unknown): number {
  let count = 0
  const walk = (node: unknown, depth: number) => {
    if (!node || typeof node !== 'object' || depth > MAX_WALK_DEPTH) return
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1)
      return
    }
    const obj = node as Record<string, unknown>
    if (isTaggedUriAction(obj)) count += 1
    for (const value of Object.values(obj)) walk(value, depth + 1)
  }
  walk(messages, 0)
  return count
}
