import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { hasInvoiceProfile, resolveInvoiceProfile, type InvoiceProfile, type OrganizationDoc, type WorkspaceDoc } from '~~/shared/types/organization'

/**
 * GET /api/payment/invoice-profile — 帳單頁的發票區塊要顯示的東西。
 *
 * 回三樣：
 *   · `effective` —— **實際會用來開立發票**的那一份（OA 有覆寫就是 OA 的，否則是組織的）
 *   · `inherited` —— 目前是不是沿用組織的（前端據此顯示「沿用組織設定」而不是一張空表單）
 *   · `orgId`     —— 讓前端把「去組織設定改」的連結指對地方
 *
 * 這樣使用者才不會以為「沒填 = 不會開發票」，而在每個 OA 各填一次統編。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'billing.manage')
  const db = getDb()

  const wsSnap = await db.collection('workspaces').doc(workspaceId).get()
  const ws = wsSnap.exists ? (wsSnap.data() as WorkspaceDoc) : null
  const orgId = ws?.organizationId ?? null

  const orgSnap = orgId ? await db.collection('organizations').doc(orgId).get() : null
  const orgProfile: InvoiceProfile = (orgSnap?.exists ? (orgSnap.data() as OrganizationDoc).invoiceProfile : null) ?? {}
  const wsProfile: InvoiceProfile = ws?.invoiceProfile ?? {}

  return {
    orgId,
    override: wsProfile,
    effective: resolveInvoiceProfile(orgProfile, wsProfile),
    inherited: !hasInvoiceProfile(wsProfile),
  }
})
