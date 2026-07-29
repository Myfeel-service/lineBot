import { FieldValue, type Timestamp } from 'firebase-admin/firestore'
import { requireSuperAdmin } from '~~/server/utils/workspace-auth'
import { getDb } from '~~/server/utils/firebase'
import { INVOICES_COLLECTION, invoiceKeysFromConfig } from '~~/server/utils/invoice'
import { issueAllowance } from '~~/server/utils/guangmao-invoice'
import { taipeiDate } from '~~/shared/time'
import type { InvoiceDoc, InvoiceAllowanceRecord } from '~~/shared/types/payment'

/**
 * POST /api/admin/super/allowance — 對一張已開立發票開折讓證明單。僅 super admin。
 *
 * 折讓 vs 作廢:折讓用於「銷貨退回／部分退款」,對原發票開折讓證明單(原發票不作廢);
 * 逾作廢時效(B2C 2 日 / B2B 7 日)或已申報的發票,退款就走折讓。支援部分折讓(累加)。
 *
 * ⚠️ 折讓的買方抬頭/統編**須與原發票一致**(光貲 4040127/4040157)。用開立時存下的買方快照,
 *    不重算現行 profile(可能已飄移)。快照欄上線前的舊發票沒有 → 擋下請人工處理。
 */
export default defineEventHandler(async (event) => {
  await requireSuperAdmin(event)

  const body = await readBody(event)
  const merchantOrderNo = String(body?.merchantOrderNo || '').trim()
  const reason = String(body?.reason || '').trim()
  const amount = Math.round(Number(body?.amount))
  if (!merchantOrderNo) throw createError({ statusCode: 400, statusMessage: '缺少訂單編號' })
  if (!reason) throw createError({ statusCode: 400, statusMessage: '請填寫折讓原因' })
  if (!Number.isFinite(amount) || amount <= 0) throw createError({ statusCode: 400, statusMessage: '折讓金額需為正整數' })

  const config = useRuntimeConfig(event)
  const keys = invoiceKeysFromConfig(config as unknown as Record<string, unknown>)
  if (!keys) throw createError({ statusCode: 500, statusMessage: '發票功能尚未設定' })

  const db = getDb()
  const invRef = db.collection(INVOICES_COLLECTION).doc(merchantOrderNo)
  const snap = await invRef.get()
  if (!snap.exists) throw createError({ statusCode: 404, statusMessage: '查無此訂單的發票' })
  const inv = snap.data() as InvoiceDoc
  if (!inv.ok || !inv.invoiceNumber) throw createError({ statusCode: 400, statusMessage: '此發票未成功開立,無法折讓' })
  if (inv.voided) throw createError({ statusCode: 400, statusMessage: '此發票已作廢,無法再開折讓' })
  if (!inv.buyerName || !inv.buyerIdentifier) {
    throw createError({ statusCode: 400, statusMessage: '此發票開立於買方紀錄上線前,請至光貲後台手動開折讓' })
  }

  // 折讓總額不得超過（原發票含稅額 − 已折讓）
  const priorAllowed = (inv.allowances ?? []).reduce((s, a) => s + (a.amount || 0), 0)
  const remaining = inv.totalAmt - priorAllowed
  if (amount > remaining) {
    throw createError({ statusCode: 400, statusMessage: `折讓金額超過可折讓餘額（NT$${remaining.toLocaleString()}）` })
  }

  const createdMs = (inv.createdAt as Timestamp)?.toMillis?.() ?? Date.now()
  const invoiceDate = taipeiDate(new Date(createdMs)).replace(/-/g, '')
  const nowMs = Date.now()
  const allowanceDate = taipeiDate(new Date(nowMs)).replace(/-/g, '')
  // 折讓單號:≤16 碼、需唯一(光貲不代配號、重號回 4040121)。'A' + base36 毫秒 + 2 碼亂數 ≈ 11 碼。
  const allowanceNumber = `A${nowMs.toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`
    .toUpperCase()
    .slice(0, 16)

  const result = await issueAllowance({
    invoiceNumber: inv.invoiceNumber,
    invoiceDate,
    itemName: reason, // 折讓品項名 = 原因(如「退款折讓」)
    totalAmt: amount,
    allowanceNumber,
    allowanceDate,
    buyerName: inv.buyerName,
    buyerIdentifier: inv.buyerIdentifier,
  }, keys)

  if (!result.ok) {
    throw createError({ statusCode: 502, statusMessage: `折讓失敗（${result.status}）：${result.message || '請確認發票狀態與折讓期限'}` })
  }

  const record: InvoiceAllowanceRecord = { allowanceNumber, amount, reason, status: result.status, createdAtMs: nowMs }
  await invRef.update({ allowances: FieldValue.arrayUnion(record) })

  return { ok: true, allowanceNumber, remaining: remaining - amount }
})
