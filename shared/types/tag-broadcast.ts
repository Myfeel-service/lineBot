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
 * system  – 系統事件觸發，例如加入好友、完成購買
 */
export type UserTagSourceType = 'manual' | 'import' | 'rule' | 'system'

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
   * failureReason＝「這次發送真的失敗了」。
   */
  failureReason?: string | null
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
