/**
 * 電子發票開立（接在付款成功之後）。
 *
 * ⚠️ **開票絕不能回頭影響收款。** 錢已經收了,發票開失敗只能記錄下來、之後補開,
 *    絕不能讓 Notify 回非 200（藍新會重送 → 重複結算）或讓客戶看到錯誤。
 *    所有失敗都寫進 invoices 並在訂單上標 invoiceStatus,由人工/後續補開處理。
 *
 * 未設定光貿金鑰 → 直接標 skipped（收款照常）。發票是獨立的商店帳號,見
 * server/utils/guangmao-invoice.ts 的說明。
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import { getDb } from './firebase'
import { PAYMENT_ORDERS_COLLECTION } from './payment'
import { isInvoiceConfigured, issueInvoice, type GuangmaoInvoiceKeys } from './guangmao-invoice'
import { splitTax } from '~~/shared/billing/tax'
import { getBillingPlan, type BillingPlanId } from '~~/shared/billing/plans'
import { resolveInvoiceProfile, type InvoiceProfile, type OrganizationDoc, type WorkspaceDoc } from '~~/shared/types/organization'
import type { InvoiceDoc } from '~~/shared/types/payment'

export const INVOICES_COLLECTION = 'invoices'

/** 由 runtimeConfig 取出光貿金鑰（未設定則回 null → 不開發票）。 */
export function invoiceKeysFromConfig(config: Record<string, unknown>): GuangmaoInvoiceKeys | null {
  const keys = {
    sellerUBN: String(config.guangmaoInvoiceSellerUBN || '').trim(),
    appKey: String(config.guangmaoInvoiceAppKey || '').trim(),
    apiUrl: String(config.guangmaoInvoiceApiUrl || '').trim(),
  }
  return isInvoiceConfigured(keys) ? keys : null
}

/**
 * 為一筆已付款的訂單開立電子發票（冪等：同一 merchantOrderNo 只開一次）。
 *
 * 任何例外都吞掉並記錄——呼叫端（Notify webhook）**不得**因為開票失敗而失敗。
 */
