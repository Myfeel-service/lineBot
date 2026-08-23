import type { Timestamp, FieldValue } from 'firebase-admin/firestore'

// ═══════════════════════════════════════════════════════════════════
//  Collection: tags
//  Doc ID: uuid
// ═══════════════════════════════════════════════════════════════════

export type TagStatus = 'active' | 'inactive'

/**
 * member_status  – 例如 vip、new_friend、blocked_risk
 * interest       – 例如 interest_food、interest_travel
 * behavior       – 例如 buyer、cart_abandon、clicked_promo
 * activity       – 例如 event_2025q2、campaign_mothersday
 * custom         – 自訂標籤，無法歸類到以上
 */
export type TagCategory = 'member_status' | 'interest' | 'behavior' | 'activity' | 'custom'

export interface TagDoc {
  workspaceId: string
  /** 同一 workspace 內唯一；英文小寫加底線，程式內部使用。例如 interest_food */
  code: string
  /** 顯示名稱，給後台營運人員看 */
  name: string
  category: TagCategory
  /** hex 色碼，用於後台顯示標籤色塊 */
  color: string
  description: string
  status: TagStatus
  createdBy: string
  createdAt: Timestamp | FieldValue
  updatedAt: Timestamp | FieldValue
}

// ═══════════════════════════════════════════════════════════════════
//  Collection: userTags
//  Doc ID: `${userId}_${tagId}`（確保唯一，避免重複貼標）
// ═══════════════════════════════════════════════════════════════════

/**
 * manual  – 後台手動操作
 * import  – CSV 匯入
 * rule    – 自動化規則觸發（Phase 3）
 * system  – 系統事件觸發，例如加入好友、完成購買、「N 天沒互動」（inactive-tag.ts）
 * ai      – AI 讀對話建議、**人按了採用**才貼上（D-24 建議式；ai-tag-suggest.ts）。
 *           出錯要追得回來：來源標 ai 的都能在客人單頁一眼看出、且 tagLogs 有紀錄
 */
export type UserTagSourceType = 'manual' | 'import' | 'rule' | 'system' | 'ai'

export interface UserTagDoc {
  workspaceId: string
  userId: string
  tagId: string
  sourceType: UserTagSourceType
  /** 對應來源的參考 ID，例如批次任務 ID、規則 ID */
  sourceRefId: string | null
  /** 操作者的 uid（system 事件時為 null） */
  createdBy: string | null
  createdAt: Timestamp | FieldValue
}

// ═══════════════════════════════════════════════════════════════════
//  Collection: tagLogs
//  Doc ID: uuid
//  用途：稽核、問題追查，不做刪除
// ═══════════════════════════════════════════════════════════════════

export type TagOpAction = 'add' | 'remove'

// ═══════════════════════════════════════════════════════════════════
//  Collection: userTagSuggestions
//  Doc ID: `${workspaceId}_${lineUserId}`（與 users / conversations 同一把 key，一人一份）
//
//  AI 讀對話貼標的收件匣（D-24 建議式）：AI 只把建議寫進 pending，人按「採用」
//  才真的寫 userTags（sourceType='ai'）。忽略的 tagId 永久記在 dismissedTagIds——
//  ⛔ 判過的不再重生（同 AI 學習迴圈的鐵律），否則同一個建議每場對話都回來一次。
// ═══════════════════════════════════════════════════════════════════

export interface UserTagSuggestionPending {
  tagId: string
  /** AI 的一句話依據（給店家看的，30 字內） */
  reason: string
  /** 產生這條建議的那場會話 */
  sessionId: string
  suggestedAtMs: number
}

