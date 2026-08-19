import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { deleteJobStorage, KNOWLEDGE_PREVIEW_JOBS_COLLECTION, type PreviewJobDoc } from '~~/server/utils/ai-preview-jobs'

/**
 * DELETE /api/ai/knowledge/preview-jobs/:jobId — 取消匯入工作（C-46）。
 *
 * 原本「取消」只是前端不再輪詢：job 停在 processing 佔著 Storage 一小時，
 * 而且任何知道 jobId 的人再 poll 一下就會**繼續花錢推進它**。
 * 這裡把取消變成伺服器端事實：標 cancelled（claim 會擋、不再推進）＋立即清 Storage。
 * 冪等：已取消/不存在都回 ok。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')
  const jobId = String(event.context.params?.jobId ?? '').trim()
  if (!jobId) throw createError({ statusCode: 400, statusMessage: '缺少 jobId' })

  const db = getDb()
  const ref = db.collection(KNOWLEDGE_PREVIEW_JOBS_COLLECTION).doc(jobId)
  const snap = await ref.get()
  if (!snap.exists) return { ok: true }

  const job = snap.data() as PreviewJobDoc
  if (job.workspaceId !== workspaceId) throw createError({ statusCode: 403, statusMessage: '無權存取' })
  // 已完成的不取消（結果可能已被匯入流程使用）；已取消冪等
  if (job.status === 'done') return { ok: true, status: 'done' }

  await ref.update({
    status: 'cancelled',
    leaseUntil: 0,
    updatedAt: FieldValue.serverTimestamp(),
  })
  // Storage（work.json / OCR 原檔）立即清，不等一小時後的排程
  await deleteJobStorage(workspaceId, jobId)
  return { ok: true, status: 'cancelled' }
})
