import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { assertMaintenanceBudget } from '~~/server/utils/ai-usage'
import { reenrichWorkspaceChunks } from '~~/server/utils/ai-reenrich'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * POST /api/ai/knowledge/reenrich
 * Body: { cursor?: string }（上一批回傳的 nextCursor；首批不帶）
 *
 * 掃描工作區知識卡，對「沒有問法、且非人工編輯／非總覽卡」的卡片補上「客人問法」（只補不改
 * title / content）。用途：
 *   1. 回填功能上線前就存在、天生沒問法的舊卡（一列一卡的 gsheet / 乾淨 Excel）。
 *   2. 修復同步當下補問法失敗（暫時性 LLM 錯誤）而留下的空問法卡。
 *
 * 分批處理（cursor 分頁）避免大工作區單請求超時；nextCursor 非 null 代表還有下一批，
 * 呼叫端帶著 cursor 重複呼叫直到 null。冪等、可中斷重跑。邏輯在 reenrichWorkspaceChunks。
 */
export default defineEventHandler(async (event) => {
  // 全工作區的知識維運操作，沿用與 reindex-all 相同的權限
  const { workspaceId, uid } = await requireCapability(event, 'knowledge.reindexAll')
  await assertMaintenanceBudget(workspaceId) // C-45：補問法整庫掃描是純維運花費，超額不開跑
  const body = await readBody(event).catch(() => ({}))
  const cursor = String(body?.cursor ?? '').trim()
  const db = getDb()
  const result = await reenrichWorkspaceChunks(db, workspaceId, cursor)

  // 稽核（`C-254`）：這支會**改到卡片內容**（補上客人問法）並花 LLM 的錢。
  // ⭐ 跟 reindex-all 同一個道理，只記第一批＝「某人按下去」那一刻，續跑的批次不重複記
  if (!cursor) {
    await writeAuditLog({
      workspaceId,
      uid,
      actor: 'human',
      action: 'knowledge.reenrich',
      after: { itemsCount: result.batch, chunkIdsCount: result.enriched },
      note: '幫沒有「客人問法」的卡補上問法（會分批跑完，這裡記的是第一批的數字）',
    }, db)
  }

  return result
})
