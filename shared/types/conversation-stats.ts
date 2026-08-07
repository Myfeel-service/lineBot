export type ModuleType = 'welcome' | 'bot_flow' | 'system_notice' | 'live_agent' | 'ai'
export type InitialHandler = 'bot' | 'ai' | 'human' | 'unhandled'
export type ConversationStatus =
  | 'open'
  | 'bot_handling'
  | 'pending_human'
  | 'human_handling'
  | 'closed'
export type ConversationEventType =
  | 'conversation_opened'
  | 'entered_module'
  | 'handoff_request'
  | 'human_first_reply'
  /** 真人把對話交還機器人（手動按鈕或閒置自動交還），bot/AI 恢復接手 */
  | 'returned_to_bot'
  | 'conversation_closed'
  /**
   * 客人按了按鈕、但系統一則訊息都沒回（按鈕指向的模組被刪／停用，或找不到對應回覆）。
   * postback 本身不會存成訊息，沒有這筆的話對話畫面上完全看不出客人做過什麼——
   * 客服只會看到一筆空的待處理。帶 moduleId 表示是「指向的內容已失效」。
   */
  | 'postback_no_reply'

export type TrendGranularity = 'day' | 'week' | 'month'

/**
 * 「加好友/活動入口」出生、客人還沒開口的 session → 不進首接統計。
 * 沒有東西被「接」:算未首接會灌水(活動流量越大失真越大),算機器人首接又反向灌功;
 * 客人真的傳第一句(hasInbound)後就正常計。舊資料沒有 origin 欄位 → 不受影響照舊計入。
 */
export function isPreInboundFollowSession(s: { origin?: unknown; hasInbound?: unknown } | undefined): boolean {
  return s?.origin === 'follow' && s?.hasInbound !== true
}

export interface ConversationSessionDoc {
  workspaceId: string
  userId: string
  openedAt: FirebaseFirestore.Timestamp
  closedAt: FirebaseFirestore.Timestamp | null
  lastActivityAt: FirebaseFirestore.Timestamp
  status: ConversationStatus
  initialHandler: InitialHandler
  currentHandler: InitialHandler
  initialModuleType: ModuleType | null
  currentModuleType: ModuleType | null
  hasHandoff: boolean
  handoffRequestedAt: FirebaseFirestore.Timestamp | null
  humanFirstRepliedAt: FirebaseFirestore.Timestamp | null
  /** 真人最近一次回覆時間；閒置自動交還機器人的判斷基準（舊 session 可能沒有此欄位） */
  humanLastRepliedAt?: FirebaseFirestore.Timestamp | null
  /** SLA 提醒已發送的時間（每場會話只提醒一次） */
  slaRemindedAt?: FirebaseFirestore.Timestamp | null
  /**
   * 這場會話結束當下的最後一則訊息，給列表第二行當摘要用（見 sessionClosingPreview）。
   *
   * 只在關閉時蓋一次快照——進行中的場不需要（直接讀 conversations 那份，必定是同一則）。
   * 舊的已結束會話沒有這兩欄，列表就留白；刻意不回填，猜錯比空白更糟
   * （同 resolveMessageSender 對舊訊息的處理）。
   */
  lastMessage?: string
  lastDirection?: 'incoming' | 'outgoing'
}

export interface ConversationEventDoc {
  workspaceId: string
  sessionId: string
  userId: string
  eventType: ConversationEventType
  moduleType?: ModuleType
  moduleId?: string
  timestamp: FirebaseFirestore.Timestamp
}