export async function issueInvoiceForOrder(
  input: {
    merchantOrderNo: string
    workspaceId: string
    planId: BillingPlanId
    /** 含稅總額 = 實際請款金額 */
    totalAmt: number
  },
  keys: GuangmaoInvoiceKeys | null,
  db: Firestore = getDb(),
): Promise<void> {
  const orderRef = db.collection(PAYMENT_ORDERS_COLLECTION).doc(input.merchantOrderNo)
  const invRef = db.collection(INVOICES_COLLECTION).doc(input.merchantOrderNo)

  try {
    if (!keys) {
      await orderRef.update({ invoiceStatus: 'skipped', updatedAt: FieldValue.serverTimestamp() })
      return
    }

    // 冪等：**只有「已成功開立」才跳過**。
    // 若之前開失敗（ezPay 當機、參數被退），那張 invoices doc 是 ok:false ——
    // 這時要允許重開，否則一次暫時性錯誤就把發票永久弄丟了（藍新不會再送一次 Notify）。
    const prev = await invRef.get()
    if (prev.exists && (prev.data() as InvoiceDoc).ok === true) return

    const wsSnap = await db.collection('workspaces').doc(input.workspaceId).get()
    const ws = wsSnap.exists ? (wsSnap.data() as WorkspaceDoc) : null

    // 發票資訊：OA 沒填就沿用組織的（統編幾乎一定是組織層級的東西）
    const orgId = ws?.organizationId ?? null
    const orgSnap = orgId ? await db.collection('organizations').doc(orgId).get() : null
    const orgProfile = orgSnap?.exists ? (orgSnap.data() as OrganizationDoc).invoiceProfile : null
    const profile: InvoiceProfile = resolveInvoiceProfile(orgProfile, ws?.invoiceProfile)

    const plan = getBillingPlan(input.planId)

    const result = await issueInvoice({
      merchantOrderNo: input.merchantOrderNo,
      totalAmt: input.totalAmt,
      itemName: `${plan.name}方案 訂閱服務`,
      profile,
      fallbackBuyerName: ws?.name || input.workspaceId,
    }, keys)

    const { totalAmt, amt, taxAmt } = splitTax(input.totalAmt)
    const doc: InvoiceDoc = {
      merchantOrderNo: input.merchantOrderNo,
      workspaceId: input.workspaceId,
      totalAmt,
      amt,
      taxAmt,
      ok: result.ok,
      status: result.status,
      message: result.message || null,
      invoiceNumber: result.invoiceNumber ?? null,
      invoiceTransNo: result.invoiceTransNo ?? null,
      randomNum: result.randomNum ?? null,
      checkCodeValid: result.checkCodeValid ?? null,
      createdAt: FieldValue.serverTimestamp(),
    }
    await invRef.set(doc)
    await orderRef.update({
      invoiceStatus: result.ok ? 'issued' : 'failed',
      invoiceNumber: result.invoiceNumber ?? null,
      updatedAt: FieldValue.serverTimestamp(),
    })

    if (!result.ok) {
      console.error('[invoice] 開立失敗', input.merchantOrderNo, result.status, result.message)
    }
    else if (result.checkCodeValid === false) {
      // 發票開出來了但回應的 CheckCode 對不上 → 記錄下來人工確認，不影響客戶
      console.error('[invoice] CheckCode 驗證失敗（回應可疑）', input.merchantOrderNo)
    }
  }
  catch (e) {
    // 連線逾時之類的例外也要留下一張 ok:false 的 invoices doc——否則「哪些發票該補開」
    // 就只存在於 log 裡，沒有任何地方查得到。
    console.error('[invoice] issueInvoiceForOrder 例外（不影響收款）:', input.merchantOrderNo, e)
    try {
      const { totalAmt, amt, taxAmt } = splitTax(input.totalAmt)
      await invRef.set({
        merchantOrderNo: input.merchantOrderNo,
        workspaceId: input.workspaceId,
        totalAmt,
        amt,
        taxAmt,
        ok: false,
        status: 'EXCEPTION',
        message: (e as Error)?.message ?? String(e),
        createdAt: FieldValue.serverTimestamp(),
      } as InvoiceDoc, { merge: true })
      await orderRef.update({ invoiceStatus: 'failed', updatedAt: FieldValue.serverTimestamp() })
    }
    catch { /* 連標記都失敗就算了，錢已經收到，不能再往上拋 */ }
  }
}

/**
 * 補開所有失敗的發票（invoices 裡 ok:false 的）。由排程或人工觸發。
 *
 * 沒有這支，一次 ezPay 短暫故障就等於那批發票永久遺失——藍新不會再送一次 Notify，
 * 開票也就沒有第二次機會了。
 */
export async function reissueFailedInvoices(
  keys: GuangmaoInvoiceKeys | null,
  db: Firestore = getDb(),
  limit = 50,
): Promise<{ retried: number; issued: number }> {
  if (!keys) return { retried: 0, issued: 0 }

  const snap = await db.collection(INVOICES_COLLECTION).where('ok', '==', false).limit(limit).get()
  let issued = 0
  for (const doc of snap.docs) {
    const inv = doc.data() as InvoiceDoc
    const orderSnap = await db.collection(PAYMENT_ORDERS_COLLECTION).doc(inv.merchantOrderNo).get()
    if (!orderSnap.exists) continue
    const order = orderSnap.data() as { planId: BillingPlanId; status: string }
    if (order.status !== 'paid') continue // 沒收到錢的不開發票

    await issueInvoiceForOrder({
      merchantOrderNo: inv.merchantOrderNo,
      workspaceId: inv.workspaceId,
      planId: order.planId,
      totalAmt: inv.totalAmt,
    }, keys, db)

    const after = await doc.ref.get()
    if ((after.data() as InvoiceDoc)?.ok === true) issued++
  }
  return { retried: snap.size, issued }
}
