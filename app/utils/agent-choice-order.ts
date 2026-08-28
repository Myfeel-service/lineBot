import type { AgentChoice } from '~~/shared/types/agent-messages'

/**
 * agent 對話選項鈕的版面順序：**跳過／離開 → 其他 → 主要動作**（2026-08-28 拍板）。
 *
 * 規則一句話：**主要鈕放在動作群貼齊的那一端**。這排是靠右對齊的（`.agm-choices` 的
 * justify-content: flex-end），所以主要鈕要在最右——跟這個後台所有 el-dialog 頁尾、
 * ElMessageBox、以及 el-tour 的「下一步」同一側。
 *
 * 改之前是「主要鈕排第一＝最左」，實測 4 顆選項時主要鈕離右緣 382px，而右下角那個
 * 最順手的位子長期由「先跳過測試」佔著（手機寬度換行後，主要鈕還會被擠到上一行）。
 *
 * ⛔ 排序只做在呈現層：劇本的 options 陣列維持「primary 寫第一個」——讀劇本時要一眼
 *    看得出誰是主要動作，而開通引導／帶你修好劇本／小幫手三個呼叫端吃同一個元件。
 * ⛔ 用三段 filter 接起來（穩定排序），不要 sort：同一段裡的相對順序是劇本刻意排的。
 */
export function orderAgentChoices(options: readonly AgentChoice[]): AgentChoice[] {
  return [
    ...options.filter(o => o.escape),
    ...options.filter(o => !o.escape && !o.primary),
    ...options.filter(o => !o.escape && o.primary),
  ]
}
