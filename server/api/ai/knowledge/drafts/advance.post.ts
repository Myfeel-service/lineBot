import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { advanceSiteCards, getSiteCardsJobId } from '~~/server/utils/store-profile-jobs'

/**
 * POST /api/ai/knowledge/drafts/advance
 *
 * 把「讀到的網站頁 → 等你看過的卡」往前推一步（`C-250`③）。
 * 呼叫的人：精靈（他在採用草稿時背景推）、知識庫頁（打開時推）；沒人推時排程每 10 分鐘補。
 * 一步最多整理 2 頁；別人正在推就直接回目前狀態（租約擋著，⛔ 不會同一頁切兩次）。
 * ⚠️ 會花 LLM 的錢（切卡），所以要能改知識庫的人（agent 以上）才叫得動。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'knowledge.write')
  const db = getDb()
  const jobId = await getSiteCardsJobId(workspaceId, db)
  if (!jobId) return { cards: null }
  const cards = await advanceSiteCards(jobId, db)
  return { cards }
})
