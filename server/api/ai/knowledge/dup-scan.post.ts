import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { assertMaintenanceBudget } from '~~/server/utils/ai-usage'
import { runDuplicateScan } from '~~/server/utils/ai-duplicate-scan'
import { runWithLlmBudget } from '~~/server/utils/gemini'

/**
 * POST /api/ai/knowledge/dup-scan — 手動觸發「疑似重複」掃描（C-40(c)）。
 * 排程本來就會掃（每 workspace ≤ 一次 LLM 呼叫/天）；這顆給「剛整理完想立刻確認」用。
 * 卡片集合沒變時直接回上次結果（零 LLM 費）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'sources.write')
  await assertMaintenanceBudget(workspaceId) // C-45：判官那一次呼叫也要吃額度
  const db = getDb()
  const result = await runWithLlmBudget(workspaceId, () => runDuplicateScan(db, workspaceId, { force: true }))
  return { workspaceId, ...result }
})
