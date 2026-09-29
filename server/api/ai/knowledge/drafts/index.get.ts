import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { countDrafts, listDrafts } from '~~/server/utils/knowledge-drafts'
import { quotaForRole } from '~~/server/utils/ai-knowledge-quota'

/**
 * GET /api/ai/knowledge/drafts[?summary=1]
 *
 * 「等你看過」的知識卡，照「來自哪一頁」分組；加上整理進度與額度（`C-250`③）。
 * 知識庫頁的「等你看過」那一區讀整份；小幫手、落地導覽、精靈只要張數＝帶 `summary=1`（只數張數，⛔ 不讀全文）。
 * 唯讀，viewer 就看得到（知識庫本來就開給 viewer 讀）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, role } = await requireCapability(event, 'ai.read')
  const q = getQuery(event)
  if (String(q.summary ?? '') === '1') return countDrafts(workspaceId, getDb())
  const r = await listDrafts(workspaceId, getDb())
  return { ...r, quota: quotaForRole(r.quota, role) }
})
