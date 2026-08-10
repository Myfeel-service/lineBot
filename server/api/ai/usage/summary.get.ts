import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { AI_USAGE_COLLECTION, currentYyyyMm, getQuotaAnswered } from '~~/server/utils/ai-usage'
import { buildPlanView, getWorkspaceSubscription } from '~~/server/utils/billing'
import { getAiSettings } from '~~/server/utils/ai-settings'
import { can } from '~~/shared/permissions'
import { bucketAiCosts, GEMINI_PRICING } from '~~/server/utils/ai-cost-buckets'
import type { AiUsageDoc } from '~~/shared/types/ai-knowledge'

/**
 * GET /api/ai/usage/summary?period=YYYYMM
 *
 * 回傳指定月份的 AI 用量 KPI：
 *   - invocations / answered / handoffs
 *   - 自動回覆率 / handoff 率
 *   - （僅 super admin）token 細目與估算成本
 *   - （僅 usage.read／admin+）方案與額度
 *
 * 門檻是 `ai.read`（viewer 起）而不是 `usage.read`：這頁是「AI 表現」，第一線客服
 * 也該看得到自己照顧的 AI 做得好不好。**計費相關的欄位改成逐欄位擋**——方案與額度
 * 只回給 admin+，成本只回給 super admin。權限用頁面層級一刀切的話，會變成
 * 「最該先看的那頁權限最嚴」。
 *
 * 成本可見性收歸平台：計費賣「則數」，token 成本是平台的進貨價——租戶拿到
 * NT$ 估算（或 token 數 × 公開牌價）就能反推毛利，故 cost/token 欄位一律只回
 * 給 super admin，租戶端通篇只講「則」。
 */
/**
 * Gemini 牌價（USD / 每百萬 token）。2026-07 查核之公開定價：
 *   gemini-2.5-flash：input $0.30 / output $2.50
 *   gemini-2.5-flash-lite：input $0.10 / output $0.40
 *   gemini-embedding-001：$0.15
 * 用量 doc 未分模型（router/反問走 flash-lite、答題走 flash 混計），
 * 一律以 flash 費率估 → **估算值偏保守（上限）**；實際費用以 Google 帳單為準。
 * 改價時只改這裡：pricing 會隨 API 回給前端顯示，前端不自帶一份。
 */
// 單價與三桶算式共用 server/utils/ai-cost-buckets.ts（超管成本頁也用同一份，改價只改那裡）
const PRICING = GEMINI_PRICING

/** super admin 專屬的 token / 成本細目（非 super admin 的回應中完全沒有這些 key） */
const EMPTY_COST_DETAIL = {
  inputTokens: 0,
  outputTokens: 0,
  embeddingTokens: 0,
  importInputTokens: 0,
  importOutputTokens: 0,
  conversationTokens: 0,
  buildTokens: 0,
  buildCostUsd: 0,
  testTokens: 0,
  testCostUsd: 0,
  estimatedCostUsd: 0,
  perConversationUsd: 0,
  pricing: PRICING,
}

