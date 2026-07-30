/**
 * 帳號（workspace/OA）計費：讀訂閱、解析「則數額度」攔截規則。
 *
 * 方案目錄在 ~~/shared/billing/plans.ts、週期計算在 ~~/shared/billing/period.ts；
 * 這裡只負責「讀 Firestore 訂閱 + 決定額度上限」的 server 側邏輯。
 *
 * ⚠️ 兩個設計重點：
 *
 * 1. **每個帳號一律有方案、一律攔截。** 沒有 subscription 欄位 = 免費層（200 則）,
 *    不是「不攔截」。（早期為了保護既有租戶留的「無訂閱不攔截」後門已移除——那是個
 *    吃到飽漏洞,而且逼得所有額度邏輯都要多帶一個「可能沒訂閱」的狀態。）
 *    唯一的 fail-open 是 **Firestore 讀取失敗**：基礎設施出問題不該把付費帳號鎖在 200 則。
 *
 * 2. **週期在讀取時就地推算**（rollSubscriptionToCurrentPeriod）。每日排程只是把結果
 *    落地成資料,不是正確性的前提——排程沒跑,額度重置與到期降級照樣正確。
 *
 * 訂閱短暫快取（60s TTL）避免每則 webhook 都打 Firestore；快取的是**原始**訂閱,
 * 每次取用都重新推算週期,所以跨午夜不會拿到過期的一期。
 */
import type { Firestore } from 'firebase-admin/firestore'
import { getDb } from './firebase'
import type { WorkspaceDoc } from '~~/shared/types/organization'
import type { BillingPlan, BillingPlanId, WorkspaceSubscription } from '~~/shared/billing/plans'
import { DEFAULT_BILLING_PLAN_ID, effectiveAnsweredQuota, getBillingPlan } from '~~/shared/billing/plans'
import { newSubscription, rollSubscriptionToCurrentPeriod } from '~~/shared/billing/period'
import { resolveRecurringCharge } from '~~/shared/billing/recurring'
import type { PlanView } from '~~/shared/billing/plan-state'
import type { QuotaExceedStrategy } from '~~/shared/types/ai-knowledge'
import { taipeiDate } from '~~/shared/time'

const TTL_MS = 60 * 1000

/** 快取原始訂閱；`sub: null` = workspace 沒掛訂閱（視為免費層）。讀取失敗**不進快取**。 */
const subCache = new Map<string, { sub: WorkspaceSubscription | null; expiresAt: number }>()

/** 清掉訂閱快取（開通／改方案／續期後呼叫，讓額度攔截立即生效）。 */
export function invalidateWorkspaceSubscriptionCache(workspaceId?: string) {
  if (workspaceId) subCache.delete(String(workspaceId).trim())
  else subCache.clear()
}

/**
 * 新建帳號（OA）的預設訂閱：免費層,錨定日 = 建立當天。
 * 之後每個月的同一天補回免費額度（不是每月 1 號）。
 */
export function defaultFreeSubscription(today: string = taipeiDate()): WorkspaceSubscription {
  return newSubscription(DEFAULT_BILLING_PLAN_ID, today)
}

/**
 * 訂閱實際生效的方案與額度。
 * 已解約（canceled）等同回到免費層——連同業務特批的 quotaOverride 一起失效。
 */
export function effectivePlanOf(sub: WorkspaceSubscription): { plan: BillingPlan; quota: number | null } {
  const canceled = sub.status === 'canceled'
  const plan = getBillingPlan(canceled ? DEFAULT_BILLING_PLAN_ID : sub.planId)
  return { plan, quota: effectiveAnsweredQuota(plan, canceled ? null : sub.quotaOverride) }
}

/** 由訂閱組出「對前端顯示用」的方案視圖。 */
export function buildPlanView(sub: WorkspaceSubscription | null): PlanView | null {
  if (!sub) return null
  const { plan, quota } = effectivePlanOf(sub)
  const next = resolveRecurringCharge(sub)
  return {
    id: plan.id,
    name: plan.name,
    answeredQuota: quota,
    overagePerReply: plan.overagePerReply,
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    status: sub.status,
    autoRenew: sub.autoRenew === true,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd === true,
    // 只回布林值,Token 不外洩到前端。
    // 只看 PAYUNi 約定卡:藍新定期定額程式已移除,而它從未真正開通過（recurringEnabled 一律
    // false + 金鑰未設）→ 沒有任何帳號真的有藍新委託。若真有 periodNo 的歷史資料，
    // 這裡回 false 才對——取消入口已經沒有藍新那條路可走，顯示按鈕只會讓客戶按到報錯。
    hasMandate: Boolean(sub.payuniCardToken),
    cardLast4: sub.payuniCardLast4 ?? null,
    // 只在寬限期（等扣款）時才有意義；續扣成功時 settlePaidOrder 已清掉這個欄位。
    lastChargeError: sub.status === 'past_due' ? (sub.lastChargeError ?? null) : null,
    // 下期方案／折抵／實扣金額：與續扣排程共用同一支純函式,畫面說扣多少就真的扣多少。
    pendingPlanId: next.planId === sub.planId ? null : next.planId,
    pendingPlanName: next.planId === sub.planId ? null : getBillingPlan(next.planId).name,
    creditBalance: next.creditRemaining + next.creditUsed,
    nextChargeAmount: next.price == null ? null : next.amount,
  }
}

