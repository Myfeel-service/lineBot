import { listWorkspaceLineCredentials } from '~~/server/utils/line-workspace-credentials'
import { warmWorkspaceAutomationCaches } from '~~/server/utils/handler'
import { assertCronAuthorized } from '~~/server/utils/cron-auth'

/**
 * GET /api/warmup
 *
 * 保溫端點：由外部 Cron（cron-job.org／UptimeRobot／EventBridge）每 1〜2 分鐘呼叫。
 * 目的有三：
 *   1. 讓 Amplify Lambda 執行個體不因閒置被回收（避免冷啟動 2〜5 秒）
 *   2. 重整 webhook 回覆關鍵路徑上的 in-memory 快取（LINE 憑證、自動回覆規則、
 *      腳本、AI 設定、模組 flow＋圖文快照），客人觸發機器人模組時直接走全快取路徑
 *   3. 暖頁面渲染路徑：Nitro 的頁面渲染器是懶載入，只打 /api/* 暖不到；
 *      新實例的第一個「頁面」請求要多付 ~2 秒模組載入（實測 2.3s → 0.14s）。
 *      兩條渲染路徑各暖一次（回應丟棄、失敗不影響保溫）：
 *        - /liff/lead：SPA 殼渲染器（/admin 後台共用同一條）
 *        - /：完整 SSR 渲染器（門面/login/法務頁共用；與 SPA 殼是不同模組）
 *
 * 保護機制：與 /api/broadcast/trigger-scheduled 相同——Header 需帶 X-Cron-Secret
 * 且與環境變數 CRON_SECRET 相符；未設定 CRON_SECRET 時僅允許 localhost。
 */
export default defineEventHandler(async (event) => {
  assertCronAuthorized(event)

  const startedAt = Date.now()
  const WARM_PAGES = ['/liff/lead', '/'] as const
  const workspaces = await listWorkspaceLineCredentials()
  const [results, ...pageResults] = await Promise.all([
    Promise.all(workspaces.map(w =>
      warmWorkspaceAutomationCaches(w.workspaceId)
        .then(() => ({ workspaceId: w.workspaceId, ok: true }))
        .catch((e) => {
          console.warn('[warmup] workspace warm failed:', w.workspaceId, e)
          return { workspaceId: w.workspaceId, ok: false }
        }),
    )),
    ...WARM_PAGES.map(path =>
      $fetch<string>(path, { responseType: 'text' })
        .then(() => true)
        .catch((e) => {
          console.warn('[warmup] page render warm failed:', path, e)
          return false
        }),
    ),
  ])
  const pagesWarmed = Object.fromEntries(WARM_PAGES.map((path, i) => [path, pageResults[i] ?? false]))
  return { warmed: results, pagesWarmed, ms: Date.now() - startedAt }
})
