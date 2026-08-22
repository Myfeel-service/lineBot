import { v4 as uuidv4 } from 'uuid'
import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { findEnabledFollowScriptConflict, invalidateScriptsCache, SCRIPTS_COLLECTION } from '~~/server/utils/ai-scripts'
import { invalidateScriptHealthCache } from '~~/server/utils/script-health'
import { normalizeScriptInput, stripTriggerEmbeddings, type ScriptInput } from '~~/server/utils/ai-script-validation'
import { scriptTriggerEvent, validateScriptDoc } from '~~/shared/types/ai-script'

export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'scripts.write')
  const body = await readBody(event)
  const input: ScriptInput = normalizeScriptInput(body)
  const err = validateScriptDoc({ name: input.name, nodes: input.nodes, rootNodeId: input.rootNodeId })
  if (err) throw createError({ statusCode: 400, statusMessage: err })

  // 一個帳號只能有一條啟用中的「加好友時」腳本，否則客人一加好友會被兩條各接一次
  if (input.enabled && scriptTriggerEvent(input) === 'follow') {
    const conflict = await findEnabledFollowScriptConflict(workspaceId)
    if (conflict) {
      throw createError({
        statusCode: 409,
        statusMessage: `已經有一條在客人加好友時啟動的腳本（「${conflict.name}」）。兩條都開的話，客人一加好友會連收兩份訊息——請先停用那一條，或直接修改它。`,
      })
    }
  }

  const id = uuidv4()
  const now = FieldValue.serverTimestamp()
  await getDb().collection(SCRIPTS_COLLECTION).doc(id).set({
    workspaceId,
    name: input.name,
    enabled: input.enabled,
    priority: input.priority,
    nodes: input.nodes,
    rootNodeId: input.rootNodeId,
    createdAt: now,
    updatedAt: now,
  })
  invalidateScriptsCache(workspaceId)
  // 腳本改完,異常中心的「輪不到／走不完」要立刻反映,不要等 5 分鐘快取過期
  invalidateScriptHealthCache(workspaceId)
  // stripTriggerEmbeddings：清掉舊資料可能殘留的 embedding，不回傳給前端
  return { id, ...input, nodes: stripTriggerEmbeddings(input.nodes) }
})
