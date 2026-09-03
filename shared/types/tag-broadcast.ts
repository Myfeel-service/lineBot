import type { Timestamp, FieldValue } from 'firebase-admin/firestore'

// ═══════════════════════════════════════════════════════════════════
//  Collection: tags
//  Doc ID: uuid
// ═══════════════════════════════════════════════════════════════════

export type TagStatus = 'active' | 'inactive'

/**
 * member_status  – 「好友狀態」（後台顯示名，見 shared/tag-admin.ts）：例如 vip、new_friend、blocked_risk
 * interest       – 例如 interest_food、interest_travel
 * behavior       – 例如 buyer、cart_abandon、clicked_promo
 * activity       – 例如 event_2025q2、campaign_mothersday
 * custom         – 自訂標籤，無法歸類到以上
 */
export type TagCategory = 'member_status' | 'interest' | 'behavior' | 'activity' | 'custom'

/**
 * 這顆標籤要不要讓 AI 判斷（D-27，2026-08-24 老闆拍板）：
 * off     – AI 完全不碰（**預設**：問卷／客服／活動這類事件紀錄標籤，AI 從對話判斷不出來）
 * suggest – AI 判斷後進收件匣，人按「採用」才貼
 * auto    – AI 判斷到直接貼（來源記 ai、可撤、週報看得到）
 *
 * ⛔ 為什麼是一個三段選擇不是兩個開關：兩個開關有四種組合，其中「不讓 AI 判卻要自動貼」
 * 沒有意義；三段＝信任程度由低到高一次講完。
 * ⛔ 舊標籤沒有這個欄位＝off：掃描器用 `where('aiMode','in',['suggest','auto'])` 挑候選，
 * 缺欄位天然不命中——上線當天既有標籤行為零改變。
 */
export type TagAiMode = 'off' | 'suggest' | 'auto'

export interface TagDoc {
  workspaceId: string
  /** 同一 workspace 內唯一；英文小寫加底線，程式內部使用。例如 interest_food */
  code: string
  /** 顯示名稱，給後台營運人員看 */
  name: string
  category: TagCategory
  /** hex 色碼，用於後台顯示標籤色塊 */
  color: string
  /** 給團隊看的內部說明。⛔ AI **不讀這欄**（判斷條件在 aiCriteria）——2026-08-24 起分兩欄 */
  description: string
  /** 見 TagAiMode；舊文件沒有此欄＝off */
  aiMode?: TagAiMode
  /**
   * AI 的判斷條件（aiMode 為 suggest/auto 時才有意義）。寫法＝「客人說了什麼算＋什麼不算」。
   * 與 description 分開的理由：既有標籤的說明是寫給人看的（檔期備註之類），
   * 拿去當 AI 條件會讓它亂猜。編輯器在切到 suggest/auto 時會把 description **預填**進來讓人改。
   */
  aiCriteria?: string
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
  /**
   * 最近一次「客人自己又表現了這個意圖」的時間（`D-55`，2026-09-03 老闆拍板做）。
   *
   * 跟 `createdAt` 的差別：`createdAt` 是**第一次**貼上（拆掉重貼會重新計時），
   * 這欄是**最後一次被判到**——標籤本身是「有／沒有」的開關，少了這欄，
   * 三個月前問過一次出貨的人跟這個月追了四次的人，在推播名單裡長得一模一樣。
   *
   * ⛔ 只有「客人自己觸發（按鈕／腳本／輸入）」與「AI 從對話判到」才寫這兩欄，
   *   後台手動貼標與批次貼標**刻意不寫**（那是我們的動作，不是客人的訊號）。
   *   所以**沒有值 ≠ 沒發生過，而是「從來沒有被自動判到過」**，分析時讀成 0 次。
   * ⛔ 舊資料不回填（2,383 筆既有 userTags 沒有這兩欄）：猜一個次數比留空白更糟。
   */
  lastHitAtMs?: number
  /**
   * 被自動判到幾次（含「已經貼過所以略過」的那些次）——這才是「重複幾次」的答案。
   *
   * ⛔ 有冷卻窗（見 `TAG_HIT_COOLDOWN_MS`）：客人連點按鈕會在幾秒內重複觸發，
   *   實測線上 56 對重複貼標**間隔中位數 8.8 秒、一天以上 0 對**＝那是手指抖不是熱度，
   *   不擋掉就會把噪音當成強度。
   */
  hitCount?: number
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
//  Collection: tagSuggestionLogs
//  Doc ID: uuid
//  用途：AI 貼標建議的成效底帳（D-42 第一步），不做刪除
//
//  ⛔ **為什麼不能塞進 tagLogs**：那本帳記的是「標籤貼在誰身上」，只有貼上與拿掉
//  兩種事件——而 AI 提過、人按了忽略的建議**從來沒貼上過**，在那本帳裡根本不存在。
//  採用率的分母正是那些沒貼上的，所以非開一本不可。
//
//  ⚠️ 與 tagLogs 會有「同一件事兩邊各記一筆」（人按採用＝這裡 applied、那裡 add）。
//  這是刻意的：兩本帳問的問題不同——這本問「這條建議的結局是什麼」，tagLogs 問
//  「標籤現在在誰身上」。⛔ 兩邊數字**不保證相等**（採用一顆客人身上已經有的標籤時，
//  tagLogs 冪等略過不寫，這裡照記——人確實做了決定），算成效一律只用這本，
//  ⛔ 別把兩本加起來。
// ═══════════════════════════════════════════════════════════════════

/**
 * 一條 AI 貼標建議的結局。
 *
 * suggested    – AI 判定後進收件匣（等人決定）
 * auto_applied – AI 判定後直接貼上（該顆設「AI 判到直接貼」，不經過人）
 * applied      – 人按「採用」
 * dismissed    – 人按「忽略」
 * superseded   – 建議還掛在收件匣時，人自己走「管理標籤」手動貼了同一顆
 *                ＝**同意 AI 的判斷**，只是沒走採用鈕；算成效時要跟 applied 同一邊，
 *                漏掉它會低報準確率（客服習慣自己加標籤，這條路不算少）
 *
 * ⛔ 這裡**刻意沒有**「AI 自動貼上、事後被人拆掉」（否決票）這一種，兩個理由：
 *    ① 那件事 tagLogs 查得到（action='remove' 對齊先前 sourceRefId='ai-tag-suggest:auto'
 *      的 add），補得回來，不必現在多記一本
 *    ② `recordManualRemovalAsDismissed` 是對「所有 AI 有在判的標籤」記否決票，
 *      **不管當初是不是 AI 貼的**——照它記會把「人自己貼、自己拆」也算成 AI 的失分。
 *    要做 auto 模式的存活率時，走 tagLogs 對齊 add/remove，別走這裡。
 */
export type TagSuggestionEvent = 'suggested' | 'auto_applied' | 'applied' | 'dismissed' | 'superseded'

export interface TagSuggestionLogDoc {
  workspaceId: string
  event: TagSuggestionEvent
  tagId: string
  /** users 主鍵：`${workspaceId}_${lineUserId}` */
  userId: string
  /** 產生這條建議的那場對話（suggested／auto_applied 才有） */
  sessionId: string | null
  /** 按下採用／忽略的人（applied／dismissed 才有；排程寫的一律 null） */
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
