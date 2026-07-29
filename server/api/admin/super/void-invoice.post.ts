import { FieldValue, type Timestamp } from 'firebase-admin/firestore'
import { requireSuperAdmin } from '~~/server/utils/workspace-auth'
import { getDb } from '~~/server/utils/firebase'
import { INVOICES_COLLECTION, invoiceKeysFromConfig } from '~~/server/utils/invoice'
import { PAYMENT_ORDERS_COLLECTION } from '~~/server/utils/payment'
import { voidInvoice } from '~~/server/utils/guangmao-invoice'
import { taipeiDate } from '~~/shared/time'
import type { InvoiceDoc } from '~~/shared/types/payment'

/**
 * POST /api/admin/super/void-invoice — 作廢一張已開立的電子發票。僅 super admin。
 *
 * 用途:發票「開錯」（統編／抬頭／金額）要重開,或整筆退款時把發票作廢。
 *
 * ⚠️ 台灣電子發票作廢有時效（B2C 開立翌日起 2 日、B2B 7 日內,且限當期未申報）,逾期就
 *    只能改開折讓——這裡不在後端硬擋（時效由財政部端／光貲認定,逾期光貲會回錯,我方原樣回報),
 *    改在超管介面提示操作者。作廢原因為財政部規定必填。
 *
 * invoices / paymentOrders 皆為租戶內 top-level collection,super admin 已限本租戶,無跨租戶疑慮。
 */
export default defineEventHandler(async (event) => {
  await requireSuperAdmin(event)

  const body = await readBody(event)
  const merchantOrderNo = String(body?.merchantOrderNo || '').trim()
  const reason = String(body?.reason || '').trim()
  if (!merchantOrderNo) throw createError({ statusCode: 400, statusMessage: '缺少訂單編號' })
  if (!reason) throw createError({ statusCode: 400, statusMessage: '請填寫作廢原因（財政部規定必填）' })

  const config = useRuntimeConfig(event)
  const keys = invoiceKeysFromConfig(config as unknown as Record<string, unknown>)
  if (!keys) throw createError({ statusCode: 500, statusMessage: '發票功能尚未設定' })

  const db = getDb()
  const invRef = db.collection(INVOICES_COLLECTION).doc(merchantOrderNo)
  const snap = await invRef.get()
  if (!snap.exists) throw createError({ statusCode: 404, statusMessage: '查無此訂單的發票' })
  const inv = snap.data() as InvoiceDoc
  if (!inv.ok || !inv.invoiceNumber) throw createError({ statusCode: 400, statusMessage: '此發票未成功開立,無法作廢' })
  if (inv.voided) throw createError({ statusCode: 400, statusMessage: '此發票已作廢' })
  // 已開過折讓的發票不能直接作廢（折讓證明單還掛在這張發票上）——要先作廢折讓。這裡先擋，
  // 作廢折讓（g0501）尚未提供介面，逾此情形請人工至光貲後台處理。
  if (inv.allowances?.length) {
    throw createError({ statusCode: 400, statusMessage: '此發票已開折讓,無法直接作廢,請先於光貲後台作廢折讓' })
  }

  // 作廢須帶「原發票日期」YYYYMMDD(台灣時區);發票日 = 我方開立寫入的當天。
  const createdMs = (inv.createdAt as Timestamp)?.toMillis?.() ?? Date.now()
  const invoiceDate = taipeiDate(new Date(createdMs)).replace(/-/g, '')

  const result = await voidInvoice({ invoiceNumber: inv.invoiceNumber, invoiceDate, reason }, keys)
  if (!result.ok) {
    // 逾期作廢、期別已申報等都會走到這裡(光貲回非 0)——把光貲訊息原樣帶回,操作者才知道要改開折讓。
    throw createError({ statusCode: 502, statusMessage: `作廢失敗（${result.status}）：${result.message || '請確認是否已逾作廢時效,逾期需改開折讓'}` })
  }

  await invRef.update({
    voided: true,
    voidReason: reason,
    voidStatus: result.status,
    voidedAt: FieldValue.serverTimestamp(),
  })
  // 訂單摘要同步標作廢;訂單缺失也不回頭讓已成功的作廢失敗。
  await db.collection(PAYMENT_ORDERS_COLLECTION).doc(merchantOrderNo)
    .update({ invoiceStatus: 'voided', updatedAt: FieldValue.serverTimestamp() })
    .catch(() => {})

  return { ok: true, invoiceNumber: inv.invoiceNumber }
})
