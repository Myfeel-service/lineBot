import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { getAlertFixOp } from '~~/server/utils/alert-fix-ops'

/**
 * POST /api/admin/alert-fix/preview
 * Body: { opId }（workspaceId 走 query，與其他 admin 端點同款）
 *
 * 一鍵修的「會做什麼」預告：**當下查實況**回會動哪幾筆——popup 上的每一句都來自這裡，
 * 前端不寫死動作說明（`D-34`）。唯讀、無副作用，可以放心重打。
 * 權限吃該 op 自己的門檻（與異常註冊表同一把尺：operate=agent、settings=admin）。
 */
export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => ({}))
  const { op } = getAlertFixOp(String(body?.opId ?? '').trim())
  const { workspaceId, uid } = await requireWorkspaceAccess(event, op.minRole)
  return op.preview({
    db: getDb(),
    workspaceId,
    uid,
    authHeader: getHeader(event, 'authorization'),
  })
})
