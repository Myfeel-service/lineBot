import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { getSource, updateSourceSettings } from '~~/server/utils/ai-knowledge-sources'
import { writeAuditLog, auditSnapshot, diffChangedFields } from '~~/server/utils/audit-log'

/**
 * PUT /api/ai/sources/:sourceId
 * Body: { refreshIntervalMinutes?, onChangeBehavior?, name?, productName?, url?, clearExcludedRows? }
 *
 * 只動使用者可配置欄位；hash / etag / lastFetchedAt 等系統欄位不在這支處理
 * （例外：改 url 會一併重設比對基準、clearExcludedRows 會清掉試算表的內容指紋，見 updateSourceSettings）。
 * productName 改動後前端要接著打 POST /api/ai/sources/:id/reindex 重建該來源索引才生效。
 *
 * `clearExcludedRows: true`（`D-125`②，只有 Google 試算表）：在後台刪掉、之後不再收的那幾列重新收回來，
 * 下一次同步（每小時，或按「立即同步」）加回知識庫。不是試算表＝400。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'sources.write')
  const sourceId = String(getRouterParam(event, 'sourceId') ?? '').trim()
  if (!sourceId) throw createError({ statusCode: 400, statusMessage: 'sourceId required' })

  const db = getDb()
  const before = await getSource(db, sourceId, workspaceId)
  const body = await readBody(event).catch(() => ({}))
  // 收回來幾列要在改之前數（改完名單就是空的了）
  const reAddedRows = body?.clearExcludedRows === true ? (before?.data.gsheetExcludedTitles?.length ?? 0) : 0
  const result = await updateSourceSettings(db, workspaceId, sourceId, {
    refreshIntervalMinutes: body?.refreshIntervalMinutes,
    onChangeBehavior: body?.onChangeBehavior,
    name: body?.name,
    folderId: body?.folderId === null ? null : (typeof body?.folderId === 'string' ? body.folderId : undefined),
    productName: typeof body?.productName === 'string' ? body.productName : undefined,
    urlAutoApply: typeof body?.urlAutoApply === 'boolean' ? body.urlAutoApply : undefined,
    url: typeof body?.url === 'string' ? body.url : undefined,
    clearExcludedRows: body?.clearExcludedRows === true,
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
  // 重新收回來的列（`D-125`②）只寫在備註：那是一串標題，放進前後對照會被截斷、也看不懂
  if (diff.changedKeys.length || reAddedRows) {
    await writeAuditLog({
      workspaceId,
      uid,
      actor: 'human',
      action: 'source.put',
      targetId: sourceId,
      before: diff.before,
      after: diff.after,
      note: String(before?.data.name ?? '')
        + (reAddedRows ? `：在後台刪掉的 ${reAddedRows} 列重新收回來，下一次同步會加回知識庫` : ''),
    }, db)
  }

  return result
})
