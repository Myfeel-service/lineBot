import { requireCapability } from '~~/server/utils/workspace-auth'
import { getServiceAccountEmail } from '~~/server/utils/google-sheets'

/**
 * GET /api/ai/knowledge/gsheet-account
 * 回傳本部署讀 Google Sheet 用的服務帳號 email，給匯入畫面提示
 * 「請把表單分享給這個帳號（檢視權限）」。
 *
 * 門檻是 `ai.read`（觀察者起）而不是客服（`G-107` #4）：知識庫頁一掛載匯入視窗就會打這支，
 * 以前觀察者每開一次知識庫就吃一次 403（錯誤被吞掉、只剩主控台一行紅字）。
 * 回的只有一個帳號 email（不是金鑰，別的端點也照樣回給客服），給觀察者看不多洩漏任何東西；
 * 真正讀表單的匯入、探測端點仍是客服級。
 */
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'ai.read')
  return { serviceAccountEmail: getServiceAccountEmail() }
})
