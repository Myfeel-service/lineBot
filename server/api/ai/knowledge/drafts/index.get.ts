import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { listDrafts } from '~~/server/utils/knowledge-drafts'

/**
 * GET /api/ai/knowledge/drafts
 *
 * 「等你看過」的知識卡，照「來自哪一頁」分組；加上整理進度與額度（`C-250`③）。
 * 知識庫頁的「等你看過」那一區、小幫手、落地導覽都讀這一支。
 * 唯讀，viewer 就看得到（知識庫本來就開給 viewer 讀）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')
  return listDrafts(workspaceId, getDb())
})
