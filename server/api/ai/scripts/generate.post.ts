import { requireCapability } from '~~/server/utils/workspace-auth'
import { generateScriptDraft } from '~~/server/utils/ai-script-generate'
import { recordAiUsage } from '~~/server/utils/ai-usage'

/**
 * AI 一句話生成腳本草稿。只回草稿、不寫資料庫——
 * 前端載入編輯器讓人審,按「建立腳本」才走既有的 create 端點存檔。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'scripts.write')
  const body = await readBody(event)
  const draft = await generateScriptDraft(String(body?.description ?? ''))

  // 生成屬內部管理操作,token 記到該 workspace 用量(與意圖路由同慣例:呼叫端記帳)
  recordAiUsage(workspaceId, { inputTokens: draft.inputTokens, outputTokens: draft.outputTokens })
    .catch(e => console.error('[scripts/generate] recordAiUsage error:', e))

  return { name: draft.name, nodes: draft.nodes, rootNodeId: draft.rootNodeId }
})
