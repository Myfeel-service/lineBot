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
