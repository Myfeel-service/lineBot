import { FieldValue } from 'firebase-admin/firestore'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { getDb } from '~~/server/utils/firebase'
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
        // 縮水偵測(空內容當一等公民錯誤)。兩種都要抓,漏一種就會整源被刪:
        //  · 抓到的網頁字數暴跌 → 頁面掛掉 / 改成動態載入
        //  · 字數正常但**切出來的卡暴跌**(極端:LLM 回空陣列,不會 throw)→ 舊卡全被標成「移除」
        // 字數用「實際抓到的網頁字數」而非重切後的卡片字數(LLM 這輪寫精簡就會誤報);
        // 卡數則直接比張數。兩者都要求「真的有卡消失」才示警,沒有 removed 就沒有誤刪風險。
        const oldChars = oldChunks.reduce((s, c) => s + c.content.length, 0)
        const fetchedChars = work.resyncFetchedChars ?? 0
        const charsCollapsed = oldChars > 0 && fetchedChars < oldChars * 0.5
        const cardsCollapsed = oldChunks.length > 0 && work.chunks.length < oldChunks.length * 0.5
        work.resyncShrink = (charsCollapsed || cardsCollapsed) && work.resyncDiff.summary.removed > 0
          ? { oldChars, newChars: fetchedChars, oldCards: oldChunks.length, newCards: work.chunks.length }
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
    // 總時長 5 分鐘以上,比改寫前的並行切卡還慢。
    //
    // 兩個安全條件缺一不可:
    //  (a) **每一步做完就存檔**——不存的話,請求若在後面的步驟撞閘道逾時,前面已完成(且已付錢)
    //      的段全部白做,下一輪從頭再跑一次、再付一次錢。
    //  (b) 續跑前用「上一步實際花的時間」預估下一步,估不完就收工回報進度。只看已用時間的話,
    //      會在 17.9 秒時開啟一個 25 秒的步驟 → 43 秒 → 正是這套架構要避免的閘道逾時。
    // 另外只有「進來時就是 chunk 階段」才續跑:OCR 最後一批會把 phase 翻成 chunk,
    // 若順勢接下去做,一個請求會變成 OCR 批次 + 切卡批次,直接超過租約時間。
    const STEP_BUDGET_MS = 22_000
    const startedAt = Date.now()
    const loopable = work.phase === 'chunk'
    let lastStepMs = 0
    for (;;) {
      const stepStart = Date.now()
      await advanceWork(work, { getSourceBuffer })
      lastStepMs = Date.now() - stepStart
      await flushJobUsage(workspaceId, work) // 每步結清:中途取消 / 逾時也不會漏記已花的 token
      await saveWork(workspaceId, jobId, work) // 見 (a):每步落地,逾時只損失最後一步
      if (!loopable || work.phase !== 'chunk') break
      if (Date.now() - startedAt + lastStepMs > STEP_BUDGET_MS) break // 見 (b)
    }

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
