import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { INVOICES_COLLECTION } from '~~/server/utils/invoice'
import type { InvoiceDoc } from '~~/shared/types/payment'
import type { Timestamp } from 'firebase-admin/firestore'

/**
 * GET /api/payment/invoice-detail?order=<merchantOrderNo> — 單張發票明細。需 admin。
 *
 * 帳單頁「檢視發票」點開時才讀一次（列表不預載，省 50 次 join）。重點是把
 * **隨機碼**攤出來——它有存但列表沒顯示，卻是 B2C 到財政部平台查詢／兌獎的必要資訊。
 * invoices doc 與付款訂單一對一（doc id = merchantOrderNo），並以 workspaceId 驗歸屬。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'admin')
  const no = String(getQuery(event).order || '').trim()
  if (!no) throw createError({ statusCode: 400, statusMessage: '缺少訂單編號' })

  const snap = await getDb().collection(INVOICES_COLLECTION).doc(no).get()
  if (!snap.exists) throw createError({ statusCode: 404, statusMessage: '查無發票明細' })
  const inv = snap.data() as InvoiceDoc

  // 只能看自己帳號的發票
  if (inv.workspaceId !== workspaceId) throw createError({ statusCode: 403, statusMessage: '無權限查看此發票' })
  if (!inv.ok || !inv.invoiceNumber) throw createError({ statusCode: 404, statusMessage: '此訂單的發票尚未開立成功' })

  const t = inv.createdAt as Timestamp
  return {
    invoiceNumber: inv.invoiceNumber,
    randomNum: inv.randomNum ?? null,
    totalAmt: inv.totalAmt,
    amt: inv.amt,
    taxAmt: inv.taxAmt,
    issuedAt: t && typeof t.toMillis === 'function' ? t.toMillis() : null,
  }
})
