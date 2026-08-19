import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { assertMaintenanceBudget } from '~~/server/utils/ai-usage'
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
  await assertMaintenanceBudget(workspaceId) // C-45：補問法會吃 LLM
  const sourceId = String(getRouterParam(event, 'sourceId') ?? '').trim()
  if (!sourceId) throw createError({ statusCode: 400, statusMessage: 'sourceId required' })

  const db = getDb()
  const source = await getSource(db, sourceId, workspaceId)
  if (!source) throw createError({ statusCode: 404, statusMessage: 'source not found' })
  if (source.data.type !== 'gsheet') {
    throw createError({ statusCode: 400, statusMessage: '此來源不是 Google Sheet' })
  }

  // allowMassDeletion：前端在收到 blocked_mass_deletion 後，跳確認框讓使用者
  // 明確同意「真的要刪這麼多」，再帶 true 重打一次放行。
  const body = await readBody(event).catch(() => ({}))
  const r = await syncGoogleSheetSource(db, workspaceId, sourceId, source.data, {
    allowMassDeletion: body?.allowMassDeletion === true,
  })
  if (r.outcome === 'blocked_mass_deletion') {
    // 被擋下＝沒有任何寫入；讓前端拿到數字後跳確認框
    return { sourceId, ...r }
  }
  // 手動同步成功也要清失敗標記——否則商家修好分享權限、按了「立即同步」成功了，
  // 體檢的「來源同步失敗」還在，等於做對了卻看不到結果。
  await clearSourceFailure(db, sourceId, source.data.status)
  return { sourceId, ...r }
})
