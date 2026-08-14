import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { INVOICES_COLLECTION, invoiceKeysFromConfig } from '~~/server/utils/invoice'
import { getInvoiceFileUrl } from '~~/server/utils/guangmao-invoice'
import type { InvoiceDoc } from '~~/shared/types/payment'

/**
 * GET /api/payment/invoice-file?order=<merchantOrderNo> — 取發票證明聯 PDF 連結。需 admin。
 *
 * 電商標配「下載發票」。走光貿 invoice_file API,回的 file_url **只有 10 分鐘有效**,
 * 所以這裡不存、不快取,每次點都重新取——存起來只會給使用者一個過期連結。
 *
 * 光貿端的限制原樣回給使用者(不在這裡預判):
 *   · 逾發票日期 180 天 → code 51
 *   · 存入載具的發票要中獎後才能下載
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'admin')
  const no = String(getQuery(event).order || '').trim()
  if (!no) throw createError({ statusCode: 400, statusMessage: '缺少訂單編號' })

  const config = useRuntimeConfig(event)
  const keys = invoiceKeysFromConfig(config as unknown as Record<string, unknown>)
  if (!keys) throw createError({ statusCode: 500, statusMessage: '發票功能尚未設定' })

  const snap = await getDb().collection(INVOICES_COLLECTION).doc(no).get()
  if (!snap.exists) throw createError({ statusCode: 404, statusMessage: '查無發票' })
  const inv = snap.data() as InvoiceDoc

  // 只能拿自己帳號的發票
  if (inv.workspaceId !== workspaceId) throw createError({ statusCode: 403, statusMessage: '無權限查看此發票' })
  if (!inv.ok || !inv.invoiceNumber) throw createError({ statusCode: 404, statusMessage: '此訂單的發票尚未開立成功' })
  // 作廢的發票沒有報帳用途,證明聯只會被誤用
  if (inv.voided) throw createError({ statusCode: 400, statusMessage: '此發票已作廢,無法下載證明聯' })

  const r = await getInvoiceFileUrl({ invoiceNumber: inv.invoiceNumber }, keys)
  if (!r.ok || !r.fileUrl) {
    // 逾 180 天(51)、載具發票未中獎等——把光貿的訊息帶回,使用者才知道原因
    throw createError({ statusCode: 502, statusMessage: `無法取得證明聯（${r.status}）${r.message ? `：${r.message}` : ''}` })
  }
  return { fileUrl: r.fileUrl }
})
