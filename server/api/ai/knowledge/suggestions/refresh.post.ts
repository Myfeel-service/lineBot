import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { MANUAL_SCAN_MIN_GAP_MS, requestGapScan } from '~~/server/utils/ai-knowledge-suggest'

/**
 * POST /api/ai/knowledge/suggestions/refresh
 *
 * 標記「這個 workspace 要重新掃描知識缺口」，由 cron（10 分鐘輪）優先撿走。
 * 不同步跑：聚類要 embed、草擬要 LLM，同步跑會撞閘道逾時（preview-chunks 前例）。
 *
 * 有最小間隔（伺服器端強制）：一次分析要跑上百次 embedding 與數次 LLM，
 * 而這些成本不受回覆則數額度攔阻——沒有地板的話連點就是成本槓桿。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')
  const queued = await requestGapScan(getDb(), workspaceId)
  return {
    queued,
    ...(queued ? {} : { retryAfterMinutes: Math.round(MANUAL_SCAN_MIN_GAP_MS / 60_000) }),
  }
})
