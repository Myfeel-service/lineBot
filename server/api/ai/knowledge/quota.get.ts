import { requireCapability } from '~~/server/utils/workspace-auth'
import { getKnowledgeChunkQuota, quotaForRole } from '~~/server/utils/ai-knowledge-quota'

/**
 * GET /api/ai/knowledge/quota
 * 這個帳號的知識量現在用了幾條、上限幾條（`C-296`）。
 *
 * 為什麼要有：匯入視窗以前**按下「匯入」那一刻才知道放不下**，而且是整批不收——
 * 等了幾分鐘、看完 42 條，最後一步撞牆。放之前就看得到剩幾條，才能先挑、或先去升級。
 * 回 null＝訂閱讀不到（照舊 fail-open，畫面就不顯示這一行）。方案名照 `G-103` 依角色拿掉。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, role } = await requireCapability(event, 'ai.read')
  return { quota: quotaForRole(await getKnowledgeChunkQuota(workspaceId), role) }
})
