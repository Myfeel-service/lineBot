import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { generateAutoReplyDraft } from '~~/server/utils/ai-auto-reply-generate'
import { recordAiUsage } from '~~/server/utils/ai-usage'

/**
 * AI 一句話生成自動回覆規則草稿。只回草稿、不寫資料庫——
 * 前端填進表單讓人審,按「建立規則」才走既有的 create 端點存檔。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')
  const body = await readBody(event)
  const { inputTokens, outputTokens, ...draft } = await generateAutoReplyDraft(String(body?.description ?? ''))

  recordAiUsage(workspaceId, { inputTokens, outputTokens })
    .catch(e => console.error('[auto-reply/generate] recordAiUsage error:', e))

  return draft
})
