import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { INVOICES_COLLECTION } from '~~/server/utils/invoice'
import { PAYMENT_ORDERS_COLLECTION } from '~~/server/utils/payment'
import { getBillingPlan } from '~~/shared/billing/plans'
import type { InvoiceDoc, PaymentOrderDoc } from '~~/shared/types/payment'
import type { Timestamp } from 'firebase-admin/firestore'

/** B2C 開立送出的統編佔位值（光貿/MIG 規格）——它不是真統編,不能當「開給公司」顯示。 */
const B2C_IDENTIFIER = '0000000000'

/**
 * GET /api/payment/invoice-detail?order=<merchantOrderNo> — 單張發票明細。需 admin。
 *
 * 帳單頁「檢視發票」點開時才讀一次（列表不預載,省 50 次 join）。回的是會計對帳
 * 要核對的整組資訊,不只號碼:
 *   · 隨機碼 —— B2C 到財政部平台查詢／兌獎的必要資訊（有存但列表不顯示）
 *   · 開給誰 —— 類型（公司三聯／個人二聯）＋統編＋抬頭,用**開立當下的快照**,
 *     不重算現行設定（事後改統編不該改變歷史發票的顯示）；上線前的舊發票沒有快照
 *     → 回 null,前端整段不顯示,不猜
 *   · 品名 —— 同樣以開立快照為準;舊發票沒存,用方案名回推並標 itemNameDerived,
 *     前端要註明「依現行方案名回推」（方案改名後回推值就不是發票上的字了）
 *   · 作廢／折讓 —— 超管作廢或開折讓後,客戶端看得到痕跡,對帳才對得上
 *
 * invoices doc 與付款訂單一對一（doc id = merchantOrderNo）,並以 workspaceId 驗歸屬。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'admin')
  const no = String(getQuery(event).order || '').trim()
  if (!no) throw createError({ statusCode: 400, statusMessage: '缺少訂單編號' })

  const db = getDb()
  const snap = await db.collection(INVOICES_COLLECTION).doc(no).get()
  if (!snap.exists) throw createError({ statusCode: 404, statusMessage: '查無發票明細' })
  const inv = snap.data() as InvoiceDoc

  // 只能看自己帳號的發票
  if (inv.workspaceId !== workspaceId) throw createError({ statusCode: 403, statusMessage: '無權限查看此發票' })
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
      const brand = String(useRuntimeConfig(event).public?.brandName || '').trim()
      itemName = `${brand} ${getBillingPlan(order.planId).name}方案 訂閱服務`.trim()
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
  }
})
