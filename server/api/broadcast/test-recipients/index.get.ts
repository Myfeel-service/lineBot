import { requireCapability } from '~~/server/utils/workspace-auth'
import { buildTestRecipients } from '~~/server/utils/broadcast-test-recipients'

/**
 * GET /api/broadcast/test-recipients —— 試發框要列的那份名單（`D-119` ⑥）：
 * 自己綁好的手機、綁好的同事、常找來看稿的人。門檻跟試發同一個（`broadcast.write`）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'broadcast.write')
  return buildTestRecipients(workspaceId, uid)
})
