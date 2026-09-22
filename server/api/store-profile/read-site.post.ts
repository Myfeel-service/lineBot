import { v4 as uuidv4 } from 'uuid'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { getDb } from '~~/server/utils/firebase'
import { assertMaintenanceBudget } from '~~/server/utils/ai-usage'
import { cleanupExpiredStoreProfileJobs, createStoreProfileJob } from '~~/server/utils/store-profile-jobs'
import { getStoreProfile, saveStoreProfile } from '~~/server/utils/store-profile'
import { normalizeSiteUrl } from '~~/shared/types/store-profile'

/**
 * POST /api/store-profile/read-site  Body: { siteUrl }
 *
 * 開一個「讀網站建輪廓」的工作，回 { jobId, ...進度 }。
 * 第一頁在這裡就抓完 —— 網址打錯、對方擋人這種事要在他還看著畫面的時候講，
 * 不要讓人輪詢半天才知道。其餘的頁由 GET /api/store-profile/read-site/[jobId] 一頁一頁推。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'admin')
  // 維運額度前置檢查：超額就不要開工作，讓人第一時間看到原因（沿用知識庫匯入的做法）
  await assertMaintenanceBudget(workspaceId)

  const body = await readBody(event).catch(() => ({})) as { siteUrl?: string }
  const siteUrl = normalizeSiteUrl(String(body?.siteUrl ?? ''))
  if (!siteUrl) {
    throw createError({ statusCode: 400, statusMessage: '請給一個網址（例：shop.example.tw）' })
  }

  // 機會性清掃（Amplify 上沒有排程）。⛔ 不 await：清掃的往返不該算進這支的回應時間。
  void cleanupExpiredStoreProfileJobs(getDb(), 20).catch(() => {})

  // 網址先落地：就算讀取整段失敗，「他給過我們哪個網址」也要留著，
  // 不然重試時人要再打一次字。
  const profile = await getStoreProfile(workspaceId)
  if (profile.siteUrl !== siteUrl) {
    profile.siteUrl = siteUrl
    await saveStoreProfile(workspaceId, profile)
  }

  const jobId = uuidv4()
  const { progress } = await createStoreProfileJob(workspaceId, siteUrl, jobId)
  return progress
})
