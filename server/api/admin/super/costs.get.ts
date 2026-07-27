import { requireSuperAdmin } from '~~/server/utils/workspace-auth'
import { AI_USAGE_COLLECTION, currentYyyyMm } from '~~/server/utils/ai-usage'
import type { AiUsageDoc } from '~~/shared/types/ai-knowledge'

// Gemini 牌價（USD / 每百萬 token），與 /api/ai/usage/summary、/api/admin/super/workspaces 同一份基準。
// 用量 doc 未分模型，一律以較貴的 flash 費率估 → 估算值偏保守（上限）；實際以 Google 帳單為準。改價只改這裡。
const IN_PER_M = 0.30
const OUT_PER_M = 2.50
const EMBED_PER_M = 0.15
const USD_TO_TWD = 32

const PRICING = { inputPerM: IN_PER_M, outputPerM: OUT_PER_M, embedPerM: EMBED_PER_M, usdToTwd: USD_TO_TWD }

const usd = (input: number, output: number, embed: number) =>
  (input / 1_000_000) * IN_PER_M
  + (output / 1_000_000) * OUT_PER_M
  + (embed / 1_000_000) * EMBED_PER_M

const round4 = (n: number) => Number(n.toFixed(4))

/** 上一個月份（YYYYMM），處理跨年。 */
function prevYyyyMm(p: string): string {
  const y = Number(p.slice(0, 4))
  const m = Number(p.slice(4, 6))
  const py = m <= 1 ? y - 1 : y
  const pm = m <= 1 ? 12 : m - 1
  return `${py}${String(pm).padStart(2, '0')}`
}

/** 把一顆月結桶依「用途」拆三桶成本（口徑與 /api/ai/usage/summary 完全一致）。 */
function bucketCosts(u: Partial<AiUsageDoc> | undefined) {
  const inputTokens = Number(u?.inputTokens ?? 0)
  const outputTokens = Number(u?.outputTokens ?? 0)
  const embeddingTokens = Number(u?.embeddingTokens ?? 0)
  const importInputTokens = Number(u?.importInputTokens ?? 0)
  const importOutputTokens = Number(u?.importOutputTokens ?? 0)
  const buildEmbeddingTokens = Number(u?.buildEmbeddingTokens ?? 0)
  const testInputTokens = Number(u?.testInputTokens ?? 0)
  const testOutputTokens = Number(u?.testOutputTokens ?? 0)
  const testEmbeddingTokens = Number(u?.testEmbeddingTokens ?? 0)

  // 客人對話要扣掉匯入（建置）分項，embedding 現只剩客人查詢向量。
  const convIn = Math.max(0, inputTokens - importInputTokens)
  const convOut = Math.max(0, outputTokens - importOutputTokens)
  const conversation = usd(convIn, convOut, embeddingTokens)
  const build = usd(importInputTokens, importOutputTokens, buildEmbeddingTokens)
  const test = usd(testInputTokens, testOutputTokens, testEmbeddingTokens)
  return { conversation, build, test, total: conversation + build + test }
}

/**
 * GET /api/admin/super/costs?period=YYYYMM
 *
 * 全租戶 AI（Gemini）估算成本總覽（super admin 專用）。
 * 把每個 workspace 指定月份的成本拆三桶（客人對話 / 知識庫建置 / 後台測試）各自算出、加總，
 * 附逐 workspace 明細（由高到低），並帶上一個月總成本供「vs 上月」比較。
 *
 * ⚠️ 只含 AI 估算成本；雲端主機、資料庫、LINE 推播、金流手續費不在此（見各平台帳單）。
 */
export default defineEventHandler(async (event) => {
  await requireSuperAdmin(event)

  const db = getDb()
  const query = getQuery(event)
  const period = String(query.period ?? currentYyyyMm()).replace(/[^\d]/g, '').slice(0, 6) || currentYyyyMm()
  const prevPeriod = prevYyyyMm(period)

  const [wsSnap, usageSnap, prevUsageSnap, settingsSnap] = await Promise.all([
    db.collection('workspaces').get(),
    db.collection(AI_USAGE_COLLECTION).where('period', '==', period).get(),
    db.collection(AI_USAGE_COLLECTION).where('period', '==', prevPeriod).get(),
    db.collection('aiSettings').get(),
  ])

  const usageByWs = new Map<string, Partial<AiUsageDoc>>()
  usageSnap.docs.forEach((d) => {
    const data = d.data() as Partial<AiUsageDoc>
    if (data.workspaceId) usageByWs.set(data.workspaceId, data)
  })
  const enabledByWs = new Map<string, boolean>()
  settingsSnap.docs.forEach(d => enabledByWs.set(d.id, (d.data() as { enabled?: boolean }).enabled === true))

  const workspaces = wsSnap.docs.map((d) => {
    const c = bucketCosts(usageByWs.get(d.id))
    const u = usageByWs.get(d.id)
    return {
      id: d.id,
      name: d.data().name ?? d.id,
      organizationId: d.data().organizationId ?? null,
      aiEnabled: enabledByWs.get(d.id) ?? false,
      invocations: Number(u?.invocations ?? 0),
      answered: Number(u?.answered ?? 0),
      testInvocations: Number(u?.testInvocations ?? 0),
      conversationCostUsd: round4(c.conversation),
      buildCostUsd: round4(c.build),
      testCostUsd: round4(c.test),
      totalCostUsd: round4(c.total),
    }
  })

  workspaces.sort((a, b) => b.totalCostUsd - a.totalCostUsd)

  const acc = { conversationCostUsd: 0, buildCostUsd: 0, testCostUsd: 0, totalCostUsd: 0, invocations: 0, answered: 0, testInvocations: 0, activeWorkspaces: 0 }
  for (const r of workspaces) {
    acc.conversationCostUsd += r.conversationCostUsd
    acc.buildCostUsd += r.buildCostUsd
    acc.testCostUsd += r.testCostUsd
    acc.totalCostUsd += r.totalCostUsd
    acc.invocations += r.invocations
    acc.answered += r.answered
    acc.testInvocations += r.testInvocations
    if (r.totalCostUsd > 0) acc.activeWorkspaces += 1
  }

  // 上月總成本（只需總數,給「vs 上月」用）
  let prevTotal = 0
  prevUsageSnap.docs.forEach((d) => {
    prevTotal += bucketCosts(d.data() as Partial<AiUsageDoc>).total
  })

  return {
    period,
    prevPeriod,
    pricing: PRICING,
    totals: {
      conversationCostUsd: round4(acc.conversationCostUsd),
      buildCostUsd: round4(acc.buildCostUsd),
      testCostUsd: round4(acc.testCostUsd),
      totalCostUsd: round4(acc.totalCostUsd),
      invocations: acc.invocations,
      answered: acc.answered,
      testInvocations: acc.testInvocations,
      activeWorkspaces: acc.activeWorkspaces,
    },
    prevTotalCostUsd: round4(prevTotal),
    workspaces,
  }
})
