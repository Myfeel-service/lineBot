import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { getTagReport } from '~~/server/utils/tag-report'
import { canRegenerate, cooldownRemainingMs } from '~~/shared/tag-report'

/**
 * GET /api/tag/report — 最近一份客群分析報告（`D-28`／`D-63`）
 *
 * ⛔ **這支不算任何東西，只讀存檔**（`D-28` 鐵律①）。要重算走 `POST /api/tag/report`，
 *   那支有 1 小時冷卻。⛔ 不要為了「開頁就是最新的」把運算搬回這裡——
 *   一趟約三四千次 Firestore 讀取。
 *
 * 讀取權限跟這區其他頁一致：`viewer` 看得到（按鈕另依角色隱藏）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')
  const report = await getTagReport(getDb(), workspaceId)
  const now = Date.now()

  return {
    /** `null`＝**還沒產生過**，⛔ 跟「產生了但沒有資料」是兩件事，畫面要講不同的話 */
    report,
    canRegenerate: canRegenerate(report?.generatedAtMs ?? null, now),
    cooldownRemainingMs: cooldownRemainingMs(report?.generatedAtMs ?? null, now),
  }
})
