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
    /**
     * 上次掃描的明細（`C-94`）。⛔ 一定要回：只給 `lastScanMs` 的話，畫面對
     * 「樣本太少」「AI 覺得沒主題」「AI 有提但被擋掉」只能印同一句話，
     * 而老闆按了幾次「立即掃描」得到的就是那同一句（08-28 的實際回報）。
     */
    lastScan: doc?.lastScan ?? null,
    /**
     * 決策紀錄，**新的在前**（畫面由上往下讀＝由近到遠）。
     * ⛔ 資料層是 append 到尾巴（FIFO 砍舊的靠 slice(-N)），呈現順序在這裡反轉，
     *    不要為了顯示方便去改資料的排序——那會讓 FIFO 砍到最新的那幾筆。
     */
    history: (Array.isArray(doc?.history) ? doc!.history : []).slice().reverse(),
    /**
     * 有人按過「立即掃描一次」、排程還沒撿走（比 lastScanMs 新才算數）。
     * ⛔ 一定要回：少了它，按完按鈕重新整理頁面就完全看不出「已經排隊了」，
     * 只剩一則會消失的 toast——使用者會以為沒按到，然後再按一次（而那顆按鈕會花一次 LLM）。
     */
    rescanRequestedMs: Number(doc?.rescanRequestedMs ?? 0),
  }
})