export default defineEventHandler(async (event) => {
  const { workspaceId, isSuperAdmin, role } = await requireCapability(event, 'ai.read')
  // 方案／額度是計費資訊 → admin+ 才給（super admin 拿 role='owner'、組織管理員拿 'admin'，兩者都過）
  const canSeeBilling = can(role, 'usage.read')
  const query = getQuery(event)
  const period = String(query.period ?? currentYyyyMm()).replace(/[^\d]/g, '').slice(0, 6) || currentYyyyMm()

  const db = getDb()

  // 目前方案（給前端顯示額度進度條 / 超量提示）。
  // 看不到計費的人連查都不用查（省一次 Firestore 讀）；plan 回 null，前端那張卡自然不長出來
  const sub = canSeeBilling ? await getWorkspaceSubscription(workspaceId, db) : null
  const plan = canSeeBilling ? buildPlanView(sub) : null

  // AI 是否已啟用（前端頂端狀態列用）：未啟用時 webhook 完全不跑 AI，畫面數字皆為歷史/測試。
  const settings = await getAiSettings(workspaceId, db)
  const aiEnabled = settings.enabled
  const replyMode = settings.replyMode // 'auto' | 'draft'

  // 額度進度條看的是「本期」（訂閱週期）用量,與攔截同一顆計數器——跟下面按月份查的
  // 報表 KPI（answered/tokens…）是兩把不同的尺,故不隨 ?period 切換。
  const quotaAnswered = canSeeBilling && sub?.currentPeriodStart
    ? await getQuotaAnswered(workspaceId, sub.currentPeriodStart, db)
    : 0

  const snap = await db.collection(AI_USAGE_COLLECTION).doc(`${workspaceId}_${period}`).get()

  if (!snap.exists) {
    const empty = {
      period,
      plan,
      aiEnabled,
      replyMode,
      quotaAnswered,
      invocations: 0,
      answered: 0,
      handoffs: 0,
      disambiguations: 0,
      answeredThenHandoffs: 0,
      answeredThenHandoffRate: 0,
      autoReplyRate: 0,
      handoffRate: 0,
      disambiguationRate: 0,
    }
    return isSuperAdmin ? { ...empty, ...EMPTY_COST_DETAIL } : empty
  }

  const data = snap.data() as Partial<AiUsageDoc>
  const invocations = Number(data.invocations ?? 0)
  const answered = Number(data.answered ?? 0)
  const handoffs = Number(data.handoffs ?? 0)
  const disambiguations = Number(data.disambiguations ?? 0)
  const answeredThenHandoffs = Number(data.answeredThenHandoffs ?? 0)
  const inputTokens = Number(data.inputTokens ?? 0)
  const outputTokens = Number(data.outputTokens ?? 0)
  const embeddingTokens = Number(data.embeddingTokens ?? 0)
  const importInputTokens = Number(data.importInputTokens ?? 0)
  const importOutputTokens = Number(data.importOutputTokens ?? 0)
  const buildEmbeddingTokens = Number(data.buildEmbeddingTokens ?? 0)
  // 測試對話（playground 重演）的 token 獨立記帳；成本另計、不併進真客人成本與每對話成本。
  const testInputTokens = Number(data.testInputTokens ?? 0)
  const testOutputTokens = Number(data.testOutputTokens ?? 0)
  const testEmbeddingTokens = Number(data.testEmbeddingTokens ?? 0)

  // ── 依「用途」把成本拆三桶（客人對話才是 headline，其餘不灌進每對話成本）──
  // 拆法與超管成本頁共用 bucketAiCosts，兩邊不會各改各的而對不起來。
  const buckets = bucketAiCosts(data)
  const conversationTokens = buckets.conversation.tokens
  const buildTokens = buckets.build.tokens

  const cost = buckets.conversation.costUsd // 客人對話 = headline
  const buildCost = buckets.build.costUsd // 知識庫建置/整理
  const testCost = buckets.test.costUsd // 後台自用（playground 試打 ＋ 小幫手）

  const base = {
    period,
    plan,
    aiEnabled,
    replyMode,
    quotaAnswered,
    invocations,
    answered,
    handoffs,
    disambiguations,
    answeredThenHandoffs,
    // 品質 proxy：成功回答之中有多少比例在 30 分鐘內又被轉真人（越低越好）
    answeredThenHandoffRate: answered ? answeredThenHandoffs / answered : 0,
    autoReplyRate: invocations ? answered / invocations : 0,
    handoffRate: invocations ? handoffs / invocations : 0,
    disambiguationRate: invocations ? disambiguations / invocations : 0,
  }
  if (!isSuperAdmin) return base

  return {
    ...base,
    inputTokens,
    outputTokens,
    embeddingTokens,
    importInputTokens,
    importOutputTokens,
    // 三桶用途拆分：客人對話（headline）/ 知識庫建置 / 後台自用
    conversationTokens,
    buildTokens,
    buildCostUsd: Number(buildCost.toFixed(4)),
    testTokens: buckets.test.tokens,
    testCostUsd: Number(testCost.toFixed(4)),
    // estimatedCostUsd / perConversationUsd 只算「客人對話」——建置與測試不灌進來
    estimatedCostUsd: Number(cost.toFixed(4)),
    perConversationUsd: invocations ? Number((cost / invocations).toFixed(4)) : 0,
    pricing: PRICING,
  }
})
