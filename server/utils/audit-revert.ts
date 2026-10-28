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
import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import { auditActionLabel } from '~~/shared/types/audit'
import { AUDIT_LOGS_COLLECTION, writeAuditLog } from './audit-log'
import { getAiSettings, setAiSettings } from './ai-settings'
import { invalidateScriptsCache, SCRIPTS_COLLECTION } from './ai-scripts'
import { invalidateScriptHealthCache } from './script-health'
import {
  changedSinceError,
  goneError,
  matchesRecorded,
  type AuditRecordForRevert,
  type RevertCommit,
  type RevertCtx,
  type RevertHandler,
  type RevertPlan,
  type RevertStage,
} from './audit-revert-common'
import { FIELD_REVERT_HANDLERS } from './audit-revert-fields'
import { CREATE_REVERT_HANDLERS } from './audit-revert-creates'

export type { AuditRecordForRevert, RevertPlan } from './audit-revert-common'

/** 舊紀錄沒有 lossy 旗標，只能認淨化留下的痕跡（遮罩與截斷標記） */
function looksTruncated(v: unknown): boolean {
  if (typeof v === 'string') return v === '••••' || v.includes('…(截斷,原')
  if (Array.isArray(v)) return v.some(looksTruncated)
  if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).some(looksTruncated)
  return false
}

// ── 最早做的兩種：自動回應上下架、AI 設定（2026-09-16）──────────────

const scriptSetEnabled: RevertHandler = {
  plan(row) {
    if (!row.targetId)
      return { ok: false, reason: '這筆是舊紀錄，沒有記下動到哪一條流程，所以還原不了——請到自動回應頁自己改回來。' }
    if (typeof row.before?.enabled !== 'boolean')
      return { ok: false, reason: '這筆沒有記下原本是開還是關，還原不了。' }
    return { ok: true, capability: 'scripts.write', what: `把那條流程改回${row.before.enabled ? '啟用' : '停用'}` }
  },
  async check(row, ctx) {
    const ref = ctx.db.collection(SCRIPTS_COLLECTION).doc(String(row.targetId))
    const snap = await ref.get()
    if (!snap.exists || snap.get('workspaceId') !== ctx.workspaceId) throw goneError('那條流程')
    // 這段期間又被改過 → 不動手（拿舊判斷覆蓋新世界＝安靜地蓋掉別人的修改）
    const current = snap.get('enabled') === true
    if (current !== (row.after?.enabled === true)) throw changedSinceError('這條流程')

    return async () => {
      const target = row.before?.enabled === true
      await ref.update({ enabled: target, updatedAt: FieldValue.serverTimestamp() })
      // ⛔ 送訊息熱路徑的 60 秒快取也要清，否則「還原了」之後客人還會被舊狀態接走一分鐘
      invalidateScriptsCache(ctx.workspaceId)
      invalidateScriptHealthCache(ctx.workspaceId)
      return { message: `已經改回${target ? '啟用' : '停用'}。`, before: { enabled: current }, after: { enabled: target } }
    }
  },
}

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
  // 2026-09-29（`D-109`）：小幫手第二批會改的兩格（單純的數字，寫回去不會連帶別的東西）。
  // ⛔ 語氣範本改的 systemPrompt **刻意不加**：它是這張白名單測試裡的反例（整段指示最長四千字、
  //    紀錄常被截斷），要改回去請到 AI 設定頁
  'handbackIdleMinutes',
  'humanSessionMaxIdleHours',
])

