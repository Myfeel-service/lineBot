import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { updateSourceSettings } from '~~/server/utils/ai-knowledge-sources'

/**
 * PUT /api/ai/sources/:sourceId
 * Body: { refreshIntervalMinutes?, onChangeBehavior?, name?, productName?, url? }
 *
 * 只動使用者可配置欄位；hash / etag / lastFetchedAt 等系統欄位不在這支處理
 * （例外：改 url 會一併重設比對基準，見 updateSourceSettings）。
 * productName 改動後前端要接著打 POST /api/ai/sources/:id/reindex 重建該來源索引才生效。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'sources.write')
  const sourceId = String(getRouterParam(event, 'sourceId') ?? '').trim()
  if (!sourceId) throw createError({ statusCode: 400, statusMessage: 'sourceId required' })

  const body = await readBody(event).catch(() => ({}))
  const result = await updateSourceSettings(getDb(), workspaceId, sourceId, {
    refreshIntervalMinutes: body?.refreshIntervalMinutes,
    onChangeBehavior: body?.onChangeBehavior,
    name: body?.name,
    folderId: body?.folderId === null ? null : (typeof body?.folderId === 'string' ? body.folderId : undefined),
    productName: typeof body?.productName === 'string' ? body.productName : undefined,
    urlAutoApply: typeof body?.urlAutoApply === 'boolean' ? body.urlAutoApply : undefined,
    url: typeof body?.url === 'string' ? body.url : undefined,
  })
  if (!result) throw createError({ statusCode: 404, statusMessage: 'source not found' })
  return result
})
