/**
 * 「還原這一筆」（`C-31` Phase 2 收尾，2026-09-16）。
 *
 * 為什麼要有：小幫手開始代人動手之後，改錯的第一時間需求是**收回去**，
 * 而不是「打開設定頁、想起來原本是什麼、手動改回來」。
 * 稽核從一開始就存了「改之前是什麼」，這支只是把那份資料真的用起來。
 *
 * 紀律：
 * - ⛔ **不是每一筆都還原得了，而且要說得出為什麼**：舊紀錄沒有存「動到哪一份文件」、
 *   或那個動作本質上不可逆（重試學習、重抓資料），一律回一句人看得懂的理由。
 * - ⛔ **這段期間又被改過就不還原**：現值必須還等於當時的「改之後」，
 *   否則就是拿舊世界的判斷去覆蓋新世界（這個 repo 出過事的形狀）。
 * - ⛔ **還原本身也是一次操作**：它會再寫一筆稽核，⛔不刪、不改原本那一筆——
 *   能被改寫的紀錄就不叫紀錄。
 */
import type { Firestore } from 'firebase-admin/firestore'
import { FieldValue } from 'firebase-admin/firestore'
import type { Capability } from '~~/shared/permissions'
import { auditActionLabel } from '~~/shared/types/audit'
import { writeAuditLog } from './audit-log'
import { getAiSettings, setAiSettings } from './ai-settings'
import { SCRIPTS_COLLECTION } from './ai-scripts'
import { invalidateScriptHealthCache } from './script-health'

/** 一筆稽核紀錄裡，還原用得到的部分 */
export interface AuditRecordForRevert {
  id: string
  action: string
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  targetId?: string
}

export type RevertPlan =
  | { ok: true, capability: Capability, what: string }
  | { ok: false, reason: string }

/**
 * 可以還原的「AI 設定」欄位白名單。
 * ⛔ 白名單而不是黑名單：設定會長新欄位，漏擋一個就可能把沒想過的東西寫回去。
 */
const REVERTIBLE_SETTING_KEYS = new Set([
  'serviceHours',
  'handoffNotify',
  'sensitiveTopics',
  'replyMode',
  'enabled',
  'confidenceThreshold',
  'groundingThreshold',
  'replyMaxLen',
  'shopUrl',
  'disambiguation',
  'imageAnswer',
])

/** 這筆能不能還原？不能的話回一句講得出原因的話（會直接顯示給人看） */
export function planRevert(row: AuditRecordForRevert): RevertPlan {
  const label = auditActionLabel(row.action)

  if (row.action === 'agent-op/script-set-enabled') {
    if (!row.targetId)
      return { ok: false, reason: '這筆是舊紀錄，沒有記下動到哪一條流程，所以還原不了——請到自動回應頁自己改回來。' }
    if (typeof row.before?.enabled !== 'boolean')
      return { ok: false, reason: '這筆沒有記下原本是開還是關，還原不了。' }
    return { ok: true, capability: 'scripts.write', what: `把那條流程改回${row.before.enabled ? '啟用' : '停用'}` }
  }

  const isSettings = row.action === 'ai/settings.put' || row.action.startsWith('agent-op/ai-settings-')
  if (isSettings) {
    const keys = Object.keys(row.before ?? {})
    if (!keys.length)
      return { ok: false, reason: '這筆沒有記下改之前的值，還原不了。' }
    const bad = keys.filter(k => !REVERTIBLE_SETTING_KEYS.has(k))
    if (bad.length)
      return { ok: false, reason: `這筆動到的設定（${bad.join('、')}）目前不支援一鍵還原，請到 AI 設定頁改回來。` }
    return { ok: true, capability: 'ai.settings.write', what: '把這幾項設定改回原本的值' }
  }

  // 重試學習、重新抓資料這類：做了就是做了，沒有「還原」這回事
  return { ok: false, reason: `「${label}」這種動作沒有辦法還原（它不是把某個值改成另一個值）。` }
}

/** 真的還原。回傳一句白話結果；失敗一律 throw（訊息是給人看的） */
export async function applyRevert(
  row: AuditRecordForRevert,
  ctx: { db: Firestore, workspaceId: string, uid: string },
): Promise<string> {
  const plan = planRevert(row)
  if (!plan.ok) throw createError({ statusCode: 400, statusMessage: plan.reason })

  if (row.action === 'agent-op/script-set-enabled') {
    const ref = ctx.db.collection(SCRIPTS_COLLECTION).doc(String(row.targetId))
    const snap = await ref.get()
    if (!snap.exists) throw createError({ statusCode: 404, statusMessage: '那條流程已經不在了，沒有東西可以還原。' })
    if (snap.get('workspaceId') !== ctx.workspaceId)
      throw createError({ statusCode: 403, statusMessage: '這筆紀錄不屬於這個官方帳號。' })

    // 這段期間又被改過 → 不動手（拿舊判斷覆蓋新世界＝安靜地蓋掉別人的修改）
    const current = snap.get('enabled') === true
    if (current !== (row.after?.enabled === true)) {
      throw createError({
        statusCode: 409,
        statusMessage: '這段期間這條流程又被改過了，所以我沒有還原。請直接到自動回應頁確認現在的狀態。',
      })
    }

    const target = row.before?.enabled === true
    await ref.update({ enabled: target, updatedAt: FieldValue.serverTimestamp() })
    invalidateScriptHealthCache(ctx.workspaceId)
    await writeAuditLog({
      workspaceId: ctx.workspaceId,
      uid: ctx.uid,
      actor: 'human',
      action: 'audit/revert',
      targetId: row.targetId,
      before: { enabled: current },
      after: { enabled: target },
      note: `還原了「${auditActionLabel(row.action)}」（原紀錄 ${row.id}）`,
    }, ctx.db)
    return `已經改回${target ? '啟用' : '停用'}。`
  }

  // AI 設定類：把「改之前」那幾個欄位寫回去
  const before = row.before ?? {}
  const after = row.after ?? {}
  const settings = await getAiSettings(ctx.workspaceId, ctx.db) as unknown as Record<string, unknown>

  const changedSince = Object.keys(after).filter(k => JSON.stringify(settings[k] ?? null) !== JSON.stringify(after[k] ?? null))
  if (changedSince.length) {
    throw createError({
      statusCode: 409,
      statusMessage: '這段期間這些設定又被改過了，所以我沒有還原（避免蓋掉別人後來的修改）。請到 AI 設定頁確認現在的值。',
    })
  }

  await setAiSettings(ctx.workspaceId, before as never, ctx.db)
  await writeAuditLog({
    workspaceId: ctx.workspaceId,
    uid: ctx.uid,
    actor: 'human',
    action: 'audit/revert',
    before: after,
    after: before,
    note: `還原了「${auditActionLabel(row.action)}」（原紀錄 ${row.id}）`,
  }, ctx.db)
  return '已經把那幾項設定改回原本的值。'
}
