import { getDoc } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { writeAuditLog, auditSnapshot } from '~~/server/utils/audit-log'

export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireWorkspaceAccess(event, 'agent')
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id is required' })

  const existing = await getDoc<Record<string, unknown> & { workspaceId?: string }>('richMessages', id)
  if (!existing || existing.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }

  await deleteDoc('richMessages', id)

  // 稽核（`C-254`）：模組裡引用到它的地方會變成死路，名字要留得下來
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'richMessage.delete',
    targetId: id,
    before: auditSnapshot(existing, { keep: ['name', 'isActive', 'altText'], count: ['actions'] }),
    note: String(existing.name ?? ''),
  })

  return { success: true }
})
