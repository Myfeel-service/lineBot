import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { listFlowFolders } from '~~/server/utils/flow-folders'

/**
 * GET /api/flow-folders
 * 列出此工作區所有的「機器人模組資料夾」。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'workspace.read')
  const items = await listFlowFolders(getDb(), workspaceId)
  return { items }
})