/** 讀原始訂閱（含快取）。回 undefined = Firestore 讀取失敗（與「沒掛訂閱」區分開）。 */
async function readRawSubscription(
  workspaceId: string,
  db: Firestore,
): Promise<WorkspaceSubscription | null | undefined> {
  const now = Date.now()
  const cached = subCache.get(workspaceId)
  if (cached && cached.expiresAt > now) return cached.sub

  try {
    const snap = await db.collection('workspaces').doc(workspaceId).get()
    const sub = snap.exists ? ((snap.data() as WorkspaceDoc).subscription ?? null) : null
    subCache.set(workspaceId, { sub, expiresAt: now + TTL_MS })
    return sub
  }
  catch (e) {
    console.warn('[billing] read workspace subscription failed:', e)
    return undefined // 不進快取,下次呼叫重試
  }
}

/**
 * 讀取帳號訂閱,並推進到「包含今天的那一期」。
 *
 * - 沒掛訂閱 → 合成一份免費層訂閱（錨定日 = 今天）,**不是**回 null。
 * - 回 null 只代表 **Firestore 讀取失敗** → 呼叫端 fail-open,別把付費帳號鎖在 200 則。
 */
export async function getWorkspaceSubscription(
  workspaceId: string,
  db: Firestore = getDb(),
  today: string = taipeiDate(),
): Promise<WorkspaceSubscription | null> {
  const wid = String(workspaceId || '').trim()
  if (!wid) return null

  const raw = await readRawSubscription(wid, db)
  if (raw === undefined) return null

  return rollSubscriptionToCurrentPeriod(raw ?? defaultFreeSubscription(today), today).sub
}

export interface AnsweredQuotaResolution {
  /** 本期則數上限；null = 不設上限（內部方案 / enterprise 客製未設額度 / 訂閱讀取失敗）。 */
  quota: number | null
  /** 生效方案；null = 訂閱讀取失敗。 */
  planId: BillingPlanId | null
  /** 內部 / 測試方案：真無限,連 token 護欄都跳過。 */
  internal: boolean
  /** 額度計數桶的鍵（本期起日 YYYY-MM-DD）；訂閱讀取失敗時為 null。 */
  periodStart: string | null
}

/** 解析某帳號「本期則數額度」的攔截規則。 */
export async function resolveAnsweredQuota(
  workspaceId: string,
  db: Firestore = getDb(),
  today: string = taipeiDate(),
): Promise<AnsweredQuotaResolution> {
  const sub = await getWorkspaceSubscription(workspaceId, db, today)
  // 讀不到訂閱（Firestore 故障）→ 不擋則數,交給 token 護欄當煞車
  if (!sub) return { quota: null, planId: null, internal: false, periodStart: null }

  const { plan, quota } = effectivePlanOf(sub)
  const internal = plan.internal === true

  // 不變式：**quota 與 periodStart 必須同進同出**。沒有週期就沒有計數桶可讀,
  // 這時若還回報一個則數上限,呼叫端會拿「已用 0 則」去比對 → 靜默變成吃到飽。
  // 正常情況推算週期後 currentPeriodStart 必定存在,此分支純防呆。
  if (!sub.currentPeriodStart) {
    return { quota: null, planId: plan.id, internal, periodStart: null }
  }

  return { quota, planId: plan.id, internal, periodStart: sub.currentPeriodStart }
}

/** quota 護欄的處置：放行 / 轉真人 / 降級模型。 */
export type QuotaAction = 'allow' | 'handoff' | 'downgrade'

/**
 * 決定本次呼叫的 quota 處置（純函式，便於測試）。
 *
 * - **內部 / 測試方案**：完全不擋（真無限）。
 * - **有則數額度**：只看則數。則數本身即封住成本（專業 10,000 則 ≈ 50M tokens）,
 *   不再疊 token 護欄——否則付費帳號會在遠低於所購則數處被固定的 token cap 提早切斷
 *   （1M token ≈ 200 則,那是照免費層校準的舊機制）。
 * - **無則數上限**（enterprise 客製未設額度 / 訂閱讀取失敗）：token 護欄是唯一煞車。
 */
export function resolveQuotaAction(
  billing: AnsweredQuotaResolution,
  usage: { answered: number; tokens: number },
  tokenCap: number,
  onExceed: QuotaExceedStrategy,
): QuotaAction {
  if (billing.internal) return 'allow'

  if (billing.quota != null) {
    return usage.answered >= billing.quota ? 'handoff' : 'allow'
  }

  if (tokenCap > 0 && usage.tokens >= tokenCap) {
    return onExceed === 'handoff_all' ? 'handoff' : 'downgrade'
  }
  return 'allow'
}
