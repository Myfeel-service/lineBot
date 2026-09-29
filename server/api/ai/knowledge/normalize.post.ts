import { requireCapability } from '~~/server/utils/workspace-auth'
import { normalizeChunkWithLlm } from '~~/server/utils/ai-knowledge-chunker'
import { recordAiUsage } from '~~/server/utils/ai-usage'

/**
 * POST /api/ai/knowledge/normalize
 * Body: { title, content, tags[] }
 *
 * 把單張卡的 title/content/tags 送進 LLM 整理成標準格式：
 *   - content 前加「重點：」keyword 摘要
 *   - 移除品號 / SKU / 系統編號
 *   - 重寫為口語完整句
 *
 * 純整理：不寫 Firestore（呼叫端拿回來自己決定要不要存）。
 * Token 用量會計入 aiUsage。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'knowledge.write')
  const body = await readBody(event)
  const title = String(body?.title ?? '').trim()
  const content = String(body?.content ?? '').trim()
  const tags = Array.isArray(body?.tags)
    ? body.tags.map((t: unknown) => String(t).trim()).filter(Boolean)
    : []
  if (!title || !content) {
    throw createError({ statusCode: 400, statusMessage: '請提供 title 與 content' })
  }

  const result = await normalizeChunkWithLlm({ title, content, tags })

  await recordAiUsage(workspaceId, {
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    importInputTokens: result.inputTokens,
    importOutputTokens: result.outputTokens,
  }).catch(() => {})

  return {
    title: result.title,
    content: result.content,
    tags: result.tags,
    questions: result.questions,
  }
})
