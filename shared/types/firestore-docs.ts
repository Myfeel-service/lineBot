import type { Timestamp, FieldValue } from 'firebase-admin/firestore'
import type { ModuleType } from './conversation-stats'
import type { AutoReplyAction, AutoReplyCooldown, AutoReplyMatchType, AutoReplyTagging } from '../auto-reply-rule'
import type { AiAutoReplyConfig, AiConversationMeta } from './ai-knowledge'

// AI 相關 doc 型別（KnowledgeChunkDoc / KnowledgeSourceDoc / AiSettingsDoc / AiUsageDoc）
// 定義於 ./ai-knowledge.ts，由 Nuxt 自動匯入

// ═══════════════════════════════════════════════════════════════════
//  Collection: users
//  Doc ID: `${workspaceId}_${lineUserId}`
// ═══════════════════════════════════════════════════════════════════

export interface UserDoc {
  workspaceId: string
  /** LINE userId */
  lineUserId: string
  displayName: string
  pictureUrl: string
  isBlocked: boolean
  /** 自動回覆規則 ID → 上次觸發時間（epoch ms） */
  autoReplyCooldowns?: Record<string, number>
  /** 模組 ID → 冷卻資訊（由啟用防重複的自動回覆寫入） */
  autoReplyModuleCooldowns?: Record<string, { triggeredAt: number; durationMs: number }>
  /**
   * 上一則自動回覆是哪條規則、發生在哪一場對話。用來擋「同一條規則連著命中第二次」——
   * 那代表客人照著罐頭回覆回了話卻又打中同一條，再送一次只會複讀（見 handleIncomingText）。
   * 每次規則真的送出回覆時覆寫；不是冷卻，與 autoReplyCooldowns 各自獨立。
   */
  lastAutoReply?: { ruleId: string; sessionId: string }
  /**
   * 上一次「準備要送某條規則」的宣告：規則 ID、內容指紋、時間（epoch ms）。
   * 在冷卻交易裡寫入，用來擋 webhook 並行處理造成的「同一句話回兩次」——lastAutoReply 是
   * 送出**之後**才寫的，並行的兩則訊息都會在它落地前讀完狀態（見 claimAutoReplyCooldown）。
   */
  lastAutoReplyClaim?: { ruleId: string; textKey: string; at: number }
  createdAt: Timestamp | FieldValue
}

// ═══════════════════════════════════════════════════════════════════
//  Collection: conversations
//  Doc ID: `${workspaceId}_${lineUserId}`（與 users 同 key，一對一）
// ═══════════════════════════════════════════════════════════════════

export interface ConversationDoc {
  workspaceId: string
  userId: string
  lastMessage: string
  lastDirection: 'incoming' | 'outgoing'
  lastMessageAt: Timestamp | null
  /** 最近一次 AI 互動的脈絡快取；給「待真人」收件匣顯示用 */
  aiMeta?: AiConversationMeta
}

// ═══════════════════════════════════════════════════════════════════
//  Collection: flows
//  Doc ID: uuid
// ═══════════════════════════════════════════════════════════════════

export interface FlowDoc {
  workspaceId: string
  name: string
  messages: any[]
  isActive: boolean
  moduleType: ModuleType
  /** true = 系統預設模組，不可刪除 */
  isSystem: boolean
  /** 一般模組列表排序（越小越靠前）；系統模組可忽略 */
  sortOrder?: number
  /** 所屬資料夾；null = 未分類；系統模組永遠為 null */
  folderId?: string | null
  createdAt: Timestamp | FieldValue
}

// ═══════════════════════════════════════════════════════════════════
//  Collection: flowFolders
//  把 regular flows 分組顯示用；系統模組不受影響。
// ═══════════════════════════════════════════════════════════════════

export interface FlowFolderDoc {
  workspaceId: string
  name: string
  /** 顯示順序（越小越靠前） */
  order: number
  createdAt: Timestamp | FieldValue
  updatedAt: Timestamp | FieldValue
}

// ═══════════════════════════════════════════════════════════════════
//  Collection: autoReplies
//  Doc ID: uuid
// ═══════════════════════════════════════════════════════════════════

export type AutoReplyRuleType = 'keyword' | 'ai'

export interface AutoReplyDoc {
  workspaceId: string
  name: string
  /** 'keyword'（既有規則）｜ 'ai'（保底 AI 回覆，Phase 2 啟用）。缺省視為 'keyword' */
  type?: AutoReplyRuleType
  keyword: string
  matchType: AutoReplyMatchType
  action: AutoReplyAction
  /** 對應 action.moduleId 的快取欄位 */
  moduleId: string
  isActive: boolean
  tagging: AutoReplyTagging
  cooldown: AutoReplyCooldown
  /** type === 'ai' 時使用 */
  aiConfig?: AiAutoReplyConfig
  /** 數字愈大優先；缺省（既有規則）視為 100，AI 規則建議 1 */
  priority?: number
  createdAt: Timestamp | FieldValue
}

// ═══════════════════════════════════════════════════════════════════
//  Collection: richMessages
//  Doc ID: uuid
// ═══════════════════════════════════════════════════════════════════

export interface RichMessageDoc {
  workspaceId: string
  name: string
  layoutId: string
  heroImageWidth?: number
  heroImageHeight?: number
  transparentBackground: boolean
  altText: string
  heroImageUrl: string
  actions: any[]
  isActive: boolean
  createdAt: Timestamp | FieldValue
}

// ═══════════════════════════════════════════════════════════════════
//  Collection: supportPresets
//  Doc ID: uuid
// ═══════════════════════════════════════════════════════════════════

export interface SupportPresetDoc {
  workspaceId: string
  name: string
  action: AutoReplyAction
  moduleId: string
  isActive: boolean
  tagging: AutoReplyTagging
  createdAt: Timestamp | FieldValue
}

// ═══════════════════════════════════════════════════════════════════
//  Collection: richmenus
//  Doc ID: uuid
// ═══════════════════════════════════════════════════════════════════

export interface RichMenuDoc {
  workspaceId: string
  name: string
  /** LINE 平台回傳的 richMenuId */
  richMenuId: string
  /** LINE Alias ID（給 LIFF 或 API 指定用） */
  aliasId: string
  size: { width: number; height: number }
  areas: any[]
  chatBarText: string
  imageUrl: string
  isDefault: boolean
  createdAt: Timestamp | FieldValue
}
