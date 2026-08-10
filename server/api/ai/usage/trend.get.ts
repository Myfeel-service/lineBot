import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { AI_USAGE_COLLECTION } from '~~/server/utils/ai-usage'
import type { AiUsageDoc } from '~~/shared/types/ai-knowledge'

/**
 * GET /api/ai/usage/trend?months=3
 *
 * 回傳最近 N 個月的 AI 用量趨勢（月對月），給用量頁畫長條圖：
 * 每月的 invocations / answered / handoffs / disambiguations。只看對話量，不含成本細節（那在 summary）。
 * ⛔ 三個結果分項要湊齊：用量頁的 hero 拆三段，趨勢圖少畫一段的話，
 *    兩根柱子加起來會 ≠ hero 總數，看的人一定會拿去對帳。
 * 月結桶一月一份 doc，直接批次讀最近 N 顆即可，無需額外聚合。
 */
function lastNMonths(n: number): string[] {
  // 月結桶用台灣時區（UTC+8、無 DST），與 currentYyyyMm / 前端月份選單同一把尺。
  const tw = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(tw.getUTCFullYear(), tw.getUTCMonth() - i, 1))
    const y = d.getUTCFullYear()
    const m = String(d.getUTCMonth() + 1).padStart(2, '0')
    out.push(`${y}${m}`)
  }
  return out
}

export default defineEventHandler(async (event) => {
  // 純表現資料、不含任何計費成分 → 跟 summary 一樣開到 ai.read（viewer 起）
  const { workspaceId } = await requireCapability(event, 'ai.read')
  const q = getQuery(event)
  const months = Math.min(12, Math.max(2, Number(q.months ?? 3)))
  const periods = lastNMonths(months)

  const db = getDb()
  const refs = periods.map(p => db.collection(AI_USAGE_COLLECTION).doc(`${workspaceId}_${p}`))
  const snaps = await db.getAll(...refs)
  const byId = new Map(snaps.map(s => [s.id, s.exists ? (s.data() as Partial<AiUsageDoc>) : null]))

  return periods.map((p) => {
    const d = byId.get(`${workspaceId}_${p}`) ?? null
    return {
      period: p,
      label: `${p.slice(0, 4)}-${p.slice(4)}`,
      invocations: Number(d?.invocations ?? 0),
      answered: Number(d?.answered ?? 0),
      handoffs: Number(d?.handoffs ?? 0),
      disambiguations: Number(d?.disambiguations ?? 0),
    }
  })
})
