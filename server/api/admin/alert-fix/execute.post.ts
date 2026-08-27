import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { getAlertFixOp } from '~~/server/utils/alert-fix-ops'

/**
 * POST /api/admin/alert-fix/execute
 * Body: { opId }（workspaceId 走 query）
 *
 * 一鍵修的執行：**只有人按過 popup 的確定才會打到這裡**（前端 AlertFixDialog 的流程），
 * op 本身冪等、可重按，每次執行都寫 auditLogs（在各 op 內，actor='human'）。
 * 「修好了沒」這裡不宣告——前端執行完會 refresh({force:true}) 重跑同一份異常訊號驗證。
 */
export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => ({}))
  const { op } = getAlertFixOp(String(body?.opId ?? '').trim())
  const { workspaceId, uid } = await requireWorkspaceAccess(event, op.minRole)
  return op.execute({
    db: getDb(),
    workspaceId,
    uid,
    authHeader: getHeader(event, 'authorization'),
  })
})
