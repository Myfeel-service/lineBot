import type { ConversationEventType, ConversationStatus, ModuleType } from './conversation-stats'
import type { MessageSender } from '../message-sender'

/**
 * 對話時間軸 API 的形狀（`GET /api/conversations/:userId/messages`）。
 *
 * 為什麼放在 shared/：這是跨前後端的**契約**。先前兩邊各宣告一份，而且已經漂走了——
 * 後端有 moduleId、eventType／moduleType 是列舉，前端那份少了 moduleId、把列舉放寬成
 * string，還多留了一個後端早就不回的欄位。兩份都「編得過」，所以沒有人會發現。
 */

export type TimelineItemType = 'message' | 'event' | 'broadcast'

export interface TimelineItem {
  id: string
  /** broadcast＝群發標記，後端讀取時才拼進來（不是真的訊息文件），與 event 同樣渲染 */
  type: TimelineItemType
  /** Firestore 時間欄位（序列化後有好幾種樣子，一律用 parseFirestoreDate 讀） */
  timestamp: unknown
  // ── 訊息 ──
  direction?: 'incoming' | 'outgoing'
  /** 出站訊息：對方在 lastPeerActivityAt 之前有互動／來訊時推定已讀（非 LINE 內建已讀） */
  readByPeer?: boolean
  text?: string
  messageType?: string
  payload?: unknown
  /** 客人傳的圖，AI 讀出來的一句說明（沒讀到或 AI 未啟用就是空字串） */
  mediaDescription?: string
  /** 這則是誰回的：真人 / AI / 機器人 / 系統。null＝這功能上線前的舊訊息，前端不掛標籤 */
  sender?: MessageSender | null
  senderName?: string
  /**
   * 這則是哪一次 AI 回合送出的（見 AiTurnDoc）。有值才給「為什麼這樣答」的入口——
   * 空字串＝這功能上線前的舊訊息，刻意不用時間去猜是哪一回合。
   */
  aiTurnId?: string
  // ── 事件 ──
  eventType?: ConversationEventType
  /** entered_module 事件進的是哪一種模組 */
  moduleType?: ModuleType
  moduleId?: string
  label?: string
  // ── 群發 ──
  broadcastId?: string
}

/** 一場會話：給工具列、AI 脈絡卡窗口，也用來界定事件要撈哪幾場 */
export interface TimelineSessionMeta {
  sessionId: string
  status: ConversationStatus
  statusLabel: string
  /**
   * 這場的時間範圍。AI 脈絡卡要靠它判斷「手上那張脈絡是不是這場的」——
   * aiMeta 每位客人只有一張、每次互動覆寫，看舊會話時它講的是之後的事。
   * 結束時間為 0 ＝還在進行中；前端剛點進來、時間軸還沒回來時可能整個沒有。
   */
  openedAtMs?: number
  closedAtMs?: number
}

export interface TimelineResponse {
  items: TimelineItem[]
  /** 上面還有更早的一段（往上滑就讀） */
  hasOlder: boolean
  /** 下面還有更晚的一段：點進已結束的舊會話時才會有，代表現在看的不是對話的最後 */
  hasNewer: boolean
  /** 這位客人目前進行中的那一場（可能是 null＝沒有進行中的會話） */
  activeSession: TimelineSessionMeta | null
  /** 帶了 ?sessionId= 時，那一場的資料 */
  session: TimelineSessionMeta | null
}
