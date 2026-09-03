import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { getDb } from '~~/server/utils/firebase'
import { advancePreviewJob } from '~~/server/utils/ai-preview-job-runner'

/**
 * GET /api/ai/knowledge/preview-jobs/[jobId]
 *
 * 輪詢兼推進：每次呼叫推進「一個有界單位」（一批 OCR / 一段切卡 / 一次總覽卡 / finalize），
 * done 時回與舊 preview-chunks 相同形狀。
 *
 * 推進的邏輯本體在 `server/utils/ai-preview-job-runner.ts`——2026-09-03（`D-50` 簡化 3）
 * 搬出去的，因為定時維護工（`ai:advance-preview-jobs`）要在使用者離開之後接手推進**同一份**
 * 工作。這支現在只做三件事：驗權限、呼叫引擎、把結果轉成 HTTP 回應。
 * ⛔ 不要在這裡再長出任何推進邏輯：兩個呼叫端一旦分歧，就會回到「同一批 OCR 收兩次錢」。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')
  const jobId = String(event.context.params?.jobId ?? '').trim()
  if (!jobId) throw createError({ statusCode: 400, statusMessage: '缺少 jobId' })

  const outcome = await advancePreviewJob(getDb(), workspaceId, jobId)

  // 前端靠 404 / 403 判斷「這個記號沒用了，靜靜丟掉」（見 KnowledgeImportDialog 的 resumeStoredJob），
  // 所以這兩種一定要維持成 HTTP 錯誤碼，不能改成 200 帶狀態。
  if (outcome.status === 'missing') {
    throw createError({ statusCode: 404, statusMessage: '找不到這個匯入工作（可能已過期）' })
  }
  if (outcome.status === 'forbidden') {
    throw createError({ statusCode: 403, statusMessage: '無權存取' })
  }
  if (outcome.status === 'done') {
    return { status: 'done' as const, ...outcome.result }
  }
  if (outcome.status === 'error') {
    return { status: 'error' as const, error: outcome.error }
  }
  return { status: 'processing' as const, phase: outcome.phase, progress: outcome.progress }
})
