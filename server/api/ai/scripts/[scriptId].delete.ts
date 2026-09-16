import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { invalidateScriptsCache, SCRIPTS_COLLECTION } from '~~/server/utils/ai-scripts'
import { invalidateScriptHealthCache } from '~~/server/utils/script-health'
import { writeAuditLog } from '~~/server/utils/audit-log'

export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'scripts.write')
  const scriptId = String(getRouterParam(event, 'scriptId') ?? '').trim()
  if (!scriptId) throw createError({ statusCode: 400, statusMessage: 'scriptId required' })

  const db = getDb()
  const ref = db.collection(SCRIPTS_COLLECTION).doc(scriptId)
  const snap = await ref.get()
  if (!snap.exists) return { ok: true }
  if ((snap.data() as { workspaceId?: string })?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 403, statusMessage: 'workspace mismatch' })
  }
  const removed = snap.data() as { name?: string, enabled?: boolean, nodes?: unknown[] }
  await ref.delete()
  invalidateScriptsCache(workspaceId)
  // 刪掉的東西最該留紀錄：文件沒了，紀錄是唯一還說得出「本來有這條」的地方
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'ai/scripts.delete',
    targetId: scriptId,
    before: { name: removed?.name ?? '', enabled: removed?.enabled === true, stepCount: (removed?.nodes ?? []).length },
    after: null,
  })
  // 腳本改完,異常中心的「輪不到／走不完」要立刻反映,不要等 5 分鐘快取過期
  invalidateScriptHealthCache(workspaceId)
  return { ok: true }
})
