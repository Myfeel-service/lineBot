import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { listFolders } from '~~/server/utils/ai-knowledge-folders'

/**
 * GET /api/ai/folders
 * 列出工作區內所有資料夾（依 order 升冪）。
 * 每一個帶 `general`（`C-320`）：true＝「通用」分組（不是講單一商品），false＝商品分組。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'ai.read')
  const items = await listFolders(getDb(), workspaceId)
  return { items }
})
