import type { Firestore } from 'firebase-admin/firestore'
import { FieldValue } from 'firebase-admin/firestore'
import { detectProductName } from '~~/server/utils/ai-knowledge-chunker'
import { runWithLlmBudget } from '~~/server/utils/gemini'
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
  loadWorkWithGeneration,
  progressFor,
  saveWork,
  workToPreviewResult,
  type PreviewJobDoc,
} from '~~/server/utils/ai-preview-jobs'

/**
 * 匯入／重新同步工作的「推進一步」引擎。
 *
 * 這段程式原本長在輪詢端點 `preview-jobs/[jobId].get.ts` 裡面，也就是**只有前端在輪詢時
 * 才會前進**。後果是等待畫面上那句「可以先關掉視窗去做別的事」只講得出半套：離開的期間
 * 工作停在原地，回來才接著跑，超過 8 分鐘前端還會放棄（`D-50` 簡化 3）。
 *
 * 搬成共用引擎之後有兩個呼叫端，跑的是**同一份**邏輯：
 *  · 輪詢端點（使用者盯著畫面時，反應最快）
 *  · 定時維護工（`ai:advance-preview-jobs`，人走了之後接手推進）
 *
 * ⛔ 兩邊不可以各自複製一份：租約、版本鎖、暫時性錯誤重試這些規矩極細，複製出去之後
 *    只改到一邊，就會出現「同一批 OCR 被收兩次錢」那類問題（`C-46` 修過一輪）。
 */

/** 暫時性錯誤（Gemini 過載/網路）連續失敗幾次才把 job 打成終局 error */
const TRANSIENT_ERROR_LIMIT = 5

/**
 * 一次呼叫裡最多連續推進多久。
 * 使用者在等的那條路給滿（反應要快）；排程那條路給短一點——維護端點同時跑十幾項工作，
 * 不能被一份長文件綁住整個請求。
 */
export const STEP_BUDGET_MS = 22_000
export const STEP_BUDGET_MS_BACKGROUND = 15_000

export type AdvanceOutcome =
  | { status: 'done', result: ReturnType<typeof workToPreviewResult> }
  | { status: 'processing', phase: PreviewJobDoc['phase'], progress: PreviewJobDoc['progress'] }
  | { status: 'error', error: string }
  /** job 文件不存在（過期被清掉）。HTTP 端要轉成 404 */
  | { status: 'missing' }
  /** 這個 job 不屬於這個租戶。HTTP 端要轉成 403 */
  | { status: 'forbidden' }

/**
 * 推進一個 job：搶租約 → 做一個有界單位（一批 OCR／幾段切卡／總覽卡／finalize）→ 寫回進度。
 * 別人正持租約時直接回目前進度（不重複做）；被閘道掐斷的一步會在租約過期後由下一輪重接。
 */
