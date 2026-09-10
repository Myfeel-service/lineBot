import { getDb } from '~~/server/utils/firebase'
import { isLeadFailureReason } from '~~/shared/lead-page-failure'
import { resolveWorkspaceIdByLiffChannelId } from '~~/server/utils/liff-tenant-resolve'
import { liffChannelIdFromLiffId } from '~~/server/utils/liff-token'
import { recordLeadPageFailure } from '~~/server/utils/lead-page-failures'

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
  const body = await readBody(event).catch(() => null)
  const reason = (body as { reason?: unknown } | null)?.reason

  if (!isLeadFailureReason(reason)) {
    // ⛔ 靜靜丟掉會讓「前端送了新代碼、後端還沒認得」查不出來——留一行看得到的紀錄
    console.warn('[liff/lead-error] unknown reason, dropped:', String(reason).slice(0, 64))
    return { ok: false as const, recorded: false as const }
  }

  const b = body as { liffId?: unknown, liffClientId?: unknown, campaignCode?: unknown, detail?: unknown }
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
