import { requireCapability } from '~~/server/utils/workspace-auth'
import { getKnowledgeChunkQuota, quotaForRole } from '~~/server/utils/ai-knowledge-quota'
import { aiBudgetMessage, getMaintenanceBudgetStatus } from '~~/server/utils/ai-usage'

/**
 * GET /api/ai/knowledge/quota
 * 這個帳號的知識量現在用了幾條、上限幾條（`C-296`）。
 *
 * 為什麼要有：匯入視窗以前**按下「匯入」那一刻才知道放不下**，而且是整批不收——
 * 等了幾分鐘、看完 42 條，最後一步撞牆。放之前就看得到剩幾條，才能先挑、或先去升級。
 * 回 null＝訂閱讀不到（照舊 fail-open，畫面就不顯示這一行）。方案名照 `G-103` 依角色拿掉。
 *
 * `budget`（`C-413`）：這個月加入資料到上限了沒。到了的話加入視窗在選檔之前就擋、講幾號恢復
 * （以前要選了檔、按下整理才跳出「…M token」）。查不到＝null，照舊不擋（真的到上限時整理那一步還會擋）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, role } = await requireCapability(event, 'ai.read')
  const [quota, budget] = await Promise.all([
    getKnowledgeChunkQuota(workspaceId),
    getMaintenanceBudgetStatus(workspaceId, undefined, 'knowledge').catch(() => null),
  ])
  return {
    quota: quotaForRole(quota, role),
    budget: budget?.blocked ? { blocked: true as const, ...aiBudgetMessage('knowledge') } : null,
  }
})
