import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { assertMaintenanceBudget } from '~~/server/utils/ai-usage'
import { clearSourceFailure, getSource } from '~~/server/utils/ai-knowledge-sources'
import { syncGoogleSheetSource } from '~~/server/utils/gsheet-sync'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * POST /api/ai/sources/:sourceId/gsheet-sync
 *
 * 立即手動同步一個 Google Sheet 來源（不用等每小時排程）。
 * 一列一卡直接套用：新增 / 更新 / 刪除；人工編輯過的卡保留不覆蓋。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'sources.write')
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

  /*
   * 稽核（`C-254`）。⛔ 三個數字分開記：這一支會**刪卡**，而且使用者可能是為了放行
   * 大量刪除才帶 `allowMassDeletion` 重打一次——「刪了幾張」是這裡最重要的一格。
   * ⚠️ `manualKept` 是「表格改了但卡片沒跟」的張數，那是表格與卡片永久分歧的唯一路徑，
   *    ⛔ 不可以省略（省略＝安靜地少講一件使用者一定要知道的事）。
   */
  if (r.outcome === 'synced') {
    await writeAuditLog({
      workspaceId,
      uid,
      actor: 'human',
      action: 'source.gsheetSync',
      targetId: sourceId,
      after: { name: String(source.data.name ?? ''), added: r.added, updated: r.updated, deleted: r.deleted },
      note: `${String(source.data.name ?? '')}：新增 ${r.added}、更新 ${r.updated}、刪除 ${r.deleted}`
        + (r.manualKept ? `；有 ${r.manualKept} 張因為被人工改過所以沒跟著表格更新` : '')
        + (body?.allowMassDeletion === true ? '；這次是使用者確認過才放行的大量刪除' : ''),
    }, db)
  }

  return { sourceId, ...r }
})