export async function advancePreviewJob(
  db: Firestore,
  workspaceId: string,
  jobId: string,
  opts: { stepBudgetMs?: number } = {},
): Promise<AdvanceOutcome> {
  const stepBudgetMs = opts.stepBudgetMs ?? STEP_BUDGET_MS
  const ref = db.collection(KNOWLEDGE_PREVIEW_JOBS_COLLECTION).doc(jobId)

  // ── claim：transaction 內判狀態並搶租約 ───────────────────────────
  type ClaimOutcome =
    | { kind: 'done' }
    | { kind: 'error', error: string }
    | { kind: 'busy', phase: PreviewJobDoc['phase'], progress: PreviewJobDoc['progress'] }
    | { kind: 'claimed' }
    | { kind: 'missing' }
    | { kind: 'forbidden' }

  const outcome = await db.runTransaction<ClaimOutcome>(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) return { kind: 'missing' }
    const job = snap.data() as PreviewJobDoc
    if (job.workspaceId !== workspaceId) return { kind: 'forbidden' }

    if (job.status === 'done') return { kind: 'done' }
    if (job.status === 'error') return { kind: 'error', error: job.error || '處理失敗' }
    if (job.status === 'cancelled') return { kind: 'error', error: '這個匯入工作已取消' }

    const now = Date.now()
    if (job.leaseUntil && job.leaseUntil > now) {
      return { kind: 'busy', phase: job.phase, progress: job.progress }
    }
    tx.update(ref, { leaseUntil: now + JOB_LEASE_MS, status: 'processing', updatedAt: FieldValue.serverTimestamp() })
    return { kind: 'claimed' }
  })

  if (outcome.kind === 'missing') return { status: 'missing' }
  if (outcome.kind === 'forbidden') return { status: 'forbidden' }
  if (outcome.kind === 'busy') {
    return { status: 'processing', phase: outcome.phase, progress: outcome.progress }
  }
  if (outcome.kind === 'error') {
    return { status: 'error', error: outcome.error }
  }
  if (outcome.kind === 'done') {
    // 完成後再輪詢：從 work.json 重建完整結果（cleanup 前都可重取）
    const work = await loadWork(workspaceId, jobId)
    return { status: 'done', result: workToPreviewResult(work) }
  }

  // ── claimed：做「一步」 ────────────────────────────────────────────
  try {
    // 版本鎖（C-46）：釘住載入時的 generation，存檔時不符＝別的執行體已接手，
    // 放棄這一步的結果。沒有鎖的年代：兩個執行體交錯寫回會讓進度游標倒退、
    // 已付費切好的段消失重跑、token 重複入帳。
    const { work, generation } = await loadWorkWithGeneration(workspaceId, jobId)
    // undefined＝這輪拿不到版本號、不上鎖（⛔不可退回 0：那是「必須不存在」，會永久 412）
    let workGen: number | undefined = generation

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
      await saveWork(workspaceId, jobId, work, workGen)
      await ref.update({
        status: 'done',
        phase: 'done',
        progress: progressFor(work),
        leaseUntil: 0,
        transientErrors: 0,
        updatedAt: FieldValue.serverTimestamp(),
      })
      return { status: 'done', result: workToPreviewResult(work) }
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
    const startedAt = Date.now()
    const loopable = work.phase === 'chunk'
    let lastStepMs = 0
    for (;;) {
      const stepStart = Date.now()
      // 額度境域（C-45）:這一步裡的 OCR / 切卡 / 補問法 LLM 呼叫都會先過維運額度檢查
      await runWithLlmBudget(workspaceId, () => advanceWork(work, { getSourceBuffer }))
      lastStepMs = Date.now() - stepStart
      await flushJobUsage(workspaceId, work) // 每步結清:中途取消 / 逾時也不會漏記已花的 token
      workGen = await saveWork(workspaceId, jobId, work, workGen) // 見 (a):每步落地＋版本鎖,逾時只損失最後一步
      if (!loopable || work.phase !== 'chunk') break
      if (Date.now() - startedAt + lastStepMs > stepBudgetMs) break // 見 (b)
      // 續租（C-46）:連續推進多步會超過單一租約;不續租的話 90 秒一到就被下一次
      // 輪詢搶走並發重跑——正是「同批 OCR 重收費」的根源
      await ref.update({ leaseUntil: Date.now() + JOB_LEASE_MS })
    }

    await ref.update({
      phase: work.phase,
      progress: progressFor(work),
      leaseUntil: 0,
      transientErrors: 0, // 成功推進一步＝暫時性錯誤計數歸零
      updatedAt: FieldValue.serverTimestamp(),
    })
    return { status: 'processing', phase: work.phase, progress: progressFor(work) }
  }
  catch (err: any) {
    const statusCode = Number(err?.statusCode ?? err?.code ?? 0)
    const message = String(err?.statusMessage || err?.message || '處理失敗')

    // 版本鎖衝突（412）：別的執行體已接手這個 job,這一步的結果放棄即可——不是錯誤。
    if (statusCode === 412) {
      const snap = await ref.get().catch(() => null)
      const jd = snap?.data() as PreviewJobDoc | undefined
      return { status: 'processing', phase: jd?.phase ?? 'chunk', progress: jd?.progress ?? { done: 0, total: 1, label: '處理中' } }
    }

    /**
     * 錯誤分類（C-46）：Gemini 過載/網路抖動（callGemini 一律包成 502；503/504 同類）
     * 是暫時性的——原本一次 429/502 就把 job 打成**終局** error,前面十段已付的錢全作廢、
     * 只能整份重傳。改成:清租約讓下一次輪詢重接,連續 5 次才放棄。
     * 額度 429（C-45）不在此列＝直接終局,訊息本身就是使用者要的答案（等下月或聯繫調整）。
     */
    const transient = statusCode === 502 || statusCode === 503 || statusCode === 504
    if (transient) {
      const snap = await ref.get().catch(() => null)
      const jd = snap?.data() as (PreviewJobDoc & { transientErrors?: number }) | undefined
      const attempts = Number(jd?.transientErrors ?? 0) + 1
      if (attempts < TRANSIENT_ERROR_LIMIT) {
        await ref.update({
          transientErrors: attempts,
          leaseUntil: 0,
          updatedAt: FieldValue.serverTimestamp(),
        }).catch(() => {})
        return { status: 'processing', phase: jd?.phase ?? 'chunk', progress: jd?.progress ?? { done: 0, total: 1, label: '處理中（剛剛有一步沒成功，重試中）' } }
      }
    }

    await ref.update({
      status: 'error',
      error: message,
      leaseUntil: 0,
      updatedAt: FieldValue.serverTimestamp(),
    }).catch(() => {})
    return { status: 'error', error: message }
  }
}

