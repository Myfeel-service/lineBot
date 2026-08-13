import { requireCapability } from '~~/server/utils/workspace-auth'
import { setAiSettings, getAiSettings } from '~~/server/utils/ai-settings'
import { writeAuditLog, diffChangedFields } from '~~/server/utils/audit-log'

/**
 * PUT /api/ai/settings
 * Body: AiSettingsDoc 的 partial（任何欄位可省略）
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid, isSuperAdmin } = await requireCapability(event, 'ai.settings.write')
  const body = { ...((await readBody(event)) ?? {}) }

  // 成本槓桿收歸平台：模型與回覆長度直接決定 token 成本，而計費按「則」算、
  // 成本由平台吸收——租戶有動機拉滿。UI 只對 super admin 顯示還不夠（直接打 API
  // 就繞過了），這裡把門檻落地：非 super admin 的請求一律沿用現值。
  if (!isSuperAdmin) {
    delete body.answerModel
    delete body.replyMaxLen
    delete body.embeddingModel
  }

  const before = await getAiSettings(workspaceId)
  const after = await setAiSettings(workspaceId, body)

  // 稽核（C-31 Phase 0）：AI 設定是「門檻最高的單點」——改了會立刻改變客人體驗，
  // 只記真的有變的欄位；沒變就不寫（免得每次存檔都留一筆噪音）
  const diff = diffChangedFields(before as any, after as any)
  if (diff.changedKeys.length) {
    await writeAuditLog({
      workspaceId,
      uid,
      actor: 'human',
      action: 'ai/settings.put',
      before: diff.before,
      after: diff.after,
    })
  }

  return after
})
