import { requireCapability } from '~~/server/utils/workspace-auth'
import { getAiSettings } from '~~/server/utils/ai-settings'
import { redactAiSettingsForRole } from '~~/server/utils/ai-settings-redact'
import { birthdayStats } from '~~/server/utils/birthday-tag'
import { getDb } from '~~/server/utils/firebase'

/**
 * GET /api/ai/settings
 * 回傳當前工作區的 AI 設定（不存在則回預設值）。
 *
 * ⛔ 依角色拿掉看不該看的欄位再回（`G-103`）：模型／回覆長度只給超管、token 上限只給改得動的人、
 *    LINE 通知名單只給收得到通知的角色（規則與理由見 ai-settings-redact.ts）。
 *    ⚠️ 管理員存檔的來回不受影響：少掉的三格 PUT 對非超管本來就丟掉、沿用現值（深合併）。
 *
 * `?part=birthday`（`C-57`）：「好友」頁「生日」那個框的數字——每個月幾位留了生日、這個月幾位。
 * ⚠️ 借這支路由不另開一支：多開一個 API 路由會讓不相干的 `$fetch` 型別推導爆掉（TS2589，2026-10-29 起）。
 *    12 次 count()，一次約 12 筆讀取費。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, role, isSuperAdmin } = await requireCapability(event, 'ai.read')
  if (getQuery(event).part === 'birthday') return birthdayStats(getDb(), workspaceId)
  return redactAiSettingsForRole(await getAiSettings(workspaceId), { role, isSuperAdmin })
})
