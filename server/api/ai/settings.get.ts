import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { getAiSettings } from '~~/server/utils/ai-settings'
import { redactAiSettingsForRole } from '~~/server/utils/ai-settings-redact'

/**
 * GET /api/ai/settings
 * 回傳當前工作區的 AI 設定（不存在則回預設值）。
 *
 * ⛔ 依角色拿掉看不該看的欄位再回（`G-103`）：模型／回覆長度只給超管、token 上限只給改得動的人、
 *    LINE 通知名單只給收得到通知的角色（規則與理由見 ai-settings-redact.ts）。
 *    ⚠️ 管理員存檔的來回不受影響：少掉的三格 PUT 對非超管本來就丟掉、沿用現值（深合併）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, role, isSuperAdmin } = await requireWorkspaceAccess(event, 'viewer')
  return redactAiSettingsForRole(await getAiSettings(workspaceId), { role, isSuperAdmin })
})
