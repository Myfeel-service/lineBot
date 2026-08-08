import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { invalidateScriptsCache, SCRIPTS_COLLECTION } from '~~/server/utils/ai-scripts'
import { invalidateScriptHealthCache } from '~~/server/utils/script-health'

export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'scripts.write')
  const scriptId = String(getRouterParam(event, 'scriptId') ?? '').trim()
  if (!scriptId) throw createError({ statusCode: 400, statusMessage: 'scriptId required' })

  const db = getDb()
  const ref = db.collection(SCRIPTS_COLLECTION).doc(scriptId)
  const snap = await ref.get()
  if (!snap.exists) return { ok: true }
  if ((snap.data() as { workspaceId?: string })?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 403, statusMessage: 'workspace mismatch' })
  }
  await ref.delete()
  invalidateScriptsCache(workspaceId)
  // 腳本改完,異常中心的「輪不到／走不完」要立刻反映,不要等 5 分鐘快取過期
  invalidateScriptHealthCache(workspaceId)
  return { ok: true }
})
