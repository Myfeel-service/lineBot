import { listWorkspaceLineCredentials } from '~~/server/utils/line-workspace-credentials'
import { warmWorkspaceAutomationCaches } from '~~/server/utils/handler'
import { assertCronAuthorized } from '~~/server/utils/cron-auth'
import { getDb } from '~~/server/utils/firebase'
import { LEAD_PATH } from '~~/shared/liff-lead-path'

/**
 * GET /api/warmup
 *
 * 保溫端點：由外部 Cron（Cloud Scheduler）每 1〜2 分鐘呼叫。目的有四：
 *   1. 讓 Amplify Lambda 執行個體不因閒置被回收（避免冷啟動 2〜5 秒）
 *   2. 重整 webhook 回覆關鍵路徑上的 in-memory 快取（LINE 憑證、自動回覆規則、
 *      腳本、AI 設定、模組 flow＋圖文快照），客人觸發機器人模組時直接走全快取路徑
 *   3. 暖頁面渲染路徑：Nitro 的頁面渲染器是懶載入，只打 /api/* 暖不到；
 *      新實例的第一個「頁面」請求要多付 ~2 秒模組載入（實測 2.3s → 0.14s）。
 *        - /liff/lead：SPA 殼渲染器（/admin 後台共用同一條）
 *        - /：完整 SSR 渲染器（門面/login/法務頁共用；與 SPA 殼是不同模組）
 *   4. 併發子保溫：Amplify 同時跑多台實例，單一 ping 只暖得到接到它的那台
 *      （其餘實例仍冷 → 實測約 1/4 的請求會慢 0.3〜1.4s）。母請求對自己的
 *      公開網址同時發 WARM_CHILDREN 個帶 ?depth=1 的子請求——母請求在等待
 *      期間全部同時在線，強迫多台實例一起保持熱機（Lambda 一實例一請求）。
 *      這是 serverless 社群的標準 warmer 模式；子請求只做輕量保溫、
 *      絕不再往下擴散（防迴圈）。
 *
 * 保護機制：與 /api/broadcast/trigger-scheduled 相同——Header 需帶 X-Cron-Secret
 * 且與環境變數 CRON_SECRET 相符；未設定 CRON_SECRET 時僅允許 localhost。
 */

/** 除了母請求外,額外併發保溫幾台實例(總熱機池 ≈ 此值 + 1) */
const WARM_CHILDREN = 3

/** 兩條頁面渲染路徑(SPA 殼/完整 SSR 是不同懶載入模組,各暖一次) */
const WARM_PAGES = [LEAD_PATH, '/'] as const

async function warmPageRenderers(): Promise<Record<string, boolean>> {
  const results = await Promise.all(WARM_PAGES.map(path =>
    $fetch<string>(path, { responseType: 'text' })
      .then(() => true)
      .catch((e) => {
        console.warn('[warmup] page render warm failed:', path, e)
        return false
      }),
  ))
  return Object.fromEntries(WARM_PAGES.map((path, i) => [path, results[i] ?? false]))
}

export default defineEventHandler(async (event) => {
  assertCronAuthorized(event)
  const startedAt = Date.now()

  // ── 子保溫模式(?depth=1):佔住一台實例做輕量保溫,不查各 workspace 快取
  //    (快取是 per-instance 的,讓真實流量以便宜的 cache-miss 補即可)、不再擴散。
  if (String(getQuery(event).depth || '') === '1') {
    const [pagesWarmed] = await Promise.all([
      warmPageRenderers(),
      // 一筆最小讀取,保持 Firestore gRPC 連線不閒置
      getDb().collection('workspaces').limit(1).get().catch(() => null),
    ])
    return { child: true, pagesWarmed, ms: Date.now() - startedAt }
  }

  // ── 母保溫:完整快取預熱 + 頁面渲染 + 併發子保溫,全部並行 ─────────────
  const config = useRuntimeConfig()
  const publicBase = String(config.appBaseUrl || '').trim().replace(/\/$/, '')
  const cronSecret = String(config.cronSecret || '').trim()
  // 子保溫必須走「公開網址」才會經過負載平衡打到別台實例(內部 $fetch 只會留在本機)。
  // 未設 PUBLIC_BASE_URL 或密鑰時略過(等同舊行為,單台保溫)。
  const childTasks: Promise<boolean>[] = publicBase && cronSecret
    ? Array.from({ length: WARM_CHILDREN }, () =>
        $fetch(`${publicBase}/api/warmup?depth=1`, {
          headers: { 'x-cron-secret': cronSecret },
          timeout: 15_000,
        }).then(() => true).catch((e) => {
          console.warn('[warmup] child warm failed:', e?.message || e)
          return false
        }),
      )
    : []

  const workspaces = await listWorkspaceLineCredentials()
  const [results, pagesWarmed, children] = await Promise.all([
    Promise.all(workspaces.map(w =>
      warmWorkspaceAutomationCaches(w.workspaceId)
        .then(() => ({ workspaceId: w.workspaceId, ok: true }))
        .catch((e) => {
          console.warn('[warmup] workspace warm failed:', w.workspaceId, e)
          return { workspaceId: w.workspaceId, ok: false }
        }),
    )),
    warmPageRenderers(),
    Promise.all(childTasks),
  ])
  return {
    warmed: results,
    pagesWarmed,
    childrenWarmed: children.filter(Boolean).length,
    childrenTotal: childTasks.length,
    ms: Date.now() - startedAt,
  }
})
