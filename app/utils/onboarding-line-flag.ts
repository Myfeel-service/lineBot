/**
 * 「接 LINE 那一趟做到一半」的一次性旗標（`D-88` ②，2026-09-24 拍板；`C-250` 落地）。
 *
 * ── 為什麼要有它 ─────────────────────────────────────────────
 * 以前的規則是「開通沒做完（LINE 沒接）就**每次整頁載入**都拉回精靈」（08-19）。
 * 拆成「打造」「接 LINE」兩趟之後，打造完**本來就是先進後台**、接 LINE 是他之後自己決定的事——
 * 照舊每次拉回，等於每按一次 F5 就被抓去做一件他說了「之後再說」的事。
 * ⭐ 改成**只拉回接到一半離開的人，而且只拉一次**：
 *   - 開始接 LINE ＝立旗；接完（走到成績單）或自己按「之後再說」＝收旗
 *   - 旗還在（關分頁、斷線、瀏覽器當掉）＝下次進後台拉回一次，拉的同時收旗
 * ⛔ 跟 08-20 拆掉的「每步跳過記憶」不同：這不記「他跳過了哪一步」，只記「那一趟沒走完」。
 *
 * ⚠️ 存在 localStorage：換裝置就沒有了——那是可以接受的代價（紅帶、紅點、小幫手三處照樣都在）。
 *    ⛔ 讀寫一律包 try/catch：私密瀏覽或被封鎖的 storage 會直接 throw，不能讓它弄壞後台版型。
 */

const KEY_PREFIX = 'minime:onb-line-inprogress:'

export function markLineFlowInProgress(workspaceId: string): void {
  if (!workspaceId) return
  try { localStorage.setItem(KEY_PREFIX + workspaceId, String(Date.now())) }
  catch { /* storage 不可用就算了：最壞只是不會被拉回 */ }
}

export function clearLineFlowInProgress(workspaceId: string): void {
  if (!workspaceId) return
  try { localStorage.removeItem(KEY_PREFIX + workspaceId) }
  catch { /* 同上 */ }
}

export function isLineFlowInProgress(workspaceId: string): boolean {
  if (!workspaceId) return false
  try { return localStorage.getItem(KEY_PREFIX + workspaceId) != null }
  catch { return false }
}
