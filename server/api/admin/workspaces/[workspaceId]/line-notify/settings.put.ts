import { FieldValue } from 'firebase-admin/firestore'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { getDb } from '~~/server/utils/firebase'
import { AI_SETTINGS_COLLECTION, invalidateAiSettingsCache, normalizeAiSettings } from '~~/server/utils/ai-settings'
import { NOTIFY_TIMING_KEYS, pickNotifyTiming, readFreshAiSettings } from '~~/server/utils/line-notify-page'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * PUT /api/admin/workspaces/:workspaceId/line-notify/settings
 * body: 「什麼時候通知」那幾格（mode／slaRemindMinutes／digestHour／festivalTips／weeklyInsights／criticalAlertPush）
 *
 * 原本在「AI 設定」頁，2026-09-27 `D-103` 第 1 題拍板搬來「設定 → LINE 通知」：
 * 它管的是人跟手機，而且 AI 設定頁要開了 AI 功能才進得去——純真人客服的帳號永遠改不到。
 *
 * ⚠️ 只寫這幾格（merge），⛔ 不走 `setAiSettings` 的整份覆寫：同一時間有人把手機加進名單，
 *    整份覆寫會把剛加的人蓋掉。值一律過 normalizeAiSettings（夾範圍、missed_only 至少 5 分鐘）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'notify.manage')
  const body = (await readBody<Record<string, unknown>>(event)) ?? {}
  const picked: Record<string, unknown> = {}
  for (const k of NOTIFY_TIMING_KEYS) if (k in body) picked[k] = body[k]

  const db = getDb()
  const current = await readFreshAiSettings(workspaceId, db)
  const merged = normalizeAiSettings({ ...current, handoffNotify: { ...current.handoffNotify, ...picked } })
  const before = pickNotifyTiming(current.handoffNotify)
  const after = pickNotifyTiming(merged.handoffNotify)

  const changed = NOTIFY_TIMING_KEYS.filter(k => before[k] !== after[k])
  if (!changed.length) return { timing: after }

  await db.collection(AI_SETTINGS_COLLECTION).doc(workspaceId).set(
    { workspaceId, handoffNotify: after, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  )
  invalidateAiSettingsCache(workspaceId)

  // 稽核存成設定裡的真實層級（handoffNotify.xxx），「操作紀錄」才展得開、還原才知道改回哪一格
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'lineNotify.settings',
    before: { handoffNotify: Object.fromEntries(changed.map(k => [k, before[k]])) },
    after: { handoffNotify: Object.fromEntries(changed.map(k => [k, after[k]])) },
  })
  return { timing: after }
})
