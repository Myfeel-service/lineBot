import type { Timestamp } from 'firebase-admin/firestore'
import type { WorkspaceAlertId, WorkspaceAlertItem, WorkspaceAlertsResponse } from '~~/shared/types/alerts'
import { getAiSettings } from '~~/server/utils/ai-settings'
import { cleanReason, humanizeHours } from '~~/server/utils/alert-format'
import { KNOWLEDGE_CHUNKS_COLLECTION } from '~~/server/utils/ai-knowledge-chunks'
import { KNOWLEDGE_SOURCES_COLLECTION } from '~~/server/utils/ai-knowledge-sources'
import { getQuotaAnswered } from '~~/server/utils/ai-usage'
import { findBrokenModuleRefs } from '~~/server/utils/broken-module-refs'
import { CLAIM_PUSH_MARK_ALERT_WINDOW_MS, readClaimPushMarkFailure } from '~~/server/utils/claim-push-health'
import { buildPlanView, getWorkspaceSubscription } from '~~/server/utils/billing'
import { getDb } from '~~/server/utils/firebase'
import { PAYMENT_ORDERS_COLLECTION } from '~~/server/utils/payment'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { derivePlanState } from '~~/shared/billing/plan-state'
import { HUMAN_STALE_HOURS } from '~~/shared/types/conversation-stats'

/**
 * GET /api/admin/alerts?workspaceId=...
 *
 * 工作區「目前異常」彙總：把散在各頁、不進去就看不到的持續性異常收成一份訊號，
 * 給右下角小幫手主動告知。設計原則同 setup-status：
 *
 *   1. 每個訊號各自 try/catch —— 單一查詢失敗只讓該項變 unknown，不會整支端點壞掉，
 *      也不會把「查不到」誤報成「沒問題」（這比誤報更危險：使用者會以為都好了）。
 *   2. 這裡只判定「有沒有」，不決定嚴重度與文案 —— 那些在前端註冊表，
 *      改文案不用動後端。
 *   3. 按角色只查看得到的東西：帳單類需要 admin，營運類需要 agent 以上。
 *      看不到的項目直接不回，前端註冊表也會依權限過濾，兩邊一致。
 */

/**
 * 掃描上限：這是彙總訊號不是報表，看到幾筆就講幾筆，超過不影響「有異常」的結論。
 *
 * 這支會被輪詢，所以每個查詢都刻意收窄成「只撈出問題的那幾筆」——健康的工作區
 * 查回來是 0 筆，成本趨近於零。不要為了省一個索引改成整批撈回來自己過濾：
 * 那會變成每次輪詢都讀幾百筆文件。
 */
const PROBLEM_SCAN_LIMIT = 20
const SESSION_SCAN_LIMIT = 200
/** 缺索引時的退路上限（見 knowledgeOutdated） */
const FALLBACK_SCAN_LIMIT = 300
const LLM_ERROR_SCAN_LIMIT = 50
/** llm_error 只看近 24 小時：Gemini 兩週前抖過一次不該一直掛紅燈 */
const LLM_ERROR_WINDOW_MS = 24 * 3600_000
/** 客人等真人超過此時數才算積壓（幾分鐘的等待是正常客服節奏，不是異常） */
const PENDING_WAIT_ALERT_HOURS = 1

type ProbeResult = { active: boolean; count?: number; detail?: string }

/** 把一次判定包成 active/clear；丟錯降級為 unknown（狀態未知，不等於沒問題） */
async function probe(id: WorkspaceAlertId, fn: () => Promise<ProbeResult>): Promise<WorkspaceAlertItem> {
  try {
    const r = await fn()
    return { id, state: r.active ? 'active' : 'clear', count: r.count, detail: r.detail }
  }
  catch (e) {
    console.warn(`[alerts] ${id} 檢查失敗:`, String((e as Error)?.message ?? e).slice(0, 160))
    return { id, state: 'unknown' }
  }
}

