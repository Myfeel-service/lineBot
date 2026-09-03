import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { getServiceAccountEmail, parseGoogleSheetUrl, probeGoogleSheetAccess } from '~~/server/utils/google-sheets'
import { classifyGsheetProbeError } from '~~/shared/gsheet-probe-status'

/**
 * POST /api/ai/knowledge/gsheet-probe   Body: { url }
 *
 * 「我現在讀不讀得到這份試算表」——貼上連結的當下就回答（`D-50` 簡化 4）。
 *
 * 為什麼要有這一支：Google 試算表比其他三種來源多一道站外的手續（要把表分享給服務帳號），
 * 而原本「分享好了沒」**只有按下「先看 AI 整理的結果」才知道**——沒弄好的人會先吃一次
 * 紅字、回 Google 重弄、再回來按一次。第一次匯入最容易卡死的就是這一段。
 *
 * ⛔ 讀不到**不是** HTTP 錯誤：這支的工作就是回答是或不是，所以一律回 200 帶 `status`。
 *    用 4xx 表示「還沒分享」的話，前端的錯誤處理會把它當成系統故障來報。
 * ⛔ 不可以只讀 metadata 就報綠燈：「分享好了但那個分頁沒有資料」會照樣通過，
 *    然後在按下整理時撞 422「沒有足夠資料」——那正是這支要消滅的撞牆。
 * ⚠️ 但也不該為了回答一句話把整份表讀完（第一版直接呼叫 readGoogleSheetAsCards，
 *    5,000 列的商品表就真的讀 5,000 列、切完所有卡再全部丟掉；而使用者每改一次網址、
 *    每按一次「再測一次」都會重跑一遍）。改用 probeGoogleSheetAccess：同一套判定、只讀前 20 列。
 */
export default defineEventHandler(async (event) => {
  await requireWorkspaceAccess(event, 'agent')
  const body = await readBody(event)
  const url = String(body?.url ?? '').trim()

  const ref = parseGoogleSheetUrl(url)
  if (!ref) {
    return {
      status: 'bad_url' as const,
      message: '這個連結看起來不是 Google 試算表的網址。',
      serviceAccountEmail: getServiceAccountEmail(),
    }
  }

  try {
    const res = await probeGoogleSheetAccess(ref)
    // 讀得到但沒資料也是「還不能匯入」，要當成一種狀態講清楚（不是綠燈）
    if (!res.hasData) {
      return {
        status: 'no_data' as const,
        message: `讀得到這份試算表，但「${res.sheetTitle}」分頁的前 20 列沒有資料（需要表頭列 ＋ 至少一列資料）。`,
      }
    }
    // ⛔ 不報總列數：只讀了前 20 列，算不出全表有幾列（報一個算錯的數字比不報更糟）
    return {
      status: 'ok' as const,
      sheetTitle: res.sheetTitle,
      message: `讀得到了（會讀「${res.sheetTitle}」分頁）`,
    }
  }
  catch (err: any) {
    const raw = String(err?.statusMessage || err?.message || '')
    // 分類（含「哪一條規則要排在前面」）在 shared/gsheet-probe-status.ts，有測試釘住
    const { status, needsShare } = classifyGsheetProbeError(raw)
    if (needsShare) {
      return {
        status,
        message: '還讀不到：請把試算表「共用」給下面這個帳號（檢視權限就夠）。',
        detail: raw.slice(0, 300),
        serviceAccountEmail: getServiceAccountEmail(),
      }
    }
    // ⛔ 其餘一律照實把原文帶出去（截斷但不改寫）：我們猜不出來的時候，
    //    Google 那句原文往往就是答案，假裝是「沒分享」只會害人去按一個本來就好的分享鈕。
    return { status, message: raw.slice(0, 300) || '試不出來（可能是暫時的網路問題）' }
  }
})
