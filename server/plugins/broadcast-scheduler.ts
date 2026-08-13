import { Cron } from 'croner'
import { runDueScheduledBroadcasts } from '../utils/run-due-scheduled-broadcasts'

/**
 * 應用內建排程推播檢查（每分鐘）。
 * 只在本機 dev / Node 長駐進程（Compute）下執行。
 *
 * ⛔ Lambda（Amplify）上一律停用：Lambda 的計時器只在「正好有請求在處理」時才會醒，
 * 醒來觸發的發送又活不過那個請求的回應結束——回應一送出、執行環境就被凍結，
 * 發送死在半路，推播永遠卡在「發送中」（2026-08-12 AROMIC預熱事故的根因之一；
 * 同機制的 broadcast-scheduler-tick middleware 已因此整個移除）。
 * Lambda 環境的排程觸發只走兩條「等得到結果」的路：
 *   1. Cloud Scheduler → POST /api/broadcast/trigger-scheduled（主排程，每分鐘）
 *   2. 推播列表頁輪詢 → POST /api/broadcast/process-due（備援）
 *
 * - 若長駐環境也想關掉內建 Cron（例如已有外部排程），設 BROADCAST_CRON_ENABLED=false
 *   （仍安全，有 transaction 防重）
 */
export default defineNitroPlugin(() => {
  if (import.meta.prerender) return

  // Lambda runtime 一定會帶這兩個變數；偵測到就代表沒有長駐進程可以養計時器
  if (process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT) {
    console.log('[broadcast-scheduler] Lambda 環境，內建排程檢查停用（排程觸發走 Cloud Scheduler／列表頁輪詢）')
    return
  }

  if (String(process.env.BROADCAST_CRON_ENABLED || 'true').toLowerCase() === 'false') {
    console.log('[broadcast-scheduler] BROADCAST_CRON_ENABLED=false，內建排程檢查已關閉')
    return
  }

  let running = false

  new Cron('* * * * *', async () => {
    if (running) return
    running = true
    try {
      const out = await runDueScheduledBroadcasts()
      if (out.triggered > 0) {
        console.log('[broadcast-scheduler] 已觸發', out.triggered, '則推播', out.results)
      }
    }
    catch (e) {
      console.error('[broadcast-scheduler] 執行失敗', e)
    }
    finally {
      running = false
    }
  })

  console.log('[broadcast-scheduler] 已啟動（每分鐘檢查到期排程推播）')
})