const aiSettings: RevertHandler = {
  plan(row) {
    const keys = Object.keys(row.before ?? {})
    if (!keys.length)
      return { ok: false, reason: '這筆沒有記下改之前的值，還原不了。' }
    const bad = keys.filter(k => !REVERTIBLE_SETTING_KEYS.has(k))
    if (bad.length)
      return { ok: false, reason: `這筆動到的設定（${bad.join('、')}）目前不支援一鍵還原，請到 AI 設定頁改回來。` }
    // 通知名單（誰會收到）不給一鍵還原（`C-270`）：舊紀錄裡的名單可能是從客人清單挑的人，
    // 寫回去就把客人塞回名單；名單現在只收綁好的成員，要到「設定 → LINE 通知」改
    const notifyBefore = (row.before as Record<string, any> | undefined)?.handoffNotify
    if (notifyBefore && typeof notifyBefore === 'object'
      && ['lineUserIds', 'displayNames', 'enabled'].some(k => k in notifyBefore)) {
      return { ok: false, reason: '這筆動到「誰會收到 LINE 通知」，名單不給一鍵還原——請到「設定 → LINE 通知」直接開關那幾位。' }
    }
    // `D-143`：「出大事」從全帳號一個開關改成每個人自己勾，這個開關已經不從設定寫了（寫回去也不會生效），
    // ⛔ 不可以回「還原了」卻什麼都沒變
    if (notifyBefore && typeof notifyBefore === 'object'
      && ['criticalAlertPush', 'optOut'].some(k => k in notifyBefore)) {
      return { ok: false, reason: '「出大事」現在改成每個人自己勾，這筆沒辦法一鍵還原——請到「設定 → LINE 通知」那張表的「出大事」那一欄勾回來。' }
    }
    return { ok: true, capability: 'ai.settings.write', what: '把這幾項設定改回原本的值' }
  },
  async check(row, ctx) {
    // 把「改之前」那幾個欄位寫回去
    const before = row.before ?? {}
    const after = row.after ?? {}
    const settings = await getAiSettings(ctx.workspaceId, ctx.db) as unknown as Record<string, unknown>
    if (Object.keys(after).some(k => !matchesRecorded(settings[k], after[k]))) throw changedSinceError('這些設定')

    return async () => {
      await setAiSettings(ctx.workspaceId, before as never, ctx.db)
      return { message: '已經把那幾項設定改回原本的值。', before: after, after: before }
    }
  },
}

/** `lineNotify.settings`（`C-270`）：「設定 → LINE 通知」存的是同一份 AI 設定的 handoffNotify 那幾格 */
const isAiSettingsAction = (action: string) =>
  action === 'ai/settings.put' || action === 'lineNotify.settings' || action.startsWith('agent-op/ai-settings-')

/**
 * 動作代號 → 怎麼還原：一種動作一個處理器，各自守原本那個動作的護欄（2026-10-28 `D-156`）。
 * ①改一個值（`audit-revert-fields.ts`）②新增的東西、沒被用到才拿掉（`audit-revert-creates.ts`）
 * ③最早那兩種（上面）。
 */
const REVERT_HANDLERS: Record<string, RevertHandler> = {
  ...FIELD_REVERT_HANDLERS,
  ...CREATE_REVERT_HANDLERS,
  'agent-op/script-set-enabled': scriptSetEnabled,
}

function handlerFor(action: string): RevertHandler | undefined {
  return REVERT_HANDLERS[action] ?? (isAiSettingsAction(action) ? aiSettings : undefined)
}

/** 這筆能不能還原？不能的話回一句講得出原因的話（會直接顯示給人看） */
export function planRevert(row: AuditRecordForRevert): RevertPlan {
  const label = auditActionLabel(row.action)

  // ⛔ 被砍過的紀錄不能還原：寫回去會少東西，而人會以為完整還原了。
  // ⛔ `after` 也要看：判斷用 before、比對現值卻用 after，那種「之前很短、之後被截斷」
  //    的舊紀錄會**給出一顆永遠按不成功的還原鈕**——按下去回「這段期間這些設定又被改過了」，
  //    而根本沒有人改過，使用者會跑去找一個不存在的併發修改。
  if (row.lossy || looksTruncated(row.before) || looksTruncated(row.after)) {
    return {
      ok: false,
      reason: '這筆紀錄存的時候有內容被截斷或遮罩（值太長、項目太多、或含憑證），'
        + '還原會少東西，所以不給還原——請到對應的設定頁自己改回來。',
    }
  }

  const handler = handlerFor(row.action)
  if (handler) return handler.plan(row)

  // 小幫手改自動回應的內容（`D-109`）：紀錄只記了改的那一格（關鍵字／回覆字），沒存整份流程，
  // 寫回去要整份送回——⛔ 不給一鍵還原，講清楚去哪裡改（不要落到下面那句「它不是改一個值」，那句是錯的歸因）
  if (row.action === 'agent-op/script-update-keyword' || row.action === 'agent-op/script-update-reply')
    return { ok: false, reason: '這筆改的是自動回應的內容，紀錄裡只有改之前的那一格，沒辦法一鍵還原——請到「自動回應」頁照「改之前」那一欄改回來。' }

  // AI 發現的新標籤（2026-10-28）：合併與忽略在標籤頁本來就有收回的按鈕，⛔ 不要回「沒辦法還原」把人擋在這裡
  if (row.action === 'tagDiscovery.merge')
    return { ok: false, reason: '這筆要收回，請到「標籤」頁展開「先前的建議與決定」，按這一條的「解除合併」。' }
  if (row.action === 'tagDiscovery.dismiss')
    return { ok: false, reason: '這筆要收回，請到「標籤」頁展開「先前的建議與決定」，按這一條的「取消忽略」。' }

  // 重試學習、重新抓資料這類：做了就是做了，沒有「還原」這回事
  return { ok: false, reason: `「${label}」這種動作沒有辦法還原（它不是把某個值改成另一個值）。` }
}

