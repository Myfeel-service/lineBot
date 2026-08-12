import { requireCapability } from '~~/server/utils/workspace-auth'
import { generateScriptDraft } from '~~/server/utils/ai-script-generate'
import { getAiSettings } from '~~/server/utils/ai-settings'
import { recordAiUsage } from '~~/server/utils/ai-usage'

/**
 * AI 一句話生成腳本草稿。只回草稿、不寫資料庫——
 * 前端載入編輯器讓人審,按「建立腳本」才走既有的 create 端點存檔。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'scripts.write')
  const body = await readBody(event)
  // 敏感情境詞排在腳本之前攔截,生成端要拿它剔除「永遠輪不到」的觸發關鍵字。
  // 讀不到設定就用空清單:生成照跑,只是少了這層剔除(編輯器的輪得到檢查還會再把關一次)
  const settings = await getAiSettings(workspaceId).catch(() => null)
  const draft = await generateScriptDraft(String(body?.description ?? ''), {
    sensitiveTopics: settings?.sensitiveTopics ?? [],
  })

  // 生成屬內部管理操作 → 記進**後台自用**那桶(test*),不是真客人那桶。
  // 一次生成會吐出一整份腳本,輸出 token 約是一則客人回覆的 8~10 倍,
  // 記錯桶會讓「每則客人成本」明顯虛高(2026-08-10 稽核抓到,與後台小幫手同一個毛病)。
  // 次數也一起記:成本進了哪一桶,對應的次數就要進同一桶,否則「每次多少錢」又會算錯。
  recordAiUsage(workspaceId, {
    testInputTokens: draft.inputTokens,
    testOutputTokens: draft.outputTokens,
    testInvocations: 1,
  }).catch(e => console.error('[scripts/generate] recordAiUsage error:', e))

  return { name: draft.name, nodes: draft.nodes, rootNodeId: draft.rootNodeId }
})
