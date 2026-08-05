import { requireCapability } from '~~/server/utils/workspace-auth'
import { setAiSettings } from '~~/server/utils/ai-settings'

/**
 * PUT /api/ai/settings
 * Body: AiSettingsDoc 的 partial（任何欄位可省略）
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, isSuperAdmin } = await requireCapability(event, 'ai.settings.write')
  const body = { ...((await readBody(event)) ?? {}) }

  // 成本槓桿收歸平台：模型與回覆長度直接決定 token 成本，而計費按「則」算、
  // 成本由平台吸收——租戶有動機拉滿。UI 只對 super admin 顯示還不夠（直接打 API
  // 就繞過了），這裡把門檻落地：非 super admin 的請求一律沿用現值。
  if (!isSuperAdmin) {
    delete body.answerModel
    delete body.replyMaxLen
    delete body.embeddingModel
  }

  return setAiSettings(workspaceId, body)
})
