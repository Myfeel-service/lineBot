import { FieldValue } from 'firebase-admin/firestore'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { getDb } from '~~/server/utils/firebase'
import { recordAiUsage } from '~~/server/utils/ai-usage'
import { detectProductName } from '~~/server/utils/ai-knowledge-chunker'
import { computeDiff, loadOldChunksForDiff } from '~~/server/utils/ai-knowledge-resync'
import {
  advanceWork,
  appendImportQualityWarnings,
  findExistingSources,
  flushJobUsage,
  JOB_LEASE_MS,
  KNOWLEDGE_PREVIEW_JOBS_COLLECTION,
  loadSourceFile,
  loadWork,
  progressFor,
  saveWork,
  workToPreviewResult,
  type PreviewJobDoc,
} from '~~/server/utils/ai-preview-jobs'

/**
 * GET /api/ai/knowledge/preview-jobs/[jobId]  （workspaceId 由 query 帶入）
 *
 * 輪詢兼推進：每次呼叫用租約 claim 一步、只推進「一個有界單位」（一批 OCR / 一段切卡 /
 * 一次總覽卡 / finalize），再寫回進度。done 時回與舊 preview-chunks 相同形狀。
 * 別人正持租約時直接回目前進度（不重複做）；被閘道掐斷的一步 lease 過期後由下一輪重接。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')
  const jobId = String(event.context.params?.jobId ?? '').trim()
  if (!jobId) throw createError({ statusCode: 400, statusMessage: '缺少 jobId' })

  const db = getDb()
  const ref = db.collection(KNOWLEDGE_PREVIEW_JOBS_COLLECTION).doc(jobId)

  // ── claim：transaction 內判狀態並搶租約 ───────────────────────────
  type ClaimOutcome =
    | { kind: 'done' }
    | { kind: 'error'; error: string }
    | { kind: 'busy'; phase: PreviewJobDoc['phase']; progress: PreviewJobDoc['progress'] }
    | { kind: 'claimed' }

  const outcome = await db.runTransaction<ClaimOutcome>(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) throw createError({ statusCode: 404, statusMessage: '找不到這個匯入工作（可能已過期）' })
    const job = snap.data() as PreviewJobDoc
    if (job.workspaceId !== workspaceId) throw createError({ statusCode: 403, statusMessage: '無權存取' })

    if (job.status === 'done') return { kind: 'done' }
    if (job.status === 'error') return { kind: 'error', error: job.error || '處理失敗' }

    const now = Date.now()
    if (job.leaseUntil && job.leaseUntil > now) {
      return { kind: 'busy', phase: job.phase, progress: job.progress }
    }
    tx.update(ref, { leaseUntil: now + JOB_LEASE_MS, status: 'processing', updatedAt: FieldValue.serverTimestamp() })
    return { kind: 'claimed' }
  })

  if (outcome.kind === 'busy') {
    return { status: 'processing' as const, phase: outcome.phase, progress: outcome.progress }
  }
  if (outcome.kind === 'error') {
    return { status: 'error' as const, error: outcome.error }
  }
  if (outcome.kind === 'done') {
    // 完成後再輪詢：從 work.json 重建完整結果（cleanup 前都可重取）
    const work = await loadWork(workspaceId, jobId)
    return { status: 'done' as const, ...workToPreviewResult(work) }
  }

  // ── claimed：做「一步」 ────────────────────────────────────────────
  try {
    const work = await loadWork(workspaceId, jobId)

    if (work.phase === 'finalize') {
      if (work.input.resyncSourceId) {
        // resync 工作:算新舊卡 diff + 內容縮水偵測。不跑「新來源」的三種檢查
        // (同名偵測 / 認產品名 / 匯入守門——對既有來源的重切全是誤報)。
        const oldChunks = await loadOldChunksForDiff(db, workspaceId, work.input.resyncSourceId)
        work.resyncDiff = computeDiff(oldChunks, work.chunks.map(c => ({
          title: c.title,
          content: c.content,
          tags: c.tags ?? [],
          questions: c.questions ?? [],
        })))
        // 縮水偵測(空內容當一等公民錯誤):比較基準是「這次從網頁抓到的字數」,
        // **不能用重切後的卡片字數**——LLM 這輪寫得精簡一點就會誤報整頁抓不到。
        // 再要求「真的有卡消失」才示警:沒有 removed 就沒有誤刪風險,不必嚇使用者。
        const oldChars = oldChunks.reduce((s, c) => s + c.content.length, 0)
        const fetchedChars = work.resyncFetchedChars ?? 0
        work.resyncShrink = oldChars > 0
          && fetchedChars < oldChars * 0.5
          && work.resyncDiff.summary.removed > 0
          ? { oldChars, newChars: fetchedChars }
          : null
      }
      else {
        // 同名偵測只對 file / url（同舊 preview-chunks）
        work.existingMatches = (work.input.type === 'file' || work.input.type === 'url')
          ? await findExistingSources(workspaceId, work.sourceName, db)
          : []
        // 自動認產品名（P1-1）：單一產品來源預填產品名給使用者確認。gsheet（多列多產品）不跑；
        // 多產品 / 平台頁 LLM 會回空字串。失敗不擋匯入（只是不預填）。
        if (!work.suggestedProductName && work.input.type !== 'gsheet' && work.chunks.length) {
          try {
            const sample = work.segments[0]
              || work.chunks.slice(0, 5).map(c => `${c.title}\n${c.content}`).join('\n')
            const det = await detectProductName(sample, work.sourceName)
            work.suggestedProductName = det.productName
            work.usage.inputTokens += det.inputTokens
            work.usage.outputTokens += det.outputTokens
          }
          catch (e) {
            console.warn('[preview-jobs] detectProductName failed（不預填，照常完成）:', e)
          }
        }
        // 匯入品質守門（P1-2）：時效字眼 / 重複卡 / 總覽矛盾 / 說明書無產品名。
        // 放在產品名偵測之後（第 4 項檢查要用偵測結果）；內部 fail-open 不擋匯入。
        await appendImportQualityWarnings(db, workspaceId, work)
      }

      // ── 共用收尾(兩種工作只差上面那段;收尾邏輯只留一份免得日後只改到一邊)──
      work.phase = 'done'
      await flushJobUsage(workspaceId, work) // 先結清未入帳 token,再標 done
      await saveWork(workspaceId, jobId, work)
      await ref.update({
        status: 'done',
        phase: 'done',
        progress: progressFor(work),
        leaseUntil: 0,
        updatedAt: FieldValue.serverTimestamp(),
      })
      return { status: 'done' as const, ...workToPreviewResult(work) }
    }

    // ocr / chunk / overview
    const getSourceBuffer = work.phase === 'ocr'
      ? async () => {
          const snap = await ref.get()
          const name = (snap.data() as PreviewJobDoc | undefined)?.sourceFile
          if (!name) throw createError({ statusCode: 500, statusMessage: 'ocr 階段缺少原始檔' })
          return loadSourceFile(workspaceId, jobId, name)
        }
      : undefined

    // 在時間預算內連續推進多步:一輪只推一段的話,長文件(100k 字 ≈ 13 段)要 13 次來回、
    // 總時長 5 分鐘以上,比改寫前的並行切卡還慢。用 STEP_BUDGET_MS 卡住單次請求時間,
    // 既不會撞閘道逾時,又能把來回次數壓下來。OCR 階段每批本來就久,只做一步。
    const STEP_BUDGET_MS = 18_000
    const startedAt = Date.now()
    do {
      await advanceWork(work, { getSourceBuffer })
      await flushJobUsage(workspaceId, work) // 每步結清:中途取消 / 逾時也不會漏記已花的 token
    } while (
      work.phase === 'chunk'
      && Date.now() - startedAt < STEP_BUDGET_MS
    )

    await saveWork(workspaceId, jobId, work)
    await ref.update({
      phase: work.phase,
      progress: progressFor(work),
      leaseUntil: 0,
      updatedAt: FieldValue.serverTimestamp(),
    })
    return { status: 'processing' as const, phase: work.phase, progress: progressFor(work) }
  }
  catch (err: any) {
    const message = String(err?.statusMessage || err?.message || '處理失敗')
    await ref.update({
      status: 'error',
      error: message,
      leaseUntil: 0,
      updatedAt: FieldValue.serverTimestamp(),
    }).catch(() => {})
    return { status: 'error' as const, error: message }
  }
})