export interface KpiResult {
  total: number
  botHandled: number
  aiHandled: number
  humanHandled: number
  unhandled: number
  /** 機器人首接、但之後仍轉真人的會話數（機器人沒能獨立收尾）。用來對抗「機器人首接 = 已解決」的高估 */
  botEscalated: number
  /** AI 首接、但之後仍轉真人的會話數 */
  aiEscalated: number
  handoffCount: number
  handoffRate: number
  closedCount: number
  handledCount: number
  closeRateByTotal: number
  closeRateByHandled: number
  /**
   * 區間內**第一次**加好友的人數（users.createdAt）。
   * 與對話數是兩件事：推播/加好友出生、客人沒開口的 session 不算對話（見 isPreInboundFollowSession），
   * 但「多少新朋友進來」本身是使用者要看的數字——放這裡讓摘要卡與統計頁同一來源。
   * 封鎖後解封不會重算（createdAt 不變）。
   */
  newFriends: number
  /**
   * 「沒人回」的名單樣本（最多前 3 場，照開場時間）。給昨日摘要卡點名用——
   * 從**同一批** session 取樣，跟 unhandled 數字永遠同口徑。
   * 刻意不做「篩選過的收件匣清單」：統計的「沒人回」與收件匣的「待處理」是兩群對話
   * （見 docs/CONVERSATION-STATS-DEFINITIONS.md），點名字直接開那一場對話就不會撞口徑。
   */
  unhandledSamples: { userId: string; displayName: string }[]
  /**
   * 轉真人後客人等超過 SLA 的場數（等待 = humanFirstRepliedAt − handoffRequestedAt；
   * 一直沒人接的也算——客人確實等超過了）。門檻沿用工作區設定的 slaRemindMinutes
   * （關閉時退回預設 30，見 kpi.get.ts），不另外發明新數字。
   * 窗口與其他欄位一致＝「這段期間**開場**的對話」。
   */
  handoffWaitExceeded: number
  /** 上面那個數字實際用的門檻（分鐘），給 UI 照實印，不寫死 30 */
  handoffWaitSlaMinutes: number
  /**
   * `handoffWaitExceeded` 裡「轉真人的那一刻落在服務時間外」的場數（2026-08-07 拍板選項 c）。
   *
   * 為什麼要分開講：實測 8/6 有 8 場超標、其中 7 場是晚上轉真人隔天早上才回——
   * 那不是客服慢，是下班了。全部混在一起講，這行會天天紅字，紅字天天出現就沒人看。
   * 服務時間未啟用（opt-in，預設關）時恆為 0，UI 自然不會出現這個子句。
   */
  handoffWaitOffHours: number
  /**
   * 等超過 SLA 的名單樣本（≤3）。排序刻意**把服務時間內的排前面**——
   * 真正要檢討的是「上班時間還讓客人等」的那幾場，點名要點到它們。
   */
  handoffWaitSamples: { userId: string; displayName: string }[]
}

export interface TrendBucket {
  date: string
  total: number
  bot: number
  ai: number
  human: number
  unhandled: number
  handoff: number
  closed: number
  /**
   * 這一桶的新加好友數（users.createdAt，與對話數平行的另一條資料）。
   * 可選＝查好友失敗時**整批省略**而不是裝 0——圖上缺一條線比畫一條假的 0 線誠實。
   */
  newFriends?: number
}

export const SYSTEM_MODULE_IDS = {
  welcome: 'sys_welcome',
  live_agent: 'sys_live_agent',
} as const

/** 工作區自行建立的流程可用類型（歡迎／真人僅限系統預設兩筆） */
export const WORKSPACE_FLOW_MODULE_TYPES: readonly ModuleType[] = ['bot_flow', 'system_notice']

export const MODULE_TYPE_LABELS: Record<ModuleType, string> = {
  welcome: '歡迎模組',
  bot_flow: '機器人流程',
  system_notice: '系統通知',
  live_agent: '真人客服',
  ai: 'AI 客服',
}

export const STATUS_LABELS: Record<ConversationStatus, string> = {
  open: '待處理',
  bot_handling: '機器人處理中',
  pending_human: '待真人',
  human_handling: '真人處理中',
  closed: '已結束',
}

export const INITIAL_HANDLER_LABELS: Record<InitialHandler, string> = {
  bot: '機器人首接',
  ai: 'AI 首接',
  human: '真人首接',
  unhandled: '未首接',
}

export const SESSION_24H_MS = 24 * 60 * 60 * 1000

/**
 * 「真人處理中」但真人已閒置超過此時數 → 視為卡住（AI 被暫停、客人晾著）。
 * cron 的每日積壓提醒與後台異常中心共用同一個門檻，兩邊講的數字才會一致。
 */
export const HUMAN_STALE_HOURS = 12
