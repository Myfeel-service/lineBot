import { getDb } from '~~/server/utils/firebase'
import { seedWorkspaceSystemModules } from '~~/server/utils/workspace-system-modules'
import { requireCapability } from '~~/server/utils/workspace-auth'

export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'marketing.write')
  const results = await seedWorkspaceSystemModules(getDb(), workspaceId)
  return { ok: true, results }
})
