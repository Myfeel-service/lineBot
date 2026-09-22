import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { generateTagReport, getTagReport } from '~~/server/utils/tag-report'
import { canRegenerate, cooldownRemainingMs, cooldownText } from '~~/shared/tag-report'

/**
 * POST /api/tag/report — 重新產生客群分析報告（`D-28`／`D-63`）
 *
 * **⛔ 這支很貴**：一趟約三四千次 Firestore 讀取＋一次 LLM。所以有兩道閘門：
 *  ① **1 小時冷卻**（`D-28` 鐵律①）——⛔ 不要加 `force` 參數繞過它。
 *     真的需要「立刻重算」時該問的是「為什麼一小時前那份不夠用」。
 *  ② **`agent` 以上才按得動**（`D-28` 第三題的建議答案）：viewer 看得到報告、按不動產生。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, token } = await requireWorkspaceAccess(event, 'agent')
  const db = getDb()

  const prev = await getTagReport(db, workspaceId)
  const now = Date.now()
  if (!canRegenerate(prev?.generatedAtMs ?? null, now)) {
    // ⛔ 冷卻中回 429 並**講得出還要多久**，不要只說「請稍後再試」
    throw createError({
      statusCode: 429,
      statusMessage: cooldownText(cooldownRemainingMs(prev?.generatedAtMs ?? null, now)),
    })
  }

  const by = String(token?.name ?? token?.email ?? '')
  const report = await generateTagReport(db, workspaceId, by)

  return {
    report,
    canRegenerate: false,
    cooldownRemainingMs: cooldownRemainingMs(report.generatedAtMs, Date.now()),
  }
})
