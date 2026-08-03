import { v4 as uuidv4 } from 'uuid'
import { FieldValue } from 'firebase-admin/firestore'
import {
  assertValidFlowMessages,
  assertValidFlowName,
} from '~~/server/utils/flow-validator'
import { nextFlowSortOrder } from '~~/server/utils/flow-sort'
import { WORKSPACE_FLOW_MODULE_TYPES, type ModuleType } from '~~/shared/types/conversation-stats'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { invalidateBrokenModuleRefsCache } from '~~/server/utils/broken-module-refs'

export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')
  const body = await readBody(event)
  const { name, messages, isActive, moduleType } = body

  const validName = assertValidFlowName(name)
  assertValidFlowMessages(messages)

  const resolvedModuleType: ModuleType = WORKSPACE_FLOW_MODULE_TYPES.includes(moduleType)
    ? moduleType
    : 'bot_flow'

  const existingRegular = await listDocs<Record<string, unknown>>('flows', (ref) =>
    ref.where('workspaceId', '==', workspaceId),
  ).then((rows) => rows.filter((f) => !f.isSystem))

  const id = uuidv4()
  const doc = await createDoc('flows', id, {
    name: validName,
    messages,
    isActive: isActive ?? true,
    moduleType: resolvedModuleType,
    isSystem: false,
    workspaceId,
    sortOrder: nextFlowSortOrder(existingRegular),
    createdAt: FieldValue.serverTimestamp(),
  })

  // 讓「按鈕按下去沒反應」的異常檢查立刻反映這次變更（否則最多要等 5 分鐘快取過期）
  invalidateBrokenModuleRefsCache(workspaceId)

  return doc
})
