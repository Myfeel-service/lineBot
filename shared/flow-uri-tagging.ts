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

/** 一顆按鈕算不算「開了貼標的網址按鈕」 */
function isTaggedUriAction(node: Record<string, unknown>): boolean {
  if (String(node.type ?? '') !== 'uri') return false
  const tagging = node.tagging as { enabled?: unknown, addTagIds?: unknown } | undefined
  if (!tagging || typeof tagging !== 'object') return false
  if (tagging.enabled !== true) return false
  return Array.isArray(tagging.addTagIds) && tagging.addTagIds.some(id => String(id ?? '').trim())
}

/**
 * 深走訪整份 `messages`，數出開了貼標的網址按鈕有幾顆。
 * ⚠️ 走訪要夠深：按鈕藏在輪播的每一張卡、圖文訊息的每一格、快速回覆的每一顆裡，
 *    只看第一層會數成 0——而數成 0 的後果是「該提醒的時候沒提醒」，比多提醒糟。
 */
export function countTaggedUriButtons(messages: unknown): number {
  let count = 0
  const walk = (node: unknown, depth: number) => {
    // 深度上限純粹是防呆（正常資料遠不到），⛔ 不是拿來省事的
    if (!node || typeof node !== 'object' || depth > 12) return
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
