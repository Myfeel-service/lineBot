import { getDb } from '~~/server/utils/firebase'
import { isLeadFailureReason, isLeadTimeoutStage } from '~~/shared/lead-page-failure'
import { resolveWorkspaceIdByLiffChannelId } from '~~/server/utils/liff-tenant-resolve'
import { liffChannelIdFromLiffId } from '~~/server/utils/liff-token'
import { recordLeadPageFailure } from '~~/server/utils/lead-page-failures'
import { createRateLimiter, rateLimitClientIp } from '~~/server/utils/rate-limit'

/**
 * 同一個來源 10 分鐘最多記 30 次（`G-105`）。原本不限次數：不用登入、每打一次就是一筆寫入，
 * 而且全部寫進同一份小時桶文件（單一文件寫入頻率本來就有上限）。
 *
 * 為什麼是 30：一位客人打開一次活動頁，失敗的那條路只會回報一次；30 是留給**同一個出口
 * 位址後面的很多人**（公司 Wi-Fi、電信業者共用 IP）同時打不開的情況。
 * ⚠️ 這個數字是「該去看設定了」的訊號（見 `lead-page-failures.ts` 檔頭），少記幾次不影響它亮不亮；
 * ⛔ 但不能不限——那等於任何人都能免費幫別家灌紅燈、灌我們的寫入費。
 */
const leadErrorLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 30 })

/**
 * POST /api/liff/lead-error — 活動頁把「客人這次打不開」回報回來。
 *
 * 為什麼需要：在此之前這件事完全沒有出口，商家永遠不會知道客人進不來
 * （見 `server/utils/lead-page-failures.ts` 檔頭）。
 *
 * ⛔ 不接受 body 帶 `workspaceId`：這支端點沒有驗證（失敗的當下客人連 LIFF access
 * token 都拿不到），讓呼叫端自報租戶等於任何人都能往別家的計數裡寫東西。租戶一律
 * 由 liffId／liffClientId 反查——要偽造得先有那家的公開活動連結，代價與收益都只到
 * 「灌高一個提醒用的數字」。
 *
 * 認不出租戶就什麼都不寫（回 202），⛔ 不落到 default 租戶：那會讓 A 家的災情記在 B 家頭上。
 */
export default defineEventHandler(async (event) => {
  // 節流放最前面：連「不認得的代碼」那行 log、反查租戶那次讀取都要算在裡面
  const ip = rateLimitClientIp(event)
  const rl = leadErrorLimiter.take(ip)
  if (rl.limited) {
    // ⛔ 丟掉的要說得出來，但同一個視窗只記第一次（不然猛打的人順便幫我們灌 log）
    if (rl.firstRejection) console.warn('[liff/lead-error] rate limited, dropping reports from', ip.slice(0, 64))
    setResponseStatus(event, 429)
    return { ok: false as const, recorded: false as const }
  }

  const body = await readBody(event).catch(() => null)
  const reason = (body as { reason?: unknown } | null)?.reason

  if (!isLeadFailureReason(reason)) {
    // ⛔ 靜靜丟掉會讓「前端送了新代碼、後端還沒認得」查不出來——留一行看得到的紀錄
    console.warn('[liff/lead-error] unknown reason, dropped:', String(reason).slice(0, 64))
    return { ok: false as const, recorded: false as const }
  }

  const b = body as { liffId?: unknown, liffClientId?: unknown, campaignCode?: unknown, detail?: unknown, stage?: unknown }
  const liffId = String(b.liffId || '').trim()
  const channelHint = String(b.liffClientId || '').trim() || liffChannelIdFromLiffId(liffId)

  const { workspaceId } = await resolveWorkspaceIdByLiffChannelId(channelHint)
  if (!workspaceId) {
    console.warn('[liff/lead-error] cannot resolve workspace, dropped:', reason, channelHint.slice(0, 32))
    setResponseStatus(event, 202)
    return { ok: true as const, recorded: false as const }
  }

  try {
    await recordLeadPageFailure(getDb(), {
      workspaceId,
      reason,
      campaignCode: String(b.campaignCode || ''),
      detail: String(b.detail || ''),
      // 舊版前端不會送 stage；認不得的值一律當 unknown，⛔ 不可以照單寫進去
      // （那會在統計裡長出一堆只出現一次的假階段，跟沒分是一樣的）
      stage: isLeadTimeoutStage(b.stage) ? b.stage : 'unknown',
    })
  }
  catch (e) {
    // 回報失敗不該再讓客人看到第二個錯誤——但一定要留下來，
    // 否則「都沒有失敗紀錄」會被讀成「沒有客人失敗」
    console.warn('[liff/lead-error] record failed:', String((e as Error)?.message ?? e).slice(0, 160))
    setResponseStatus(event, 202)
    return { ok: true as const, recorded: false as const }
  }

  return { ok: true as const, recorded: true as const }
})
