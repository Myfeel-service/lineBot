import { v4 as uuidv4 } from 'uuid'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { getSource } from '~~/server/utils/ai-knowledge-sources'
import { getResyncExtracted } from '~~/server/utils/ai-knowledge-resync'
import { extractionQualityWarnings } from '~~/server/utils/ai-source-extractors'
import {
  cleanupExpiredPreviewJobs,
  JOB_TTL_MS,
  KNOWLEDGE_PREVIEW_JOBS_COLLECTION,
  makeWork,
  primeChunking,
  progressFor,
  saveWork,
  type PreviewJobDoc,
} from '~~/server/utils/ai-preview-jobs'

/**
 * POST /api/ai/sources/:sourceId/resync-jobs
 *
 * 「重新同步」的非同步版：建一個 preview job（抽取先做掉、會失敗的當場報錯），
 * LLM 重切卡與 diff 比對留給輪詢端點逐步推進 → 永不撞閘道逾時。
 * 舊的同步式 resync-preview 一個請求做完全部,大頁面 30 秒必死、前端只看到
 * 「取得差異失敗」——與當年 preview-chunks 504 同病,補上當時漏掉的這條路。
 *
 * 回 { jobId }。前端拿 jobId 輪詢 GET /api/ai/knowledge/preview-jobs/[jobId]，
 * done 時回應多帶 resync: { sourceId, contentHash, diff, shrink }。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'sources.write')
  const sourceId = String(getRouterParam(event, 'sourceId') ?? '').trim()
  if (!sourceId) throw createError({ statusCode: 400, statusMessage: 'sourceId required' })

  const db = getDb()
  const source = await getSource(db, sourceId, workspaceId)
  if (!source) throw createError({ statusCode: 404, statusMessage: 'source not found' })
  if (source.data.type !== 'url' || !source.data.url) {
    throw createError({
      statusCode: 400,
      statusMessage: '目前只支援網址來源 (URL) 的重新同步；檔案請重新匯入',
    })
  }

  // 機會性清掃過期 job(Amplify 不跑 scheduledTasks,綁在功能流量上)
  const sweep = cleanupExpiredPreviewJobs(db, 20).catch(() => {})

  // 抽取(快且會失敗的部分):網址掛了在這裡當場報錯,使用者立刻看到
  // 「網址回應 404:請確認連結公開可訪問」這類可行動訊息。
  // getResyncExtracted 一律當場重抓(不讀排程暫存)——手動按下這顆按鈕的語意就是
  // 「現在去看一次網頁」;讀舊暫存會回報「全部未變」,看起來像功能壞掉。
  const extracted = await getResyncExtracted(db, sourceId, source.data.contentHash, source.data.url)
  if (!extracted.text.trim()) {
    throw createError({ statusCode: 502, statusMessage: '抓到網頁但內容為空；請確認頁面是否改版或改用「貼上文字」重新匯入' })
  }

  const jobId = uuidv4()
  const work = makeWork({
    type: 'url',
    url: source.data.url,
    name: source.data.name,
    generateOverview: false, // 總覽卡由 resync-apply 依套用後的子卡重生,不在 preview 做
    resyncSourceId: sourceId,
  })
  work.sourceName = source.data.name
  work.sourceUrl = source.data.url
  work.sourceType = 'url'
  work.rawLength = extracted.rawLength
  work.truncated = extracted.rawLength > extracted.text.length
  work.resyncContentHash = extracted.contentHash
  work.resyncFetchedChars = extracted.text.trim().length
  // 與匯入同一套擷取守門:同個網址在兩條路上要得到同樣的診斷
  work.warnings.push(...extractionQualityWarnings('url', extracted.text))
  primeChunking(work, extracted.text)

  await saveWork(workspaceId, jobId, work)

  const now = FieldValue.serverTimestamp()
  const jobDoc: PreviewJobDoc & Record<string, unknown> = {
    workspaceId,
    createdBy: uid,
    status: 'processing',
    phase: work.phase,
    progress: progressFor(work),
    error: null,
    sourceFile: null,
    leaseUntil: 0,
    createdAt: now,
    updatedAt: now,
    expiresAt: Timestamp.fromMillis(Date.now() + JOB_TTL_MS),
  }
  await db.collection(KNOWLEDGE_PREVIEW_JOBS_COLLECTION).doc(jobId).set(jobDoc)

  await sweep
  return { jobId, status: 'processing' as const, phase: work.phase }
})
