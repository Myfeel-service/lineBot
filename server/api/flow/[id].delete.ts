import { deleteDoc, getDoc } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { invalidateBrokenModuleRefsCache } from '~~/server/utils/broken-module-refs'
import { writeAuditLog, auditSnapshot } from '~~/server/utils/audit-log'

export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'marketing.write')
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id is required' })

  const flow = await getDoc<Record<string, unknown> & { isSystem?: boolean; workspaceId?: string }>('flows', id)
  /**
   * `D-110`：先確認「是不是你的」，再講「是不是系統模組」。
   * ⛔ 順序反過來的話，拿別家工作區的系統模組 id 來打，會收到 403「系統模組不可刪除」
   *    而不是 404——等於跟外人證實「這個 id 存在、而且是系統模組」。
   *    別家的東西一律跟「不存在」長得一模一樣。
   */
  if (!flow || flow.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }
  if (flow.isSystem) {
    throw createError({ statusCode: 403, statusMessage: '系統模組不可刪除' })
  }

  await deleteDoc('flows', id)

  // 讓「按鈕按下去沒反應」的異常檢查立刻反映這次變更（否則最多要等 5 分鐘快取過期）
  invalidateBrokenModuleRefsCache(workspaceId)

  // 稽核（`C-254`）：刪模組會讓別處指向它的按鈕整個變成死路，⛔ 這一筆一定要留得下名字
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'flow.delete',
    targetId: id,
    before: auditSnapshot(flow, { keep: ['name', 'isActive', 'folderId'], count: ['messages'] }),
    note: String(flow.name ?? ''),
  })

  return { success: true }
})
