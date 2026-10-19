/**
 * 「你接著回了客人——AI 這題答錯了嗎？」該掛在哪幾則 AI 回覆下面（`D-136`，2026-10-19）。
 *
 * 為什麼要有：同事更正 AI 都是直接在對話裡回客人，沒有人回頭按「為什麼這樣答 → 這題 AI 答錯了」。
 * 正式站最近 400 段對話，AI 用知識庫答了 127 次、真人 6 小時內接著回了 7 次，約 5 次是在更正
 * （出貨日過期、AI 答不出、該轉真人），**一次都沒標**。所以在「真人接著回了」的那一刻問。
 *
 * 規則：AI 那則之後，**我們送出的下一則**是真人、而且在 6 小時內 → 掛在那一則 AI 泡泡下面。
 *   - 中間客人說的話、事件列都跳過（客人追問「蛤？不是 9 月底嗎」之後真人才回，正是要抓的）
 *   - 下一則是 AI／機器人／系統就不算：AI 轉真人時那句「已為您安排專員」是機器人送的，
 *     真人接著回是本來就該發生的事，不是更正
 *   - 同一回合送了好幾則（文字＋圖）：只有最後一則後面接的是真人，所以只掛一次
 *
 * 這裡只看對話順序；「這一回合是不是 AI 用知識庫回答的、標過了沒」要另外查（見 AdminPanel）。
 */

export const HUMAN_FOLLOW_WINDOW_MS = 6 * 3600_000

export interface WrongPromptItem {
  id: string
  type: string
  direction?: 'incoming' | 'outgoing'
  sender?: string | null
  aiTurnId?: string
  atMs: number
}

export interface ReplyLookupItem extends WrongPromptItem {
  text?: string
  messageType?: string
}

/**
 * 「同事回給客人的那句」（`D-135`／`D-136`：補一條時當答案、改那一條時附在編輯視窗上）。
 * **跟掛提示同一套規則**（`/code-review` 10-19：以前另寫一份比較鬆的，往後看 10 列、遇到下一回合的 AI 也不停，
 * 會把真人回答**下一題**的話當成這一題的答案存進知識庫）：
 *   - 給 turnId：從那一回合最後一則 AI 泡泡起算
 *   - 沒有 turnId（頂部卡片，草稿模式下 AI 根本沒送訊息）：從 sinceMs（那次 AI 判斷的時間）起算——
 *     ⛔ 不可以退回「最後一則 AI 訊息」：草稿模式下那會是好幾天前自動模式時期的，帶進來的是不相干的舊回覆
 *   - 往後：跳過客人說的話與事件列；我們送出的下一則是真人才算（連續幾則真人取第一則文字），
 *     遇到 AI／機器人／系統就停；超過 6 小時不算
 * 找不到回空字串（他自己寫）。
 */
export function humanReplyAfter(
  items: readonly ReplyLookupItem[],
  from: { turnId?: string; sinceMs?: number },
  windowMs = HUMAN_FOLLOW_WINDOW_MS,
): string {
  const turnId = String(from.turnId ?? '').trim()
  let start = -1
  let startMs = 0
  if (turnId) {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i]!.aiTurnId === turnId) { start = i; startMs = items[i]!.atMs; break }
    }
  }
  else if (from.sinceMs && from.sinceMs > 0) {
    startMs = from.sinceMs
    start = items.findIndex(it => it.atMs > startMs) - 1
    if (start < -1) return '' // 那個時間點之後什麼都沒有
  }
  if (!startMs || (turnId && start < 0)) return ''
  for (let j = start + 1; j < items.length; j++) {
    const n = items[j]!
    if (n.type !== 'message') continue
    if (!n.atMs || n.atMs - startMs > windowMs) return ''
    if (n.direction !== 'outgoing') continue
    if (n.sender !== 'human') return ''
    if ((n.messageType ?? 'text') !== 'text') continue
    const text = String(n.text ?? '').trim()
    if (text) return text
  }
  return ''
}

/** 回傳 turnId → 提示要掛在哪一則（那一回合最後一則 AI 泡泡的 id）；items 要照時間排好 */
export function humanFollowedAiTurns(
  items: readonly WrongPromptItem[],
  windowMs = HUMAN_FOLLOW_WINDOW_MS,
): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!
    const turnId = String(it.aiTurnId ?? '').trim()
    if (it.type !== 'message' || it.direction !== 'outgoing' || it.sender !== 'ai' || !turnId) continue
    for (let j = i + 1; j < items.length; j++) {
      const n = items[j]!
      if (n.type !== 'message') continue
      // 時間讀不到（0）不當成「很久以後」：寧可不掛，也不要掛在不知道隔多久的那一則
      if (!it.atMs || !n.atMs || n.atMs - it.atMs > windowMs) break
      if (n.direction !== 'outgoing') continue
      if (n.sender === 'human') out.set(turnId, it.id)
      break
    }
  }
  return out
}
