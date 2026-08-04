import type { Timestamp, FieldValue } from 'firebase-admin/firestore'
import type { WorkspaceSubscription } from '../billing/plans'

// ═══════════════════════════════════════════════════════════════════
//  Collection: organizations
//  Doc ID: uuid
// ═══════════════════════════════════════════════════════════════════

/**
 * 一個組織預設能建立幾個官方帳號。
 *
 * ⚠️ **這是濫用防護，不是產品分級。** 每個新建的官方帳號都自帶免費層的 200 則額度，
 *    沒有這個上限的話，一個人就能無限建 OA 換無限免費額度。
 *    開放自助註冊之前，這個限制必須存在。
 *
 * 需要更多的客戶（代理商、多品牌）由 super admin 在組織上調高 `maxWorkspaces`。
 */
export const DEFAULT_MAX_WORKSPACES_PER_ORG = 3

export interface OrganizationDoc {
  name: string
  /** 登記擁有者 Email（小寫）；與 ownerId 擇一或並存 */
  ownerEmail?: string
  /** Firebase uid；若擁有者尚未註冊則可能缺省 */
  ownerId?: string
  /**
   * 建立來源。`self_serve` = 使用者從自助開通精靈建立（見 /api/onboarding/self-serve）。
   * 缺省 = super admin 手動建立。用於自助防濫用查詢（每個 uid 最多一個自助組織）。
   */
  createdVia?: 'self_serve'
  disabled?: boolean
  /**
   * 這個組織能建立幾個官方帳號。未設 → `DEFAULT_MAX_WORKSPACES_PER_ORG`。
   * `null` = 不限（super admin 為代理商 / 大客戶特批）。
   */
  maxWorkspaces?: number | null
  /**
   * 組織層級的發票開立資訊（**預設值**）。
   *
   * 統一編號與公司抬頭幾乎一定是組織層級的東西——一家公司開 3 個官方帳號,
   * 不會想填 3 次統編。所以預設放這裡,個別 OA 需要不同抬頭時才在
   * `WorkspaceDoc.invoiceProfile` 覆寫（合併規則見 resolveInvoiceProfile）。
   */
  invoiceProfile?: InvoiceProfile
  createdAt: Timestamp | FieldValue
  updatedAt: Timestamp | FieldValue
}

// ═══════════════════════════════════════════════════════════════════
//  Collection: workspaces
//  Doc ID: workspace id (e.g. uuid or "default")
// ═══════════════════════════════════════════════════════════════════

export interface WorkspaceDoc {
  name: string
  channelAccessToken?: string
  channelSecret?: string
  defaultLiffId?: string
  organizationId?: string | null
  /**
   * 計費訂閱（掛在帳號 / OA 層，每個帳號各自一份、額度不共用）。
   * 未設 = 免費層（DEFAULT_BILLING_PLAN_ID）。方案內容見 shared/billing/plans.ts。
   * Phase 1 由 super admin 手動開通寫入；Phase 2 起接金流 webhook 維護。
   */
  subscription?: WorkspaceSubscription
  /**
   * 這個官方帳號**專屬**的發票資訊（覆寫組織的預設值）。
   * 一般情況留空 → 沿用 `OrganizationDoc.invoiceProfile`。只有「同一家公司底下不同 OA
   * 要開不同抬頭」時才需要填（例：代理商幫不同客戶各開一個 OA）。
   */
  invoiceProfile?: InvoiceProfile
  updatedAt: Timestamp | FieldValue
}

/** 買受人的發票偏好。統編有值 = B2B（公司報帳）；載具與捐贈碼互斥。 */
export interface InvoiceProfile {
  buyerUBN?: string | null
  buyerName?: string | null
  buyerEmail?: string | null
  /** 手機條碼載具（/ + 7 碼） */
  carrierNum?: string | null
  /** 捐贈碼（3–7 碼數字） */
  loveCode?: string | null
}

/**
 * 一句話說清楚「這組設定會開出什麼樣的發票」——比列出五個欄位好懂。
 * 供發票表單的即時預覽與帳單頁「沿用組織設定」摘要共用，兩邊口徑一致、不各寫一份慢慢飄。
 */
