import type { SuperAlertsOverviewPayload, SuperAlertsWorkspace } from '~~/shared/types/super-alerts'
import { evaluateUsageRatio } from '~~/shared/billing/usage-ratio'
import { getDb } from '~~/server/utils/firebase'
import { collectWorkspaceAlerts, MAINTENANCE_STALE_MS } from '~~/server/utils/workspace-alerts'
import { getCurrentMonthUsageCounts } from '~~/server/utils/ai-usage'
import { requireSuperAdmin } from '~~/server/utils/workspace-auth'

/**
 * GET /api/admin/super/alerts-overview — 全站異常總覽（C-91，2026-08-27 拍板執行）。
 *
 * 這頁存在的理由：`maintenanceStalled` 是黃級不推 LINE，而負責推 LINE 警報的正是
 * 同一個排程——**排程死掉時，靠排程發的警報跟著一起死**，只能等有人開後台。
 * 所以這支端點開頁現查、不靠任何排程：心跳卡直讀 `cronState/maintenance-heartbeat`，
 * 各租戶的異常訊號跑跟小幫手完全同一套 probe（口徑單一來源，不另立判定）。
 *
 * 一併收進 `C-7`：每租戶本月「呼叫/答出」比（計費收在答出，呼叫多答出少＝成本
 * 掛在我們身上的帳號），判定在 shared/billing/usage-ratio.ts。
 *
 * 成本形狀：一個租戶一套 probe（~14 個窄查詢＋LINE/LIFF 探測各有 5 分鐘快取）。
 * 整包結果再加一層 5 分鐘記憶體快取——側欄紅點掛在 layout 上，每次進超管區都會來要，
 * 沒有這層每開一頁就全租戶重掃一輪。`?force=1` 兩層快取都跳過（「重新檢查」用）。
 */

/** 全租戶掃描上限：遠高於現有租戶數的保險絲，撞到會在 payload 標 truncated */
const WORKSPACE_SCAN_CAP = 300
const PAYLOAD_CACHE_TTL_MS = 5 * 60_000

let cache: { at: number, payload: SuperAlertsOverviewPayload } | null = null

export default defineEventHandler(async (event): Promise<SuperAlertsOverviewPayload> => {
  await requireSuperAdmin(event)
  const force = getQuery(event).force === '1'
  if (!force && cache && Date.now() - cache.at < PAYLOAD_CACHE_TTL_MS) return cache.payload

  const db = getDb()

  // 心跳：run-tasks 每 10 分鐘寫一次；門檻與 maintenanceStalled probe 同一把尺。
  // 文件不存在／值為 0 ＝ 還沒部署過排程或本機環境 → unknown，不下結論也不誤報
  const hbSnap = await db.collection('cronState').doc('maintenance-heartbeat').get()
  const lastRunAt = Number((hbSnap.data() as { lastRunAt?: number } | undefined)?.lastRunAt ?? 0)
  const heartbeat: SuperAlertsOverviewPayload['heartbeat'] = !hbSnap.exists || !lastRunAt
    ? { state: 'unknown', lastRunAt: null, ageMinutes: null }
    : {
        state: Date.now() - lastRunAt >= MAINTENANCE_STALE_MS ? 'stalled' : 'ok',
        lastRunAt,
        ageMinutes: Math.round((Date.now() - lastRunAt) / 60_000),
      }

  const wsSnap = await db.collection('workspaces')
    .select('name')
    .limit(WORKSPACE_SCAN_CAP)
    .get()
  const truncated = wsSnap.size >= WORKSPACE_SCAN_CAP
  if (truncated) console.warn('[super-alerts] workspace 數達掃描上限，部分帳號未檢查', WORKSPACE_SCAN_CAP)

  // 分批：一個租戶一套 probe，全開並發會對 Firestore／LINE API 開出數百查詢（同 org 彙總端點的取捨）
  const CHUNK = 5
  const workspaces: SuperAlertsWorkspace[] = []
  for (let i = 0; i < wsSnap.docs.length; i += CHUNK) {
    workspaces.push(...await Promise.all(wsSnap.docs.slice(i, i + CHUNK).map(async (doc) => {
      const [items, counts] = await Promise.all([
        collectWorkspaceAlerts(db, doc.id, { canSettings: true, canOperate: true, skipCache: force }),
        // 用量讀不到不擋異常總覽——回 0 會被低量護欄擋掉，不會誤標
        getCurrentMonthUsageCounts(doc.id, db).catch(() => ({ invocations: 0, answered: 0 })),
      ])
      return {
        id: doc.id,
        name: String((doc.data() as { name?: string }).name ?? doc.id),
        items: items.filter(a => a.state !== 'clear'),
        probedCount: items.length,
        usage: evaluateUsageRatio(counts.invocations, counts.answered),
      }
    })))
  }

  const payload: SuperAlertsOverviewPayload = { checkedAt: Date.now(), heartbeat, workspaces, truncated }
  cache = { at: Date.now(), payload }
  return payload
})