/**
 * 這筆已經被還原過了嗎（`D-156`）：回傳那筆「還原了…」紀錄的 id，沒有就 null。
 * 查的是 `revertOf` 單一欄位等號——Firestore 自動有索引，⛔ 不用部署。
 * ⚠️ 10-28 以前的還原紀錄沒有這一格（只寫在備註），查不到；那之前 MYFEEL 一筆還原都沒有。
 */
export async function findRevertOf(db: Firestore, workspaceId: string, id: string): Promise<string | null> {
  const snap = await db.collection(AUDIT_LOGS_COLLECTION).where('revertOf', '==', id).limit(5).get()
  return snap.docs.find(d => d.get('workspaceId') === workspaceId)?.id ?? null
}

/** 清單那一頁裡哪幾筆已經還原過（Firestore 的 `in` 一次最多 30 個） */
export async function revertedIdsAmong(db: Firestore, workspaceId: string, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30))
  const snaps = await Promise.all(chunks.map(c => db.collection(AUDIT_LOGS_COLLECTION).where('revertOf', 'in', c).get()))
  for (const snap of snaps) {
    for (const d of snap.docs) {
      if (d.get('workspaceId') === workspaceId) out.add(String(d.get('revertOf')))
    }
  }
  return out
}

async function prepareRevert(row: AuditRecordForRevert, ctx: RevertCtx, stage: RevertStage): Promise<RevertCommit> {
  const plan = planRevert(row)
  if (!plan.ok) throw createError({ statusCode: 400, statusMessage: plan.reason })
  // planRevert 說可以＝一定有處理器（說可以的只有處理器自己的 plan）
  return handlerFor(row.action)!.check(row, ctx, stage)
}

/**
 * 只檢查、不寫入：清單每一列（`list`）、按下「還原」那一刻（`confirm`）。擋得下來一律 throw。
 * ⛔ 這支拿到「動手」那一步也不會呼叫它——寫入只可能發生在 applyRevert。
 */
export async function checkRevert(row: AuditRecordForRevert, ctx: RevertCtx, stage: 'list' | 'confirm'): Promise<void> {
  await prepareRevert(row, ctx, stage)
}

/** 真的還原。回傳一句白話結果；失敗一律 throw（訊息是給人看的） */
export async function applyRevert(row: AuditRecordForRevert, ctx: RevertCtx): Promise<string> {
  const commit = await prepareRevert(row, ctx, 'apply')
  const out = await commit()
  // 還原了哪一筆只在這裡記（`revertOf`：之後清單就不再給這一筆按鈕）
  await writeAuditLog({
    workspaceId: ctx.workspaceId,
    uid: ctx.uid,
    actor: 'human',
    action: 'audit/revert',
    ...(row.targetId ? { targetId: row.targetId } : {}),
    revertOf: row.id,
    before: out.before,
    after: out.after,
    note: `還原了「${auditActionLabel(row.action)}」（原紀錄 ${row.id}）`,
  }, ctx.db)
  return out.message
}
