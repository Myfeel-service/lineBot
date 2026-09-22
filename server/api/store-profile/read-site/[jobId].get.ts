import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { advanceStoreProfileJob, loadStoreProfileJob, toProgress } from '~~/server/utils/store-profile-jobs'

/**
 * GET /api/store-profile/read-site/[jobId]
 *
 * 輪詢＝推進一步（抓一頁，或做最後的整理）。每次呼叫只做一步，所以永不逾時。
 * ⛔ 一定要驗「這個工作是不是這個工作區的」：jobId 是 uuid 但不是密鑰，
 *    少了這一關，別的租戶猜到 id 就讀得到人家的網站內容。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'admin')
  const jobId = String(getRouterParam(event, 'jobId') ?? '').trim()
  if (!jobId) throw createError({ statusCode: 400, statusMessage: 'jobId is required' })

  const job = await loadStoreProfileJob(jobId)
  // 查不到與不是你的，對外都回同一句：不要讓人用回應差異試出別人的 job 存不存在
  if (!job || job.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到這個工作（可能已經過期）' })
  }

  if (job.status !== 'running') return toProgress(jobId, job)
  return advanceStoreProfileJob(jobId, job)
})