export interface UserTagSuggestionDoc {
  workspaceId: string
  /** users 主鍵：`${workspaceId}_${lineUserId}` */
  userId: string
  pending: UserTagSuggestionPending[]
  /**
   * `pending.length > 0` 的鏡像欄位，**每一個會動到 pending 的寫入點都要維護**
   * （掃描器、採用／忽略、手動貼標時的剪枝）。
   * 為什麼要多存一份：列表「只看有 AI 建議的」要用等值查詢撈——Firestore 查不了「陣列非空」。
   *
   * ⚠️ 標成選填是誠實不是偷懶：欄位是 2026-08-23 才加的，更早寫進去的建議文件沒有它
   * （功能預設關，實務上幾乎不存在，但型別不該聲稱一定有）。讀的時候一律 `=== true`。
   */
  hasPending?: boolean
  /** 忽略過的標籤——永久不再建議（採用過的不在此列：已貼上，由 userTags 天然擋掉） */
  dismissedTagIds: string[]
  createdAt: Timestamp | FieldValue
  updatedAt: Timestamp | FieldValue
}

export interface TagLogDoc {
  workspaceId: string
  action: TagOpAction
  userId: string
  tagId: string
  sourceType: UserTagSourceType
  sourceRefId: string | null
  operatorId: string | null
  createdAt: Timestamp | FieldValue
}

// ═══════════════════════════════════════════════════════════════════
//  Collection: audiences
//  Doc ID: uuid
// ═══════════════════════════════════════════════════════════════════

export type AudienceType = 'dynamic' | 'static'

export interface AudienceCondition {
  /**
   * includeAny  – 包含任一標籤（OR）
   * includeAll  – 包含所有標籤（AND）
   * excludeAny  – 排除任一標籤
   */
  type: 'includeAny' | 'includeAll' | 'excludeAny'
  tagIds: string[]
}

export interface AudienceFilter {
  conditions: AudienceCondition[]
  /** ISO 8601 日期字串，限制加入好友時間 */
  joinedAfter: string | null
  joinedBefore: string | null
  /** null = 不限制 */
  isBlocked: boolean | null
}

export interface AudienceDoc {
  workspaceId: string
  name: string
  description: string
  audienceType: AudienceType
  filter: AudienceFilter
  estimatedCount: number
  lastCalculatedAt: Timestamp | null
  createdBy: string
  createdAt: Timestamp | FieldValue
  updatedAt: Timestamp | FieldValue
}

// ═══════════════════════════════════════════════════════════════════
//  Collection: broadcasts
//  Doc ID: uuid
// ═══════════════════════════════════════════════════════════════════

export type BroadcastStatus =
  | 'draft'
  | 'scheduled'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type BroadcastChannel = 'line'

export type BroadcastAudienceSourceType = 'all' | 'tags' | 'audience' | 'import'

export interface BroadcastAudienceSource {
  type: BroadcastAudienceSourceType
  /** type === 'tags' 時使用 */
  tagIds?: string[]
  /** type === 'audience' 時使用 */
  audienceId?: string
  /** type === 'import' 時使用（LINE userId 陣列） */
  importedUserIds?: string[]
}