/**
 * 定時維護工：把「沒人在看」的匯入工作往前推（`D-50` 簡化 3）。
 *
 * 這支存在的唯一理由是那句承諾要成立——「先去忙別的，整理會在背景繼續、好了會通知你」。
 * 在它之前，使用者一關視窗，工作就停在原地等他回來。
 *
 * 節制的地方（維護端點同時跑十幾項工作，這支不能拖住它）：
 *  · 一輪最多推 `maxJobs` 份，每份給較短的時間預算。
 *  · **只碰前景沒在動的**：使用者正盯著畫面輪詢的那份直接跳過，絕不跟前端搶
 *    （搶了就是同一段切兩次、收兩次錢）。判斷看「最後一次寫入距今多久」，
 *    ⛔不是只看租約——前景每步都會把租約寫回 0，見 FOREGROUND_QUIET_MS。
 *  · **只碰做完有人收的**：見 PreviewJobDoc.backgroundAdvance。
 *  · **不碰太舊的**：見 MAX_BACKGROUND_AGE_MS（否則會跟清理程式的續命邏輯互相餵養、永不過期）。
 *  · 沒有 job 時就是一次便宜的空查詢。
 *
 * ⛔ 回報一定要照實分類（見記憶 `feedback_filters_must_report_what_they_dropped`）：
 *    「掃到幾份、推了幾份、幾份剛好有人在看、幾份完成、幾份失敗」要分開算——
 *    全部併成一個數字的話，「排程其實一份都沒推動」看起來會跟「沒有工作要推」一模一樣。
 */
