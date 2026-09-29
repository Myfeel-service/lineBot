import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { deleteJobStorage, KNOWLEDGE_PREVIEW_JOBS_COLLECTION, type PreviewJobDoc } from '~~/server/utils/ai-preview-jobs'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * DELETE /api/ai/knowledge/preview-jobs/:jobId — 取消匯入工作（C-46）。
 *
 * 原本「取消」只是前端不再輪詢：job 停在 processing 佔著 Storage 一小時，
 * 而且任何知道 jobId 的人再 poll 一下就會**繼續花錢推進它**。
 * 這裡把取消變成伺服器端事實：標 cancelled（claim 會擋、不再推進）＋立即清 Storage。
 * 冪等：已取消/不存在都回 ok。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'knowledge.write')
  const jobId = String(event.context.params?.jobId ?? '').trim()
  if (!jobId) throw createError({ statusCode: 400, statusMessage: '缺少 jobId' })

  const db = getDb()
  const ref = db.collection(KNOWLEDGE_PREVIEW_JOBS_COLLECTION).doc(jobId)
  const snap = await ref.get()
  if (!snap.exists) return { ok: true }

  const job = snap.data() as PreviewJobDoc
  // 別家的匯入工作＝當作不存在、回跟上面一樣的東西（`G-106`）：回 404 就洩漏了「別家有這一份」
  if (job.workspaceId !== workspaceId) return { ok: true }
  // 已完成的不取消（結果可能已被匯入流程使用）；已取消冪等
  if (job.status === 'done') return { ok: true, status: 'done' }

  await ref.update({
    status: 'cancelled',
    leaseUntil: 0,
    updatedAt: FieldValue.serverTimestamp(),
  })
  // Storage（work.json / OCR 原檔）立即清，不等一小時後的排程
  await deleteJobStorage(workspaceId, jobId)

  // 稽核（`C-254`）：取消會把上傳的原檔立刻清掉，救不回來——
  // 「我明明傳上去了，檔案呢」的答案就在這一筆
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'knowledge.previewJobDelete',
    targetId: jobId,
    // ⚠️ job 文件上沒有存來源名稱（那在 Storage 的 work.json 裡，而我們剛把它清掉了），
    //    所以這裡只講得出「取消了一個匯入」——⛔ 不要編一個名字出來
    note: '取消了一個匯入，上傳的原檔已經一起清掉',
  }, db)

  return { ok: true, status: 'cancelled' }
})
