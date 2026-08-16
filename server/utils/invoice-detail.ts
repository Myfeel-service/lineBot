import type { Timestamp } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { INVOICES_COLLECTION } from '~~/server/utils/invoice'
import { PAYMENT_ORDERS_COLLECTION } from '~~/server/utils/payment'
import { getBillingPlan } from '~~/shared/billing/plans'
import type { InvoiceDoc, PaymentOrderDoc } from '~~/shared/types/payment'

/** B2C 開立送出的統編佔位值（光貿/MIG 規格）——它不是真統編,不能當「開給公司」顯示。 */
const B2C_IDENTIFIER = '0000000000'

/**
 * 組一張發票的完整明細（號碼／隨機碼／開給誰／品名／作廢／折讓）。
 *
 * 客戶端帳單頁與超管金流總覽共用同一支——口徑只能有一個,兩頁看到的必須是同一張發票。
 * 快照原則見 invoice-detail.get.ts 檔頭:開給誰／品名一律用開立當下的快照,
 * 快照缺（上線前舊發票）→ null／回推並標 derived,不猜。
 *
 * 回傳含 workspaceId:**權限檢查是呼叫端的事**（客戶端要驗歸屬、超管不用）。
 */
export async function loadInvoiceDetail(no: string, brandName: string) {
  const db = getDb()
  const snap = await db.collection(INVOICES_COLLECTION).doc(no).get()
  if (!snap.exists) throw createError({ statusCode: 404, statusMessage: '查無發票明細' })
  const inv = snap.data() as InvoiceDoc
  if (!inv.ok || !inv.invoiceNumber) throw createError({ statusCode: 404, statusMessage: '此訂單的發票尚未開立成功' })

  const toMs = (t: unknown) => (t && typeof (t as Timestamp).toMillis === 'function' ? (t as Timestamp).toMillis() : null)

  // 開給誰:快照缺（上線前的舊發票）→ buyerType null,前端不顯示、不猜
  const ident = String(inv.buyerIdentifier ?? '').trim()
  const buyerType = ident ? (ident === B2C_IDENTIFIER ? 'b2c' as const : 'b2b' as const) : null

  // 品名:優先用開立快照;舊發票用訂單的方案名回推,並標 derived 讓前端註明
  let itemName = String(inv.itemName ?? '').trim() || null
  let itemNameDerived = false
  if (!itemName) {
    const orderSnap = await db.collection(PAYMENT_ORDERS_COLLECTION).doc(no).get()
    const order = orderSnap.exists ? (orderSnap.data() as PaymentOrderDoc) : null
    if (order?.planId) {
      itemName = `${brandName} ${getBillingPlan(order.planId).name}方案 訂閱服務`.trim()
      itemNameDerived = true
    }
  }

  const allowances = (inv.allowances ?? []).map(a => ({
    allowanceNumber: a.allowanceNumber,
    amount: a.amount,
    reason: a.reason,
    createdAtMs: a.createdAtMs ?? null,
  }))
  const allowanceTotal = allowances.reduce((s, a) => s + (a.amount || 0), 0)

  return {
    workspaceId: inv.workspaceId,
    detail: {
      invoiceNumber: inv.invoiceNumber,
      randomNum: inv.randomNum ?? null,
      totalAmt: inv.totalAmt,
      amt: inv.amt,
      taxAmt: inv.taxAmt,
      issuedAt: toMs(inv.createdAt),
      buyerType,
      buyerUBN: buyerType === 'b2b' ? ident : null,
      buyerName: inv.buyerName ?? null,
      itemName,
      itemNameDerived,
      voided: inv.voided === true,
      voidReason: inv.voidReason ?? null,
      voidedAt: toMs(inv.voidedAt),
      allowances,
      allowanceTotal,
      /** 折讓後實際金額（含稅）;沒折讓過 = totalAmt */
      netAmt: inv.totalAmt - allowanceTotal,
    },
  }
}
