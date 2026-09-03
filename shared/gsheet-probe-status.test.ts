import { describe, expect, it } from 'vitest'
import { classifyGsheetProbeError } from './gsheet-probe-status'

/**
 * 這幾條字串是從 server/utils/google-sheets.ts 的 createError 原文抄來的。
 * 那邊改訊息時這裡會紅——那正是要的：分類錯了畫面就會叫人做錯的事。
 */
describe('classifyGsheetProbeError', () => {
  it('沒分享給服務帳號 → 叫人去按分享', () => {
    const raw = '讀不到這份 Google Sheet（403）。請把表單「分享」給服務帳號：bot@x.iam.gserviceaccount.com（檢視權限即可，並取消勾選「通知使用者」）。Google 原始訊息：The caller does not have permission'
    expect(classifyGsheetProbeError(raw)).toEqual({ status: 'no_access', needsShare: true })
  })

  it('Sheets API 沒啟用 → 也算讀不到（同一顆按鈕修不了，但要看得到原文）', () => {
    const raw = 'Google Sheets API 尚未在「服務帳號所屬的專案」啟用。請依 Google 指示的連結（含正確專案編號）啟用後等 1–2 分鐘再試。Google 原始訊息：SERVICE_DISABLED'
    expect(classifyGsheetProbeError(raw).status).toBe('no_access')
  })

  it('分享好了但沒有資料 → 不要叫人再去分享一次', () => {
    const raw = '這份試算表沒有足夠資料（需要表頭列 + 至少一列資料）'
    expect(classifyGsheetProbeError(raw)).toEqual({ status: 'no_data', needsShare: false })
  })

  it('指定的分頁不見了 → 屬於「沒資料可讀」，不是權限問題', () => {
    const raw = '原本指定的分頁已不存在（分頁被刪除重建時，連結裡的 gid 會變）。請確認試算表分頁，重新貼一次正確的分頁連結。'
    expect(classifyGsheetProbeError(raw).status).toBe('no_data')
  })

  /**
   * ⚠️ 這條是規則順序的守門測試。Excel 檔那句原文裡**也有**「分享給服務帳號」幾個字，
   * 若 no_access 的規則排在前面，就會叫人一直去按分享，而真正該做的是先轉檔。
   */
  it('上傳的 Excel 檔（訊息裡也有「分享給服務帳號」）→ 要判成要轉檔，不是要分享', () => {
    const raw = '這個連結是「上傳的 Excel 檔」（還沒轉成 Google 試算表），系統讀不到。請在 Google 試算表裡點「檔案 → 另存為 Google 試算表」，用轉好的新檔分享給服務帳號、再貼新連結；或直接改用「下載 FAQ 範本」在 Google 雲端硬碟新建試算表。'
    expect(classifyGsheetProbeError(raw)).toEqual({ status: 'bad_file', needsShare: false })
  })

  it('猜不出來的錯誤 → unknown，且不可以說成「沒分享」', () => {
    expect(classifyGsheetProbeError('Google Sheets 連線失敗：fetch failed')).toEqual({ status: 'unknown', needsShare: false })
    expect(classifyGsheetProbeError('')).toEqual({ status: 'unknown', needsShare: false })
  })
})
