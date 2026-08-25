import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { getAiSettings } from '~~/server/utils/ai-settings'
import { TAG_DISCOVERY_COLLECTION } from '~~/server/utils/tag-discovery'
import type { TagDiscoveryDoc } from '~~/shared/tag-discovery'
import { isScannerStalled, readScannerHealth } from '~~/shared/scanner-health'

/**
 * GET /api/tag/discovery — 「AI 發現的新標籤」收件匣（標籤頁頂部那張卡）
 *
 * Response: { enabled, pending, lastScanMs }
 * enabled＝autoTagSuggest 總開關：關著的話卡片要講「去 AI 設定打開」而不是永遠空白。
 * 單文件直讀，零掃描零新索引。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')
  const db = getDb()

  const [settings, snap] = await Promise.all([
    getAiSettings(workspaceId, db),
    db.collection(TAG_DISCOVERY_COLLECTION).doc(workspaceId).get(),
  ])
  const doc = (snap.data() ?? null) as TagDiscoveryDoc | null

  return {
    enabled: settings.autoTagSuggest?.enabled === true,
    /**
     * 掃描器是不是連續失敗中。⛔ 一定要回這個：畫面只拿 `lastScanMs` 的話，
     * 「每輪都炸」看起來會跟「還沒跑第一次」一模一樣（`C-68` 的沉默死亡）。
     */
    stalled: isScannerStalled(readScannerHealth(snap.data() as Record<string, unknown> | undefined)),
    pending: (Array.isArray(doc?.pending) ? doc!.pending : []).map(p => ({
      id: p.id,
      name: p.name,
      category: p.category,
      criteria: p.criteria,
      usage: p.usage,
      reason: p.reason,
      userCount: Array.isArray(p.userDocIds) ? p.userDocIds.length : 0,
      sampleNames: Array.isArray(p.sampleNames) ? p.sampleNames : [],
      proposedAtMs: p.proposedAtMs,
    })),
    lastScanMs: Number(doc?.lastScanMs ?? 0),
  }
})