export interface BroadcastDoc {
  workspaceId: string
  name: string
  status: BroadcastStatus
  channel: BroadcastChannel
  audienceSource: BroadcastAudienceSource
  /**
   * 發送當下的受眾快照，保留歷史可追查
   * resolvedUserIds 在點擊「發送」時才寫入
   */
  audienceSnapshot: {
    filter: AudienceFilter | null
    resolvedUserIds: string[]
    estimatedCount: number
  }
  /** LINE messagingApi.Message[] 快照 */
  messages: any[]
  /**
   * 發送 multicast 時帶入的 LINE customAggregationUnits[0]，
   * 用於 insight 查詢開封（uniqueImpression）與 LINE 官方網址點擊（uniqueClick）
   */
  lineAggregationUnit?: string | null
  /**
   * 發送時是否成功帶上 LINE customAggregationUnits。
   * false 時無法以 Insight 查開封數（可能曾 400 改為無彙總重試）。
   */
  lineInsightAggregationApplied?: boolean | null
  /**
   * 訊息已送出、但發送後的記帳（deliveries／最終統計）未寫完時的原因。
   * status 仍照 LINE 實際送達結果寫；此欄位供報表提示紀錄可能不完整。
   */
  postSendError?: string | null
  /**
   * status='failed' 時給人看的失敗說明（含看門狗收殮卡死單時寫的「能否安全補發」判定）。
   * ⛔跟 postSendError 是兩回事：postSendError＝「訊息其實送出去了，只是帳沒記完」，
   * failureReason＝「這次發送真的失敗了」。措辭一律取 shared/broadcast-failure.ts。
   */
  failureReason?: string | null
  /**
   * 被「重設為草稿再發一次」重設過幾次（第一次發送時不存在／0）。
   * 用途是給 LINE 的彙總單位加上第幾次，讓重發後的開封／點擊不會跟上一次疊在一起。
   */
  retryCount?: number
  scheduleAt: Timestamp | null
  startedAt: Timestamp | null
  completedAt: Timestamp | null
  /** 統計欄位，發送過程即時更新 */
  totalCount: number
  sentCount: number
  failedCount: number
  skippedCount: number
  createdBy: string
  createdAt: Timestamp | FieldValue
  updatedAt: Timestamp | FieldValue
}

// ═══════════════════════════════════════════════════════════════════
//  Sub-collection: broadcasts/{campaignId}/deliveries
//  Doc ID: uuid
//
//  只記「沒收到的人」（deliveryStatus='failed'），成功者不逐筆記錄：
//  受眾名單已存在 broadcasts.audienceSnapshot.resolvedUserIds，
//  成功＝名單減掉這裡的失敗名單；且 LINE 的「成功」只代表它收下訊息，
//  不代表客人看到（那是報表的開封數）。全員送達時本子集合不會有任何文件。
//  2026-08 之前的推播仍留有 'sent' 文件，讀取端一律只查 'failed'。
// ═══════════════════════════════════════════════════════════════════

export type DeliveryStatus = 'pending' | 'sent' | 'failed' | 'skipped'

export interface BroadcastDeliveryDoc {
  campaignId: string
  /** Firestore users 集合的 doc ID（{workspaceId}_{lineUserId}） */
  userId: string
  /** 新寫入一律是 'failed'；其餘值只存在於舊資料 */
  deliveryStatus: DeliveryStatus
  failureReason: string | null
  /** 寫入時為 FieldValue（serverTimestamp），讀出為 Timestamp */
  sentAt: Timestamp | FieldValue | null
  createdAt: Timestamp | FieldValue
}

// ═══════════════════════════════════════════════════════════════════
//  Collection: broadcastClickLogs
//  Doc ID: uuid
// ═══════════════════════════════════════════════════════════════════

export interface BroadcastClickLogDoc {
  workspaceId: string
  campaignId: string
  /** 對應 broadcasts/{id}/deliveries 的 doc ID */
  deliveryId: string | null
  userId: string | null
  /** 對應按鈕或連結的識別 key，例如 btn_0, btn_1 */
  linkKey: string
  targetUrl: string
  clickedAt: Timestamp | FieldValue
}

// ═══════════════════════════════════════════════════════════════════
//  Collection: automationRules  （Phase 3 預留）
//  Doc ID: uuid
// ═══════════════════════════════════════════════════════════════════

export type RuleTriggerType = 'follow' | 'click' | 'schedule' | 'purchase'
export type RuleActionType = 'add_tag' | 'remove_tag' | 'send_broadcast'
export type RuleStatus = 'active' | 'inactive'

export interface AutomationRuleDoc {
  workspaceId: string
  name: string
  triggerType: RuleTriggerType
  /** 觸發條件（依 triggerType 有不同欄位） */
  triggerConfig: Record<string, any>
  actionType: RuleActionType
  /** 動作設定（依 actionType 有不同欄位） */
  actionConfig: Record<string, any>
  status: RuleStatus
  createdBy: string
  createdAt: Timestamp | FieldValue
  updatedAt: Timestamp | FieldValue
}
