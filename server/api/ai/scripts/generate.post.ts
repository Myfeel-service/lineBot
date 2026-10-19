import { requireCapability } from '~~/server/utils/workspace-auth'
import { generateScriptDraft } from '~~/server/utils/ai-script-generate'
import { getAiSettings } from '~~/server/utils/ai-settings'
import { recordAiUsage } from '~~/server/utils/ai-usage'
import { runMeteredAi, usageFromCalls } from '~~/server/utils/ai-usage-calls'
import { assertPlanAllows } from '~~/server/utils/billing'
import { planAllowsScripting } from '~~/shared/billing/plans'

/**
 * AI 一句話生成腳本草稿。只回草稿、不寫資料庫——
 * 前端載入編輯器讓人審,按「建立腳本」才走既有的 create 端點存檔。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'scripts.write')
  // 方案功能閘門（D-69 拍板④）：腳本是入門方案起才有的權益，以前只印在方案表上。
  await assertPlanAllows(workspaceId, planAllowsScripting, '這個方案不含腳本功能，請升級方案後再使用')
  const body = await readBody(event)
  // 敏感情境詞排在腳本之前攔截,生成端要拿它剔除「永遠輪不到」的觸發關鍵字。
  // 讀不到設定就用空清單:生成照跑,只是少了這層剔除(編輯器的輪得到檢查還會再把關一次)
  const settings = await getAiSettings(workspaceId).catch(() => null)
  // 生成屬內部管理操作 → 記進**後台自用**那桶(test*),不是真客人那桶。
  // 一次生成會吐出一整份腳本,輸出 token 約是一則客人回覆的 8~10 倍,
  // 記錯桶會讓「每則客人成本」明顯虛高(2026-08-10 稽核抓到,與後台小幫手同一個毛病)。
  // 次數也一起記:成本進了哪一桶,對應的次數就要進同一桶,否則「每次多少錢」又會算錯。
  // ⚠️ 用計量器記：沒生好丟 422、JSON 壞掉的那幾次也付了錢（`C-338`②），照實際模型算（`D-130`②）
  const draft = await runMeteredAi(
    () => generateScriptDraft(String(body?.description ?? ''), { sensitiveTopics: settings?.sensitiveTopics ?? [] }),
    calls => recordAiUsage(workspaceId, { ...usageFromCalls('test', calls), testInvocations: 1 }),
  )

  return { name: draft.name, nodes: draft.nodes, rootNodeId: draft.rootNodeId }
})