export function describeInvoiceProfile(p: InvoiceProfile | null | undefined): string {
  const ubn = String(p?.buyerUBN ?? '').trim()
  const name = String(p?.buyerName ?? '').trim()
  const carrier = String(p?.carrierNum ?? '').trim()
  const love = String(p?.loveCode ?? '').trim()
  if (ubn) return `公司發票（統編 ${ubn}・${name || '未填抬頭'}）`
  if (carrier) return `個人發票・存入手機條碼載具 ${carrier}`
  if (love) return `個人發票・捐贈（愛心碼 ${love}）`
  return '個人發票・紙本'
}

/** 發票資訊有沒有被填過（全空 = 沒填，該回退到組織的預設值）。 */
export function hasInvoiceProfile(p: InvoiceProfile | null | undefined): boolean {
  if (!p) return false
  return Boolean(
    String(p.buyerUBN ?? '').trim()
    || String(p.buyerName ?? '').trim()
    || String(p.buyerEmail ?? '').trim()
    || String(p.carrierNum ?? '').trim()
    || String(p.loveCode ?? '').trim(),
  )
}

/**
 * 實際用來開立發票的資訊：**OA 有填就整份用 OA 的，沒填就整份用組織的。**
 *
 * ⚠️ 刻意「整份取代」而不是逐欄位合併。逐欄位合併會組出危險的混合體——
 *    例如 OA 填了自己的抬頭但沒填統編，就會拼出「A 公司的抬頭 + B 公司的統編」，
 *    那是一張報不了帳、甚至有稅務問題的發票。發票的買受人身分必須是完整的一組。
 */
export function resolveInvoiceProfile(
  orgProfile: InvoiceProfile | null | undefined,
  workspaceProfile: InvoiceProfile | null | undefined,
): InvoiceProfile {
  if (hasInvoiceProfile(workspaceProfile)) return workspaceProfile!
  return orgProfile ?? {}
}

// ═══════════════════════════════════════════════════════════════════
//  Collection: orgMembers
//  Doc ID: `${uid}_${orgId}`
// ═══════════════════════════════════════════════════════════════════

/** 組織層級角色：目前只有 admin */
export type OrgMemberRole = 'admin'

export interface OrgMemberDoc {
  uid: string
  orgId: string
  role: OrgMemberRole
  invitedBy: string | null
  invitedEmail: string | null
  joinedAt: Timestamp | FieldValue
  createdAt: Timestamp | FieldValue
}

// ═══════════════════════════════════════════════════════════════════
//  Collection: workspaceMembers
//  Doc ID: `${uid}_${workspaceId}`
// ═══════════════════════════════════════════════════════════════════

/** 角色權限層級：owner > admin > agent > viewer */
export type WorkspaceMemberRole = 'owner' | 'admin' | 'agent' | 'viewer'

export interface WorkspaceMemberDoc {
  uid: string
  workspaceId: string
  organizationId: string | null
  role: WorkspaceMemberRole
  /** 邀請者的 Firebase uid；owner 自行建立時為 null */
  invitedBy: string | null
  /** 邀請時輸入的 email，供顯示用 */
  invitedEmail: string | null
  joinedAt: Timestamp | FieldValue
  createdAt: Timestamp | FieldValue

  // ── LINE 綁定（轉真人通知要推播給「人」，但後台帳號只有 email，兩者本來無橋）──
  /** 綁定後的 LINE userId（U 開頭原始值，非 users 主鍵）；未綁定為 null */
  lineUserId?: string | null
  /** 綁定當下的 LINE 暱稱，列表顯示用 */
  lineDisplayName?: string | null
  linePictureUrl?: string | null
  lineBoundAt?: Timestamp | FieldValue | null
  /** 待輸入的一次性綁定碼（大寫）。成員傳到官方帳號後即清空 */
  lineBindCode?: string | null
  /** 綁定碼到期時間（epoch ms） */
  lineBindCodeExpiresAt?: number | null
}

// ═══════════════════════════════════════════════════════════════════
//  Collection: workspaceInvites
//  Doc ID: auto id — 對方尚無 Firebase 帳號時的 email 邀請（首次登入後轉成 workspaceMembers）
// ═══════════════════════════════════════════════════════════════════

export type WorkspaceInviteRole = 'admin' | 'agent' | 'viewer'

export interface WorkspaceInviteDoc {
  workspaceId: string
  organizationId: string | null
  /** 小寫 email，與 Firebase token.email 比對 */
  email: string
  role: WorkspaceInviteRole
  invitedBy: string
  createdAt: Timestamp | FieldValue
}
