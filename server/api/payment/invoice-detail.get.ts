import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { loadInvoiceDetail } from '~~/server/utils/invoice-detail'

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
 * 明細組裝共用 server/utils/invoice-detail.ts（超管金流總覽也用同一支,口徑不會飄）;
 * invoices doc 與付款訂單一對一（doc id = merchantOrderNo）,並以 workspaceId 驗歸屬。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'admin')
  const no = String(getQuery(event).order || '').trim()
  if (!no) throw createError({ statusCode: 400, statusMessage: '缺少訂單編號' })

  const brand = String(useRuntimeConfig(event).public?.brandName || '').trim()
  const { workspaceId: owner, detail } = await loadInvoiceDetail(no, brand)

  // 只能看自己帳號的發票
  if (owner !== workspaceId) throw createError({ statusCode: 403, statusMessage: '無權限查看此發票' })
  return detail
})
