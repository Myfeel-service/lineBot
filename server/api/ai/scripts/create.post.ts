import { v4 as uuidv4 } from 'uuid'
import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { invalidateScriptsCache, SCRIPTS_COLLECTION } from '~~/server/utils/ai-scripts'
import { invalidateScriptHealthCache } from '~~/server/utils/script-health'
import { normalizeScriptInput, stripTriggerEmbeddings, type ScriptInput } from '~~/server/utils/ai-script-validation'
import { validateScriptDoc } from '~~/shared/types/ai-script'

export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'scripts.write')
  const body = await readBody(event)
  const input: ScriptInput = normalizeScriptInput(body)
  const err = validateScriptDoc({ name: input.name, nodes: input.nodes, rootNodeId: input.rootNodeId })
  if (err) throw createError({ statusCode: 400, statusMessage: err })

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
