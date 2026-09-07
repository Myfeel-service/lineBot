/**
 * 知識量額度：方案的「AI 知識量 X 條」上限（`BillingPlan.knowledgeChunks`）。
 *
 * 2026-09-07 `D-69` 拍板④：知識庫的限制從「幾份資料」改成「幾條」——份數擋不住量
 * （十份併一個 PDF 就是 1 份），而且會誤傷學習迴圈（手寫一張卡、採用一則 AI 建議，
 * 各自都會生一個 manual 來源）。條數對齊價值，也只有一種數法。
 *
 * ⚠️ **檢查放在「端點前置」而不是逐卡檢查**（比照 assertMaintenanceBudget）：
 * 一次匯入最多 151 張卡，逐張跑 count() 聚合就是 151 次讀取——這正是 2026-08 讀取費
 * 暴衝的成因。這裡一個請求只數一次，再加 60 秒快取。
 *
 * 代價要講明白：併發請求之間會有時間差，極端狀況可能超收幾張；這是產品層的方案上限，
 * 不是資安邊界，超收幾張沒有實害，讀取費暴衝有。
 */
import type { Firestore } from 'firebase-admin/firestore'
import { getDb } from './firebase'
import { getWorkspacePlan } from './billing'
import { KNOWLEDGE_CHUNKS_COLLECTION } from './ai-knowledge-chunks'
import { planLimitMessage } from '~~/shared/billing/plans'

const TTL_MS = 60 * 1000

/** 每個 workspace 目前的知識卡張數（不含回收桶）。 */
const countCache = new Map<string, { count: number; expiresAt: number }>()

/** 建卡／刪卡／還原後呼叫，讓下一次檢查看到最新張數。 */
export function invalidateKnowledgeChunkCount(workspaceId?: string) {
  if (workspaceId) countCache.delete(String(workspaceId).trim())
  else countCache.clear()
}

/**
 * 數這個帳號現有幾張知識卡（**不含回收桶**）。
 *
 * ⛔ 判「已回收」只能用 `isDeleted` / `deletedAt`，不能用 `status === 'disabled'`——
 * disabled 同時代表「店家手動停用」與「到期自動下架」，那兩種卡還在、要算進總數。
 *
 * ⛔ 為什麼用兩段 count() 相減而不是 `where('isDeleted','==',false)`：
 * 舊資料沒有 `isDeleted` 欄位，等值查詢會整批漏掉它們（同 countSourceChunks 的做法）。
 */
export async function countWorkspaceChunks(
  workspaceId: string,
  db: Firestore = getDb(),
): Promise<number> {
  const wid = String(workspaceId || '').trim()
  const cached = countCache.get(wid)
  if (cached && cached.expiresAt > Date.now()) return cached.count

  const base = db.collection(KNOWLEDGE_CHUNKS_COLLECTION).where('workspaceId', '==', wid)
  const [allAgg, deletedAgg] = await Promise.all([
    base.count().get(),
    base.where('isDeleted', '==', true).count().get(),
  ])
  const count = Math.max(0, allAgg.data().count - deletedAgg.data().count)
  countCache.set(wid, { count, expiresAt: Date.now() + TTL_MS })
  return count
}

/** 本地把快取往上加，省掉「剛建完又重數一次」的聚合查詢。 */
export function bumpKnowledgeChunkCount(workspaceId: string, delta: number) {
  const wid = String(workspaceId || '').trim()
  const cached = countCache.get(wid)
  if (cached) cached.count = Math.max(0, cached.count + delta)
}

export interface KnowledgeChunkQuotaStatus {
  used: number
  /** null = 這個方案不限張數（企業／內部）。 */
  limit: number | null
  planName: string
}

/** 目前用量與上限（給畫面顯示用；也是 assert 的資料來源）。 */
export async function getKnowledgeChunkQuota(
  workspaceId: string,
  db: Firestore = getDb(),
): Promise<KnowledgeChunkQuotaStatus | null> {
  const plan = await getWorkspacePlan(workspaceId, db)
  if (!plan) return null // 訂閱讀取失敗 → 呼叫端 fail-open
  if (plan.knowledgeChunks == null) return { used: 0, limit: null, planName: plan.name }
  return { used: await countWorkspaceChunks(workspaceId, db), limit: plan.knowledgeChunks, planName: plan.name }
}

/**
 * 要新增 `adding` 張卡之前的守門：超過方案上限就丟 403。
 *
 * 為什麼是 403 不是 429：429 在下游有「暫時性額度阻擋、不耗重試次數」的語意
 * （見 ai-knowledge-chunks.ts 的 isBudgetBlock），但「知識量滿了」不是下個月會自己好的事，
 * 排程拿它當暫時性錯誤重試只會白跑。
 *
 * ⚠️ 已知取捨：匯入逾時後**重按**會被自己的額度擋到——重按其實是覆寫同一批 doc
 * （決定性 chunkId）、不會真的增加張數，但這裡只看「現有 + 這批」。訊息把實際數字
 * 都印出來，客人看得懂發生什麼事；要根治得先把 importId 記到卡上才數得準。
 */
export async function assertKnowledgeChunkQuota(
  workspaceId: string,
  adding: number,
  db: Firestore = getDb(),
): Promise<void> {
  if (adding <= 0) return
  const status = await getKnowledgeChunkQuota(workspaceId, db)
  if (!status || status.limit == null) return // fail-open / 不限
  if (status.used + adding <= status.limit) return

  throw createError({
    statusCode: 403,
    statusMessage: adding === 1
      ? planLimitMessage('AI 知識量', status.used, status.limit, status.planName)
      : `AI 知識量不夠了：目前 ${status.used} 條，這批要再加 ${adding} 條，`
        + `超過${status.planName}方案上限 ${status.limit} 條。刪掉不需要的，或升級方案以取得更多額度。`,
  })
}

/** 供測試斷言用：目前快取內容（不打 Firestore）。 */
export function peekKnowledgeChunkCount(workspaceId: string): number | undefined {
  return countCache.get(String(workspaceId || '').trim())?.count
}