export async function advanceStalePreviewJobs(
  db: Firestore,
  opts: { maxJobs?: number, scanLimit?: number } = {},
): Promise<StaleJobRunReport> {
  const maxJobs = opts.maxJobs ?? 2
  const scanLimit = opts.scanLimit ?? 20
  const now = Date.now()

  // status 單欄等值查詢（走自動索引，不必開複合索引）。processing 是唯一「還要做事」的狀態：
  // done / error / cancelled 都不在這裡。量本來就小（同時進行的匯入是個位數），
  // 租約判斷放記憶體裡不會有「過濾率歸零」的問題（見記憶 project_firestore_read_cost_20260811）。
  const snap = await db.collection(KNOWLEDGE_PREVIEW_JOBS_COLLECTION)
    .where('status', '==', 'processing')
    .limit(scanLimit)
    .get()

  const picked = pickStaleJobs(
    snap.docs.map((d) => {
      const job = d.data() as PreviewJobDoc & { updatedAt?: { toMillis?: () => number }, createdAt?: { toMillis?: () => number } }
      return {
        id: d.id,
        workspaceId: job.workspaceId,
        leaseUntil: job.leaseUntil,
        backgroundAdvance: job.backgroundAdvance === true,
        updatedAtMs: typeof job.updatedAt?.toMillis === 'function' ? job.updatedAt.toMillis() : 0,
        createdAtMs: typeof job.createdAt?.toMillis === 'function' ? job.createdAt.toMillis() : 0,
      }
    }),
    now,
    maxJobs,
  )
  const { stale, leased, deferred, unusable, notEligible, tooOld } = picked
  if (notEligible > 0) {
    console.warn(`[advance-preview-jobs] ${notEligible} 份沒有開背景推進（整站每頁／重新同步），本輪不碰`)
  }
  if (tooOld > 0) {
    console.warn(`[advance-preview-jobs] ${tooOld} 份太舊（超過 ${Math.round(MAX_BACKGROUND_AGE_MS / 60_000)} 分鐘）不再推，等清理程式收掉`)
  }
  // ⛔ 被上限擋下的不能靜靜消失（見記憶 feedback_filters_must_report_what_they_dropped）：
  //    「還有 5 份排在後面」跟「沒有工作要推」在畫面與紀錄上必須長得不一樣，
  //    否則排程明明追不上，看起來卻像一切正常。
  if (deferred > 0) {
    console.warn(`[advance-preview-jobs] 這一輪推 ${stale.length} 份，還有 ${deferred} 份等下一輪（上限 ${maxJobs}）`)
  }
  if (unusable > 0) {
    console.warn(`[advance-preview-jobs] ${unusable} 份 job 沒有 workspaceId，推不了（資料異常，請查 preview jobs）`)
  }

  let advanced = 0
  let done = 0
  let failed = 0
  await Promise.all(stale.map(async ({ jobId, workspaceId }) => {
    try {
      const res = await advancePreviewJob(db, workspaceId, jobId, { stepBudgetMs: STEP_BUDGET_MS_BACKGROUND })
      advanced++
      if (res.status === 'done') done++
      if (res.status === 'error') failed++
    }
    catch (e) {
      // 這裡吞掉是刻意的（一份工作壞掉不該讓整個維護端點掛掉），但**一定要留話**：
      // 靜默的話就是「排程有在跑、工作永遠不動」而沒有人看得出來。
      failed++
      console.warn(`[advance-preview-jobs] ${jobId} 推進失敗:`, (e as Error)?.message)
    }
  }))

  return { scanned: snap.size, leased, deferred, unusable, notEligible, tooOld, advanced, done, failed }
}

/**
 * 背景推進的年齡上限。
 *
 * 為什麼一定要有：清理程式（`cleanupExpiredPreviewJobs`）看到「processing 且 30 分鐘內
 * 有寫入」就會把 expiresAt 往後延一小時——而排程每推一步都會寫 updatedAt。兩者加起來
 * 就是**永不過期**：一份使用者早就放棄的工作會被一直推、一直延命（2026-09-03 code review
 * 抓到）。過了這個年齡就不再碰它，30 分鐘後清理程式就會把它收掉。
 * ⚠️ 要小於 JOB_TTL_MS（1 小時），否則沒有意義。
 */
export const MAX_BACKGROUND_AGE_MS = 40 * 60 * 1000

/**
 * 「前景剛剛動過」的靜默期。
 *
 * ⛔ 不可以只看租約（第一版就是這樣，同輪 code review 抓到）：前景每推完一步就把
 *    `leaseUntil` 寫回 0，而前端下一次輪詢要等 1.2 秒——落在那個空檔的排程會把
 *    「使用者正盯著看的那份」當成沒人管，於是 `leased` 統計說謊（回報「沒有人在看」），
 *    而且兩個名額會被正在被觀看的匯入吃掉、真正沒人管的那些反而一直排不到。
 *    用「最後一次寫入距今多久」判斷才對得上實際行為。
 */
