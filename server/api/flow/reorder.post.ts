import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { writeAuditLog } from '~~/server/utils/audit-log'

export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'marketing.write')
  const body = await readBody(event)
  const orderedIds = body?.orderedIds

  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'orderedIds is required' })
  }

  const ids = orderedIds.map((id: unknown) => String(id || '').trim()).filter(Boolean)
  if (ids.length !== orderedIds.length) {
    throw createError({ statusCode: 400, statusMessage: 'orderedIds 格式錯誤' })
  }

  const allFlows = await listDocs<{ isSystem?: boolean; workspaceId?: string }>('flows', (ref) =>
    ref.where('workspaceId', '==', workspaceId),
  )

  const regularFlows = allFlows.filter((f) => !f.isSystem)
  const regularIdSet = new Set(regularFlows.map((f) => f.id))

  if (ids.length !== regularFlows.length) {
    throw createError({ statusCode: 400, statusMessage: '排序列表與可排序模組數量不符' })
  }

  for (const id of ids) {
    if (!regularIdSet.has(id)) {
      throw createError({ statusCode: 400, statusMessage: '含有無效或不可排序的模組' })
    }
  }

  const db = getDb()
  const batch = db.batch()
  ids.forEach((id, index) => {
    batch.update(db.collection('flows').doc(id), { sortOrder: index })
  })
  await batch.commit()

  // 稽核（`C-254`）：排序只影響後台清單的順序，不改客人收到的東西，
  // 所以只記「動了幾個」，⛔ 不把整串 id 塞進紀錄（那會變成沒人看得懂的一長串）
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'flow.reorder',
    after: { itemsCount: ids.length },
  }, db)

  return { success: true }
})
