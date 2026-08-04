import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { clearSourceFailure, getSource } from '~~/server/utils/ai-knowledge-sources'
import { syncGoogleSheetSource } from '~~/server/utils/gsheet-sync'

/**
 * POST /api/ai/sources/:sourceId/gsheet-sync
 *
 * 立即手動同步一個 Google Sheet 來源（不用等每小時排程）。
 * 一列一卡直接套用：新增 / 更新 / 刪除；人工編輯過的卡保留不覆蓋。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'sources.write')
  const sourceId = String(getRouterParam(event, 'sourceId') ?? '').trim()
  if (!sourceId) throw createError({ statusCode: 400, statusMessage: 'sourceId required' })

  const db = getDb()
  const source = await getSource(db, sourceId, workspaceId)
  if (!source) throw createError({ statusCode: 404, statusMessage: 'source not found' })
  if (source.data.type !== 'gsheet') {
    throw createError({ statusCode: 400, statusMessage: '此來源不是 Google Sheet' })
  }

  const r = await syncGoogleSheetSource(db, workspaceId, sourceId, source.data)
  // 手動同步成功也要清失敗標記——否則商家修好分享權限、按了「立即同步」成功了，
  // 體檢的「來源同步失敗」還在，等於做對了卻看不到結果。
  await clearSourceFailure(db, sourceId, source.data.status)
  return { sourceId, ...r }
})
