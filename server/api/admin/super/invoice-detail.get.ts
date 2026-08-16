import { requireSuperAdmin } from '~~/server/utils/workspace-auth'
import { loadInvoiceDetail } from '~~/server/utils/invoice-detail'

/**
 * GET /api/admin/super/invoice-detail?order=<merchantOrderNo> — 發票明細（超管版）。
 *
 * 2026-08-16 稽核（B-43①）:超管金流總覽的發票號碼原本只是純文字——無明細、無隨機碼、
 * 無折讓紀錄,**超管看得到的比客戶還少**,要作廢／折讓前根本無從核對這張發票開給誰。
 * 明細組裝與客戶端同一支 util（loadInvoiceDetail）,兩邊口徑一致;超管不驗 workspace 歸屬。
 */
export default defineEventHandler(async (event) => {
  await requireSuperAdmin(event)
  const no = String(getQuery(event).order || '').trim()
  if (!no) throw createError({ statusCode: 400, statusMessage: '缺少訂單編號' })

  const brand = String(useRuntimeConfig(event).public?.brandName || '').trim()
  const { workspaceId, detail } = await loadInvoiceDetail(no, brand)
  return { workspaceId, ...detail }
})
