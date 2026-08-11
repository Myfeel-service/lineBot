import { v4 as uuidv4 } from 'uuid'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { getSource, KNOWLEDGE_SOURCES_COLLECTION } from '~~/server/utils/ai-knowledge-sources'
import { getResyncExtracted } from '~~/server/utils/ai-knowledge-resync'
import { extractionQualityWarnings } from '~~/server/utils/ai-source-extractors'
import { normalizeVolatileNumbers } from '~~/shared/knowledge-fingerprint'
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
 *
 * 例外：網頁內容與「目前卡片切出來的那一版」逐字元相同 → 直接回 { status: 'unchanged' }，
 * 不建 job、不跑 LLM（見下方註解）。body.force=true 可略過這個短路強制重切。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'sources.write')
  const sourceId = String(getRouterParam(event, 'sourceId') ?? '').trim()
  if (!sourceId) throw createError({ statusCode: 400, statusMessage: 'sourceId required' })
  const body = await readBody(event).catch(() => ({} as any))
  const force = body?.force === true

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

  /**
   * 網頁內容與「目前卡片切出來的那一版」完全相同 → 沒有任何事情需要使用者決定，當場收工。
   *
   * 沒有這一段的話：照樣送 LLM 重切一次，再拿「這次的 LLM 產物」比對「上次的 LLM 產物」。
   * 兩邊都是生成結果，措辭與切法本來就會漂（「功能：溫控」vs「特色：溫控」、17 張切成 13 張），
   * 於是網頁一個字都沒動也會跳出「修改 3 / 新增 10 / 移除 14 / 未變 0」要人逐張決定——
   * 這正是「系統說知識卡有變更，其實沒有」的來源。順便省下一整輪切卡的錢與等待。
   *
   * 同時把「有變動」標記清掉：既然現在的網頁就等於卡片的基準，那個提示已經沒有意義
   * （之前是排程偵測到中途改過又改回來、或已被小改自動套用處理掉）。
   */
  const baseline = String(source.data.appliedContentHash ?? '').trim()
  if (!force && baseline && baseline === extracted.contentHash) {
    // 兩道指紋要一起更新（排程用「抹掉數字後的指紋」分辨「網頁真的改了」與「計數器又跳了」）。
    // 只更新其中一道會讓兩者對應到不同版本，下次數字一動就被誤判成文字改過。
    const { createHash } = await import('node:crypto')
    const textHash = createHash('sha256').update(normalizeVolatileNumbers(extracted.text)).digest('hex')
    await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).update({
      contentHash: extracted.contentHash,
      textHash,
      pendingHash: FieldValue.delete(),
      outdatedAt: null,
      lastFetchedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }).catch(e => console.warn('[resync] unchanged bookkeeping failed:', e))
    return {
      status: 'unchanged' as const,
      sourceId,
      contentHash: extracted.contentHash,
      fetchedChars: extracted.text.trim().length,
    }
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