function tsToMs(raw: unknown): number {
  if (!raw) return 0
  const v = raw as Timestamp & { seconds?: number, _seconds?: number }
  if (typeof v.toMillis === 'function') return v.toMillis()
  const sec = v.seconds ?? v._seconds
  return typeof sec === 'number' ? sec * 1000 : 0
}

export default defineEventHandler(async (event): Promise<WorkspaceAlertsResponse> => {
  const { workspaceId, role } = await requireWorkspaceAccess(event, 'viewer')
  const wid = String(workspaceId || '').trim()
  if (!wid)
    throw createError({ statusCode: 400, statusMessage: 'workspaceId is required' })

  const db = getDb()
  const canSettings = role === 'owner' || role === 'admin'
  const canOperate = canSettings || role === 'agent'

  // AI 設定只讀一次，兩個 probe 共用。
  // 刻意不在這裡 await——一 await 就把後面所有查詢卡在它後面變成序列，
  // 整支端點多花一個來回。讀失敗回 null，用到的 probe 各自降級成 unknown
  // （不要因為讀不到設定就說「沒問題」）。
  const aiSettingsPromise = canOperate
    ? getAiSettings(wid, db).catch(() => null)
    : null

  const operateProbes: Array<Promise<WorkspaceAlertItem>> = canOperate
    ? [
        probe('knowledgeSyncFailed', async () => {
          // 兩個等值條件走自動索引合併；正常狀況回 0 筆
          const snap = await db.collection(KNOWLEDGE_SOURCES_COLLECTION)
            .where('workspaceId', '==', wid)
            .where('status', '==', 'failed')
            .select('name', 'url', 'failureReason')
            .limit(PROBLEM_SCAN_LIMIT)
            .get()
          if (snap.empty) return { active: false }
          // 帶上第一個失敗原因：只說「有 2 個失敗」等於叫使用者自己去猜是哪裡出問題
          const first = snap.docs[0]!.data() as Record<string, unknown>
          const name = String(first.name ?? first.url ?? '(未命名來源)')
          const reason = cleanReason(first.failureReason)
          return {
            active: true,
            count: snap.size,
            detail: reason ? `「${name}」：${reason}` : `「${name}」同步失敗`,
          }
        }),
        probe('knowledgeOutdated', async () => {
          // 快路徑：!= null 會排除「沒有這個欄位」的文件，正好就是「沒偵測到變動」的來源。
          // 需要 (workspaceId ASC, outdatedAt ASC) 複合索引，見 firestore.indexes.json。
          try {
            const snap = await db.collection(KNOWLEDGE_SOURCES_COLLECTION)
              .where('workspaceId', '==', wid)
              .where('outdatedAt', '!=', null)
              .select('name')
              .limit(PROBLEM_SCAN_LIMIT)
              .get()
            return snap.empty ? { active: false } : { active: true, count: snap.size }
          }
          catch (e) {
            // 索引還沒部署（新租戶、或索引檔尚未 deploy）就退回整批掃描。
            // 慢路徑會讀較多文件，但總比讓使用者看到一個永遠「檢查不到」的項目——
            // 索引一部署就自動走回快路徑，不必再改程式。
            if (!/FAILED_PRECONDITION|requires an index/i.test(String((e as Error)?.message ?? '')))
              throw e
            console.warn('[alerts] knowledgeOutdated 缺索引，改走全掃描；請部署 firestore.indexes.json')
            const snap = await db.collection(KNOWLEDGE_SOURCES_COLLECTION)
              .where('workspaceId', '==', wid)
              .select('outdatedAt')
              .limit(FALLBACK_SCAN_LIMIT)
              .get()
            const n = snap.docs.filter(d => (d.data() as Record<string, unknown>).outdatedAt).length
            return n ? { active: true, count: n } : { active: false }
          }
        }),
        probe('knowledgeIndexFailed', async () => {
          // count() 聚合查詢：兩個等值條件走自動索引合併，不必讀 doc
          const agg = await db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
            .where('workspaceId', '==', wid)
            .where('status', '==', 'failed')
            .count()
            .get()
          const n = agg.data().count
          return n ? { active: true, count: n } : { active: false }
        }),
        probe('anyTextBlocking', async () => {
          // 設定與規則同時查（先查設定再決定要不要查規則會多一個來回；
          // 這支規則查詢本來就只會回 0～1 筆）
          const [aiSettings, snap] = await Promise.all([
            aiSettingsPromise!,
            db.collection('autoReplies')
              .where('workspaceId', '==', wid)
              .where('matchType', '==', 'anyText')
              .limit(PROBLEM_SCAN_LIMIT)
              .get(),
          ])
          if (!aiSettings) throw new Error('ai settings unavailable')
          // AI 沒開的時候，「輸入任何內容」規則是正常的兜底回覆，不是異常
          if (aiSettings.enabled !== true) return { active: false }
          // isActive 未設視為啟用（與 normalizeAutoReplyRule 同一把尺）
          const active = snap.docs
            .map(d => d.data() as Record<string, unknown>)
            .filter(r => r?.isActive !== false)
          if (!active.length) return { active: false }
          const name = String(active[0]!.name ?? '(未命名規則)')
          return { active: true, count: active.length, detail: `規則「${name}」` }
        }),
        probe('llmError', async () => {
          // 走既有 composite index（workspaceId, aiMeta.lastHandoffReason, aiMeta.updatedAt DESC）
          const snap = await db.collection('conversations')
            .where('workspaceId', '==', wid)
            .where('aiMeta.lastHandoffReason', '==', 'llm_error')
            .orderBy('aiMeta.updatedAt', 'desc')
            .limit(LLM_ERROR_SCAN_LIMIT)
            .get()
          const cutoff = Date.now() - LLM_ERROR_WINDOW_MS
          const recent = snap.docs.filter((d) => {
            const meta = (d.data() as { aiMeta?: { updatedAt?: unknown } }).aiMeta
            return tsToMs(meta?.updatedAt) >= cutoff
          })
          return recent.length ? { active: true, count: recent.length } : { active: false }
        }),
        probe('humanBacklog', async () => {
          const sessions = db.collection('conversationSessions').where('workspaceId', '==', wid)
          // 先用 count 聚合探一下（每 1000 筆算一次讀取）。多數工作區這兩個數字是 0，
          // 就不必為了算等待時數把整批 session 文件撈回來——這支是會被輪詢的。
          const [pendingCount, humanCount] = await Promise.all([
            sessions.where('status', '==', 'pending_human').count().get(),
            sessions.where('status', '==', 'human_handling').count().get(),
          ])
          if (!pendingCount.data().count && !humanCount.data().count)
            return { active: false }

          const [pendingSnap, humanSnap] = await Promise.all([
            pendingCount.data().count
              ? sessions.where('status', '==', 'pending_human')
                  .select('handoffRequestedAt', 'lastActivityAt')
                  .limit(SESSION_SCAN_LIMIT)
                  .get()
              : null,
            humanCount.data().count
              ? sessions.where('status', '==', 'human_handling')
                  .select('humanLastRepliedAt', 'lastActivityAt')
                  .limit(SESSION_SCAN_LIMIT)
                  .get()
              : null,
          ])
          const now = Date.now()
          let waiting = 0
          let oldestH = 0
          for (const d of pendingSnap?.docs ?? []) {
            const s = d.data() as Record<string, unknown>
            const sinceMs = tsToMs(s.handoffRequestedAt) || tsToMs(s.lastActivityAt)
            if (!sinceMs) continue
            const h = (now - sinceMs) / 3600_000
            if (h >= PENDING_WAIT_ALERT_HOURS) {
              waiting++
              oldestH = Math.max(oldestH, h)
            }
          }
          // 「卡在真人處理中」沿用 cron 每日提醒的同一個門檻，兩邊數字才對得起來
          const stale = (humanSnap?.docs ?? []).filter((d) => {
            const s = d.data() as Record<string, unknown>
            const lastMs = tsToMs(s.humanLastRepliedAt) || tsToMs(s.lastActivityAt)
            return lastMs > 0 && now - lastMs >= HUMAN_STALE_HOURS * 3600_000
          }).length

          if (!waiting && !stale) return { active: false }
          const parts: string[] = []
          if (waiting) parts.push(`${waiting} 位客人在等（最久 ${humanizeHours(oldestH)}）`)
          if (stale) parts.push(`${stale} 條卡在「真人處理中」超過 ${HUMAN_STALE_HOURS} 小時`)
          return { active: true, count: waiting + stale, detail: parts.join('、') }
        }),
        probe('handoffNotifyMissing', async () => {
          const aiSettings = await aiSettingsPromise!
          if (!aiSettings) throw new Error('ai settings unavailable')
          // AI 沒開就不會有 AI 轉真人，這時沒設通知不算異常
          if (aiSettings.enabled !== true) return { active: false }
          const cfg = aiSettings.handoffNotify
          const off = !cfg?.enabled || !(cfg?.lineUserIds?.length)
          return off ? { active: true } : { active: false }
        }),
        probe('claimPushUnmarked', async () => {
          // 一次點讀（cronState 內每工作區一筆）。蓋章成功會自己清掉，所以有值就代表最近真的壞過。
          const st = await readClaimPushMarkFailure(db, wid)
          if (!st) return { active: false }
          if (Date.now() - st.failedAtMs > CLAIM_PUSH_MARK_ALERT_WINDOW_MS) return { active: false }
          return {
            active: true,
            count: st.count,
            detail: st.lastError ? `系統訊息：${cleanReason(st.lastError)}` : undefined,
          }
        }),
        probe('brokenModuleButton', async () => {
          // 靜態檢查，不是統計「誰按到了」：在客人踩到之前就報。
          // 結果有 5 分鐘快取，輪詢不會每次整批讀 flows + richmenus（見 broken-module-refs）
          const broken = await findBrokenModuleRefs(db, wid)
          if (!broken.length) return { active: false }
          const first = broken[0]!
          const where = first.sourceKind === 'richmenu' ? '選單' : '模組'
          const why = first.reason === 'missing' ? '模組已被刪除' : '模組已停用'
          return {
            active: true,
            count: broken.length,
            detail: `${where}「${first.sourceLabel}」的按鈕指向的${why}`,
          }
        }),
      ]
    : []

  // 帳單類：需要 admin。非 admin 直接不回這幾項（前端註冊表同樣依權限過濾）
  // 訂閱只讀一次，額度與扣款狀態共用（兩支各讀一次等於白花一半的查詢）
  const subPromise = canSettings ? getWorkspaceSubscription(wid, db) : null

  const billingProbes: Array<Promise<WorkspaceAlertItem>> = canSettings
    ? [
        probe('quotaExceeded', async () => {
          const sub = await subPromise!
          const plan = buildPlanView(sub)
          const answered = sub?.currentPeriodStart
            ? await getQuotaAnswered(wid, sub.currentPeriodStart, db)
            : 0
          const usage = derivePlanState(plan, answered)
          if (usage.state !== 'over') return { active: false }
          return {
            active: true,
            count: usage.used,
            detail: usage.limit ? `本期已用 ${usage.used} / ${usage.limit} 則` : undefined,
          }
        }),
        probe('paymentPastDue', async () => {
          const plan = buildPlanView(await subPromise!)
          if (plan?.status !== 'past_due') return { active: false }
          const reason = cleanReason(plan.lastChargeError)
          return { active: true, detail: reason || undefined }
        }),
        probe('invoiceFailed', async () => {
          const agg = await db.collection(PAYMENT_ORDERS_COLLECTION)
            .where('workspaceId', '==', wid)
            .where('invoiceStatus', '==', 'failed')
            .count()
            .get()
          const n = agg.data().count
          return n ? { active: true, count: n } : { active: false }
        }),
      ]
    : []

  const items = await Promise.all([...operateProbes, ...billingProbes])

  return { workspaceId: wid, items, checkedAt: Date.now() }
})
