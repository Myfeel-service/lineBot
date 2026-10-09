import { v4 as uuidv4 } from 'uuid'
import { FieldValue } from 'firebase-admin/firestore'
import {
  assertValidFlowMessages,
  assertValidFlowName,
} from '~~/server/utils/flow-validator'
import { nextFlowSortOrder, planFlowInsertAbove } from '~~/server/utils/flow-sort'
import { createDoc, getDb, listDocs } from '~~/server/utils/firebase'
import type { ModuleType } from '~~/shared/types/conversation-stats'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { invalidateBrokenModuleRefsCache } from '~~/server/utils/broken-module-refs'
import { assertPlanAllows } from '~~/server/utils/billing'
import { writeAuditLog } from '~~/server/utils/audit-log'
import { planAllowsScripting } from '~~/shared/billing/plans'

export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'marketing.write')
  // 方案功能閘門（D-69 拍板④）：流程自動化是入門方案起才有的權益，以前只印在方案表上。
  await assertPlanAllows(workspaceId, planAllowsScripting, '這個方案不含流程自動化功能，請升級方案後再使用')
  const body = await readBody(event)
  const { name, messages, isActive } = body

  const validName = assertValidFlowName(name)
  assertValidFlowMessages(messages)

  const existingRegular = await listDocs<Record<string, unknown>>('flows', (ref) =>
    ref.where('workspaceId', '==', workspaceId),
  ).then((rows) => rows.filter((f) => !f.isSystem))

  /**
   * `insertBeforeId`（複製模組用）：新模組放在這個模組正上方、跟它同一個資料夾。
   * 以前複製出來的一律排在整份清單最上面、不在任何資料夾，模組一多就要捲到頂再一路拖回去。
   * ⚠️ 只在這個工作區的自建模組裡找（`existingRegular`）——系統模組、別家的、剛被刪掉的
   *    都找不到，照舊排最上面；前端複製完會捲到新模組那一列，排到哪裡人都看得到。
   */
  const insertBeforeId = typeof body?.insertBeforeId === 'string' ? body.insertBeforeId : ''
  const anchor = insertBeforeId ? existingRegular.find(f => f.id === insertBeforeId) : undefined
  const placement = anchor ? planFlowInsertAbove(existingRegular, anchor.id) : null
  const folderId = typeof anchor?.folderId === 'string' && anchor.folderId ? anchor.folderId : null

  if (placement?.updates.length) {
    // 先挪別人、再建新的：挪到一半失敗頂多是排序亂一點，不會多出一份「建好了卻回報失敗」的模組
    const db = getDb()
    for (let i = 0; i < placement.updates.length; i += 400) {
      const batch = db.batch()
      for (const u of placement.updates.slice(i, i + 400)) {
        batch.update(db.collection('flows').doc(u.id), { sortOrder: u.sortOrder })
      }
      await batch.commit()
    }
  }

  const id = uuidv4()
  const doc = await createDoc('flows', id, {
    name: validName,
    messages,
    isActive: isActive ?? true,
    // 自建模組一律 bot_flow：body 帶什麼都不看（口徑見 shared/types/conversation-stats.ts）
    moduleType: 'bot_flow' as ModuleType,
    isSystem: false,
    workspaceId,
    sortOrder: placement ? placement.sortOrder : nextFlowSortOrder(existingRegular),
    ...(folderId ? { folderId } : {}),
    createdAt: FieldValue.serverTimestamp(),
  })

  // 讓「按鈕按下去沒反應」的異常檢查立刻反映這次變更（否則最多要等 5 分鐘快取過期）
  invalidateBrokenModuleRefsCache(workspaceId)

  // 稽核（`C-254`）：模組是客人真的會收到的內容，建了什麼要查得到
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'flow.create',
    targetId: id,
    after: { name: validName, isActive: isActive ?? true, messagesCount: messages.length, ...(folderId ? { folderId } : {}) },
  })

  return doc
})
