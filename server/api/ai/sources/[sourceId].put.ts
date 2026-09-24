import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { getSource, updateSourceSettings } from '~~/server/utils/ai-knowledge-sources'
import { writeAuditLog, auditSnapshot, diffChangedFields } from '~~/server/utils/audit-log'

/**
 * PUT /api/ai/sources/:sourceId
 * Body: { refreshIntervalMinutes?, onChangeBehavior?, name?, productName?, url? }
 *
 * 只動使用者可配置欄位；hash / etag / lastFetchedAt 等系統欄位不在這支處理
 * （例外：改 url 會一併重設比對基準，見 updateSourceSettings）。
 * productName 改動後前端要接著打 POST /api/ai/sources/:id/reindex 重建該來源索引才生效。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'sources.write')
  const sourceId = String(getRouterParam(event, 'sourceId') ?? '').trim()
  if (!sourceId) throw createError({ statusCode: 400, statusMessage: 'sourceId required' })

  const db = getDb()
  const before = await getSource(db, sourceId, workspaceId)
  const body = await readBody(event).catch(() => ({}))
  const result = await updateSourceSettings(db, workspaceId, sourceId, {
    refreshIntervalMinutes: body?.refreshIntervalMinutes,
    onChangeBehavior: body?.onChangeBehavior,
    name: body?.name,
    folderId: body?.folderId === null ? null : (typeof body?.folderId === 'string' ? body.folderId : undefined),
    productName: typeof body?.productName === 'string' ? body.productName : undefined,
    urlAutoApply: typeof body?.urlAutoApply === 'boolean' ? body.urlAutoApply : undefined,
    url: typeof body?.url === 'string' ? body.url : undefined,
  })
  if (!result) throw createError({ statusCode: 404, statusMessage: 'source not found' })

  /*
   * 稽核（`C-254`）。⭐ 這裡最要緊的兩格：
   * `productName` 改了會換掉整份資料歸屬的商品（答錯台的老毛病），
   * `url` 改了會連比對基準一起重設（下一次同步會把卡片整批換掉）。
   */
  const keep = ['name', 'productName', 'url', 'folderId', 'refreshIntervalMinutes', 'onChangeBehavior'] as const
  const diff = diffChangedFields(
    auditSnapshot(before?.data as Record<string, unknown> | undefined, { keep })!,
    auditSnapshot(result as unknown as Record<string, unknown>, { keep })!,
  )
  if (diff.changedKeys.length) {
    await writeAuditLog({
      workspaceId,
      uid,
      actor: 'human',
      action: 'source.put',
      targetId: sourceId,
      before: diff.before,
      after: diff.after,
      note: String(before?.data.name ?? ''),
    }, db)
  }

  return result
})