export const FOREGROUND_QUIET_MS = 20_000

export interface StaleJobRunReport {
  /** 掃到幾份 processing 的 job */
  scanned: number
  /** 其中幾份前景剛剛動過（使用者盯著畫面在輪詢，讓他去） */
  leased: number
  /** 沒有開背景推進的份數（整站每頁／重新同步：做完沒人收，推了純燒錢） */
  notEligible: number
  /** 太舊、不再推的份數（讓清理程式收掉，見 MAX_BACKGROUND_AGE_MS） */
  tooOld: number
  /** 該推但被本輪上限擋下、留到下一輪的份數 */
  deferred: number
  /** 資料異常推不了的份數（沒有 workspaceId） */
  unusable: number
  /** 本輪實際推進了幾份 */
  advanced: number
  /** 其中幾份推到完成 */
  done: number
  /** 其中幾份變成終局失敗（或推進時自己爆掉） */
  failed: number
}

export function pickStaleJobs(
  jobs: Array<{
    id: string
    workspaceId?: string
    leaseUntil?: number
    backgroundAdvance?: boolean
    updatedAtMs?: number
    createdAtMs?: number
  }>,
  now: number,
  maxJobs: number,
): {
    stale: Array<{ jobId: string, workspaceId: string }>
    leased: number
    deferred: number
    unusable: number
    notEligible: number
    tooOld: number
  } {
  const stale: Array<{ jobId: string, workspaceId: string, updatedAtMs: number }> = []
  let leased = 0
  let deferred = 0
  let unusable = 0
  let notEligible = 0
  let tooOld = 0

  const candidates: Array<{ id: string, workspaceId: string, updatedAtMs: number }> = []
  for (const job of jobs) {
    if (!job.workspaceId) {
      unusable++
      continue
    }
    // 沒開背景推進＝做完沒有人收（整站每頁／重新同步），碰它只是燒錢
    if (job.backgroundAdvance !== true) {
      notEligible++
      continue
    }
    // 前景剛剛動過＝使用者就盯著畫面在輪詢（⛔別只看租約，見 FOREGROUND_QUIET_MS）
    if ((job.leaseUntil && job.leaseUntil > now)
      || (job.updatedAtMs && now - job.updatedAtMs < FOREGROUND_QUIET_MS)) {
      leased++
      continue
    }
    // 太舊就放手，讓清理程式收掉（見 MAX_BACKGROUND_AGE_MS）
    if (job.createdAtMs && now - job.createdAtMs > MAX_BACKGROUND_AGE_MS) {
      tooOld++
      continue
    }
    candidates.push({ id: job.id, workspaceId: job.workspaceId, updatedAtMs: job.updatedAtMs ?? 0 })
  }

  /**
   * 「最久沒被推的先推」——公平性（2026-09-03 code review 抓到）。
   *
   * 不排序的話 Firestore 回的是文件 id（uuid）順序，於是**每一輪都挑到同樣那兩份**，
   * uuid 排在後面的工作可以永遠排不到；剛建立的還會因為 uuid 小而插到一小時前那份前面。
   * ⛔ 刻意在記憶體裡排而不是 `orderBy`：等值條件加上另一個欄位的 orderBy 要開一份
   *    複合索引（而且缺索引時整支查詢會 FAILED_PRECONDITION、這條路就整個靜靜停掉）。
   *    掃描上限只有 20 筆，排序成本可忽略。
   */
  candidates.sort((a, b) => a.updatedAtMs - b.updatedAtMs)

  for (const c of candidates) {
    // ⛔ 用 continue 不用 break：break 的話後面那幾份連分類都沒看過，deferred 會少算
    if (stale.length >= maxJobs) {
      deferred++
      continue
    }
    stale.push({ jobId: c.id, workspaceId: c.workspaceId, updatedAtMs: c.updatedAtMs })
  }
  return {
    stale: stale.map(({ jobId, workspaceId }) => ({ jobId, workspaceId })),
    leased,
    deferred,
    unusable,
    notEligible,
    tooOld,
  }
}
