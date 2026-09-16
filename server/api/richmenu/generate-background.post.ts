import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { generateImage, runWithLlmBudget } from '~~/server/utils/gemini'
import { recordAiUsage } from '~~/server/utils/ai-usage'
import { getDb } from '~~/server/utils/firebase'

/**
 * POST /api/richmenu/generate-background —— 用 AI 產生圖文選單的**底圖**（`C-193`）。
 *
 * ⛔ 它只畫氣氛，不畫結構。回來的是一張**沒有文字、沒有按鈕、沒有格線**的底圖，
 *    格子與字是前端用畫布照著「實際的可點區域」疊上去的。
 *    這條分工是整件事能成立的關鍵：讓模型把整張選單畫出來的話，
 *    看得到的按鈕跟按得到的區域一定對不齊，而客人點了沒反應這件事
 *    在後台畫面上完全看不出來。
 *
 * ⚠️ 這支會花錢（生圖比生文字貴得多），所以：
 *    - 包在額度境域裡，跟其他 LLM 呼叫用同一道守門
 *    - 用量記進**後台自用**那桶，⛔不要混進「回答客人」的成本
 *    - 一次只產一張，不做批次、不自動重試（失敗就讓人自己再按一次）
 */
export default defineEventHandler(async (event) => {
  // 與其他圖文選單端點同一道門檻
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')

  const body = await readBody(event)
  const theme = String(body?.theme ?? '').trim().slice(0, 120)
  if (!theme)
    throw createError({ statusCode: 400, statusMessage: '請先講一下你想要什麼風格，例如「中秋節，深藍配金色」。' })

  const tall = body?.tall === true
  // LINE 的兩種尺寸：2500×843（約 3:1）與 2500×1686（約 1.48:1）。
  // 生圖只給得出固定幾種比例，挑最接近的，剩下的差距靠前端裁切吸收。
  const aspectRatio = tall ? '3:2' : '21:9'

  /**
   * ⛔ 提示詞要寫成「**描述一張圖長什麼樣**」，不可以寫成「請你幫我畫一張…」那種交辦語氣。
   * 2026-09-17 實測：原本那版用中文條列「⛔不要畫文字」「非常重要的限制」，
   * 模型直接**用講的回你**——「好的，這是一張符合您要求的中秋節底圖：」然後一張圖都沒有，
   * 而且 finishReason 還是 STOP，看起來完全像成功。
   * 主題照使用者原話帶進去（中文沒問題），骨架用英文，否定條件收在最後一行。
   */
  const prompt = [
    'A wide decorative banner background image used as the backdrop of a chat app menu.',
    `Theme: ${theme}`,
    'Flat decorative illustration, soft gradient, ornaments only near the left and right edges.',
    'The central area is calm, flat and low-contrast, leaving room for overlaid white text.',
    'No text, no letters, no numbers, no buttons, no frames, no grid lines, no icons, no logo, no watermark.',
  ].join('\n')

  const img = await runWithLlmBudget(workspaceId, () => generateImage(prompt, { aspectRatio }))

  // 成本進「後台自用」那桶：這是我們自己在後台用的，混進客人那桶會讓每則成本虛高
  recordAiUsage(workspaceId, {
    testInputTokens: img.inputTokens,
    testOutputTokens: img.outputTokens,
    testInvocations: 1,
  }, getDb()).catch(e => console.error('[richmenu/generate-background] recordAiUsage error:', e))

  return { imageBase64: img.data, contentType: img.mimeType }
})
