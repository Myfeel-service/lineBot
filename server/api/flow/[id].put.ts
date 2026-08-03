import {
  assertValidFlowMessages,
  assertValidFlowName,
} from '~~/server/utils/flow-validator'
import { getDoc } from '~~/server/utils/firebase'
import { WORKSPACE_FLOW_MODULE_TYPES, type ModuleType } from '~~/shared/types/conversation-stats'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { invalidateBrokenModuleRefsCache } from '~~/server/utils/broken-module-refs'

const VALID_MODULE_TYPES: ModuleType[] = ['welcome', 'bot_flow', 'system_notice', 'live_agent']

export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id is required' })

  const existing = await getDoc<{ isSystem?: boolean; moduleType?: ModuleType; workspaceId?: string }>('flows', id)
  if (!existing) throw createError({ statusCode: 404, statusMessage: '找不到此模組' })
  if (existing.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到此模組' })
  }

  const body = await readBody(event)
  const { name, messages, isActive, moduleType, folderId } = body

  const updates: Record<string, unknown> = {}
  if (name !== undefined) updates.name = assertValidFlowName(name)
  if (messages !== undefined) {
    assertValidFlowMessages(messages)
    updates.messages = messages
  }
  if (isActive !== undefined) updates.isActive = isActive
  // 系統模組不分組（永遠在頂端）；只有 regular flow 可以指定 folderId
  if (folderId !== undefined && !existing.isSystem) {
    updates.folderId = folderId === null ? null : (typeof folderId === 'string' ? folderId : null)
  }
  if (moduleType !== undefined && VALID_MODULE_TYPES.includes(moduleType)) {
    if (existing.isSystem) {
      if (
        existing.moduleType !== undefined
        && (moduleType as ModuleType) !== existing.moduleType
      ) {
        throw createError({ statusCode: 403, statusMessage: '系統模組不可變更模組類型' })
      }
    }
    else {
      if (!WORKSPACE_FLOW_MODULE_TYPES.includes(moduleType as ModuleType)) {
        throw createError({
          statusCode: 400,
          statusMessage: '一般模組僅可為機器人流程或系統通知',
        })
      }
      updates.moduleType = moduleType as ModuleType
    }
  }

  await updateDoc('flows', id, updates)

  // 讓「按鈕按下去沒反應」的異常檢查立刻反映這次變更（否則最多要等 5 分鐘快取過期）
  invalidateBrokenModuleRefsCache(workspaceId)

  return { id, ...updates }
})
