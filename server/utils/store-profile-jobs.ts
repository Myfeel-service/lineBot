/**
 * 「讀網站建輪廓」的非同步工作（`D-85` / `C-220`）。
 *
 * ── 為什麼要做成 job ──────────────────────────────────────────
 * 讀 5 頁最壞情況是 5 × 15 秒，再加一次 LLM——同步做一定撞閘道逾時
 * （知識庫匯入 504 就是這個坑，[[project_knowledge_import_504]]）。
 * ⛔ 也不可以「回應送出後繼續在背景做」：Lambda 回應一送出容器就可能凍結，
 *    事情做到一半沒人知道（[[project_broadcast_stuck_processing_20260813]]）。
 *
 * 所以沿用知識庫預覽那一套：**每次輪詢推進一步**，每一步都遠小於逾時。
 * 一步＝抓一頁，最後一步＝丟給模型抽輪廓。
 *
 * ⛔ 沒有排程可用（Amplify 不跑 scheduledTasks），過期清掃綁在流量上機會性地做。
 */

import { createHash, randomUUID } from 'node:crypto'
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { chunkSegment, SEGMENT_CHAR_LEN } from '~~/server/utils/ai-knowledge-chunker'
import { createKnowledgeChunk } from '~~/server/utils/ai-knowledge-chunks'
import { KNOWLEDGE_SOURCES_COLLECTION } from '~~/server/utils/ai-knowledge-sources'
import { invalidateKnowledgeChunkCount } from '~~/server/utils/ai-knowledge-quota'
import { assertMaintenanceBudget, recordAiUsage } from '~~/server/utils/ai-usage'
import { runWithLlmBudget } from '~~/server/utils/gemini'
import {
  classifyFetchError,
  extractProfileFromPages,
  fetchOneProfilePage,
  MAX_PROFILE_PAGES,
  rankProfilePages,
  type FetchedPage,
} from '~~/server/utils/store-profile-extract'
import { getStoreProfile, saveStoreProfile } from '~~/server/utils/store-profile'
import {
  mergeAiGuesses,
  normalizeSiteUrl,
  type SiteReadFailReason,
  type SiteReadResult,
  type StoreProfileFieldId,
} from '~~/shared/types/store-profile'

export const STORE_PROFILE_JOBS_COLLECTION = 'storeProfileJobs'
/** 工作保留多久（人跑去接 LINE 了，7 分鐘後才回來看結果是常態） */
export const STORE_PROFILE_JOB_TTL_MS = 60 * 60 * 1000

export type StoreProfileJobStatus = 'running' | 'done' | 'failed'

export interface StoreProfileJobDoc {
  workspaceId: string
  siteUrl: string
  status: StoreProfileJobStatus
  /** 還沒抓的頁（第一步結束後才有值） */
  queue: string[]
  /** 抓到的頁 */
  pages: FetchedPage[]
  /** 抓不到的頁 */
  failed: { url: string, reason: SiteReadFailReason }[]
  /** 已經抓過幾頁（給進度用；不等於 pages.length，失敗的也算走過） */
  visited: number
  /** 完成時：模型猜到的東西 */
  guesses?: Partial<Record<StoreProfileFieldId, string>>
  /** 完成時：三態的讀取結果 */
  siteRead?: SiteReadResult
  /** 失敗時講得出原因（給人看的一句話） */
  error?: string
  /**
   * 讀完的頁接著整理成「等你看過」的知識卡（`C-250`③，`D-97` 拍板「要」）。
   * 輪廓抽完才開始；沒有這一格＝這份工作不整理卡（舊工作、或讀不到任何一頁）。
   */
  cards?: SiteCardsState
  createdAt: Timestamp | FieldValue
  updatedAt: Timestamp | FieldValue
  expiresAt: Timestamp
}

/** 對外的進度形狀（前端只認這個，不直接吃 Firestore 文件） */
export interface StoreProfileJobProgress {
  jobId: string
  status: StoreProfileJobStatus
  /** 0–100 */
  percent: number
  /** 這一刻在做什麼，講給人看的一句話 */
  phaseText: string
  siteRead?: SiteReadResult
  error?: string
}

function jobRef(db: Firestore, jobId: string) {
  return db.collection(STORE_PROFILE_JOBS_COLLECTION).doc(jobId)
}

/** 建立工作。**第一頁在這裡就抓**——抓不到要當場講，不要讓人輪詢半天才知道網址打錯。 */
export async function createStoreProfileJob(
  workspaceId: string,
  rawUrl: string,
  jobId: string,
  db: Firestore = getDb(),
): Promise<{ job: StoreProfileJobDoc, progress: StoreProfileJobProgress }> {
  const siteUrl = normalizeSiteUrl(rawUrl)
  const now = Date.now()

  const base: StoreProfileJobDoc = {
    workspaceId,
    siteUrl,
    status: 'running',
    queue: [],
    pages: [],
    failed: [],
    visited: 0,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    expiresAt: Timestamp.fromMillis(now + STORE_PROFILE_JOB_TTL_MS),
  }

  if (!siteUrl) {
    const job: StoreProfileJobDoc = {
      ...base,
      status: 'failed',
      error: '這看起來不像一個網址',
      siteRead: { status: 'failed', pagesRead: 0, pagesFailed: [], reason: 'not_found', at: now },
    }
    await jobRef(db, jobId).set(job)
    return { job, progress: toProgress(jobId, job) }
  }

  // 第一頁在建立時就抓：網址打錯、對方擋人這種事要在他還看著畫面的時候講
  const first = await fetchOneProfilePage(siteUrl)
  const job: StoreProfileJobDoc = { ...base }
  if (first.ok) {
    job.pages = [{ url: siteUrl, text: first.text }]
    job.queue = rankProfilePages(first.text, first.finalUrl || siteUrl, MAX_PROFILE_PAGES - 1).map(p => p.url)
  }
  else {
    job.failed = [{ url: siteUrl, reason: first.reason }]
  }
  job.visited = 1

  await jobRef(db, jobId).set(job)
  return { job, progress: toProgress(jobId, job) }
}

export async function loadStoreProfileJob(jobId: string, db: Firestore = getDb()): Promise<StoreProfileJobDoc | null> {
  const snap = await jobRef(db, jobId).get()
  if (!snap.exists) return null
  return snap.data() as StoreProfileJobDoc
}

/**
 * 推進一步。回傳推進後的進度。
 *
 * 一步 = 抓一頁；佇列空了就做最後一步（丟模型、併進輪廓、存檔）。
 * ⛔ 一次只做一步：兩步併一步就等於把逾時風險加倍，而這支的全部意義就是不要逾時。
 */
export async function advanceStoreProfileJob(
  jobId: string,
  job: StoreProfileJobDoc,
  db: Firestore = getDb(),
): Promise<StoreProfileJobProgress> {
  if (job.status !== 'running') return toProgress(jobId, job)

  const next: StoreProfileJobDoc = { ...job }

  // 還有頁要抓 → 抓一頁就回
  if (next.queue.length > 0 && next.pages.length < MAX_PROFILE_PAGES) {
    const url = next.queue[0]!
    next.queue = next.queue.slice(1)
    next.visited = (next.visited ?? 0) + 1
    const r = await fetchOneProfilePage(url)
    if (r.ok) next.pages = [...next.pages, { url, text: r.text }]
    else next.failed = [...next.failed, { url, reason: r.reason }]

    await jobRef(db, jobId).set({
      queue: next.queue,
      pages: next.pages,
      failed: next.failed,
      visited: next.visited,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
    return toProgress(jobId, next)
  }

  // 最後一步：抽輪廓並落地
  const at = Date.now()
  const siteRead: SiteReadResult = {
    status: next.pages.length === 0 ? 'failed' : next.failed.length > 0 ? 'partial' : 'ok',
    pagesRead: next.pages.length,
    pagesFailed: next.failed.slice(0, 20),
    ...(next.pages.length === 0 ? { reason: next.failed[0]?.reason ?? 'unknown' } : {}),
    at,
  }

  if (next.pages.length === 0) {
    next.status = 'failed'
    next.siteRead = siteRead
    next.error = '你的網站我一頁都讀不到'
    await persistSiteRead(next.workspaceId, siteRead, db)
    await jobRef(db, jobId).set({ status: 'failed', siteRead, error: next.error, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    return toProgress(jobId, next)
  }

  try {
    const { guesses } = await extractProfileFromPages(next.pages)
    // 併進輪廓：⛔ 商家改過的欄位一律跳過（那是 mergeAiGuesses 的責任，這裡不繞過它）
    const profile = await getStoreProfile(next.workspaceId, db)
    const merged = mergeAiGuesses(profile, guesses, at)
    merged.profile.siteRead = siteRead
    if (!merged.profile.siteUrl) merged.profile.siteUrl = next.siteUrl
    await saveStoreProfile(next.workspaceId, merged.profile, db)

    next.status = 'done'
    next.guesses = guesses
    next.siteRead = siteRead
    // ⭐ 接著把讀到的頁整理成「等你看過」的卡（`C-250`③）。⛔ 不在這一步做：這一步已經花了一次 LLM，
    //    再疊上切卡一定撞逾時——整理卡是另一條「每次推一步」的路（advanceSiteCards）。
    //    ⚠️ 頁面內文要留到卡整理完：工作保留期從 1 小時延到 1 天（排程每 10 分鐘會補推）。
    next.cards = { status: 'queued', pagesDone: 0, pagesTotal: next.pages.length, cards: 0, trimmed: 0, pagesFailed: [] }
    await jobRef(db, jobId).set({
      status: 'done',
      guesses,
      siteRead,
      cards: next.cards,
      expiresAt: Timestamp.fromMillis(Date.now() + SITE_CARDS_JOB_TTL_MS),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
    await setSiteCardsJobId(next.workspaceId, jobId, db)
  }
  catch (err) {
    // 模型掛掉 ≠ 網站讀不到：讀到的頁數照實記，錯誤另外講
    next.status = 'failed'
    next.siteRead = siteRead
    next.error = `讀到了 ${next.pages.length} 頁，但整理的時候出了問題`
    await persistSiteRead(next.workspaceId, siteRead, db)
    await jobRef(db, jobId).set({ status: 'failed', siteRead, error: next.error, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    console.error('[store-profile] extract failed', classifyFetchError(err), err)
  }
  return toProgress(jobId, next)
}

/** 讀取結果本身要落地：就算模型掛了，「我讀了幾頁、哪幾頁讀不到」也不該消失。 */
async function persistSiteRead(workspaceId: string, siteRead: SiteReadResult, db: Firestore) {
  try {
    const profile = await getStoreProfile(workspaceId, db)
    profile.siteRead = siteRead
    await saveStoreProfile(workspaceId, profile, db)
  }
  catch { /* 這是加分項，失敗不影響 job 本身的結論 */ }
}

export function toProgress(jobId: string, job: StoreProfileJobDoc): StoreProfileJobProgress {
  const total = Math.max(1, Math.min(MAX_PROFILE_PAGES, (job.visited ?? 0) + job.queue.length))
  const percent = job.status === 'done'
    ? 100
    : job.status === 'failed'
      ? 100
      : Math.min(90, Math.round(((job.visited ?? 0) / (total + 1)) * 100))
  return {
    jobId,
    status: job.status,
    percent,
    phaseText: phaseText(job),
    ...(job.siteRead ? { siteRead: job.siteRead } : {}),
    ...(job.error ? { error: job.error } : {}),
  }
}

function phaseText(job: StoreProfileJobDoc): string {
  if (job.status === 'failed') return job.error || '讀不到你的網站'
  if (job.status === 'done') return '讀完了'
  if (job.queue.length > 0) return `正在讀你的網站（第 ${(job.visited ?? 0) + 1} 頁）`
  return '正在整理讀到的內容'
}

/**
 * 機會性清掃過期工作（Amplify 上沒有排程可用）。
 * ⛔ fire-and-forget，呼叫端不要 await——清掃失敗不該讓建立工作變慢或失敗。
 */
export async function cleanupExpiredStoreProfileJobs(db: Firestore = getDb(), limit = 20): Promise<number> {
  const snap = await db.collection(STORE_PROFILE_JOBS_COLLECTION)
    .where('expiresAt', '<', Timestamp.now())
    .limit(limit)
    .get()
  if (snap.empty) return 0
  const batch = db.batch()
  snap.docs.forEach(d => batch.delete(d.ref))
  await batch.commit()
  return snap.size
}

// ═══════════════════════════════════════════════════════════════════
//  讀到的頁 → 「等你看過」的知識卡（`C-250`③，`D-97`：①要 ②先到 50 ③一張張看）
//
//  為什麼要有：開帳讀了 5 頁，原本只抽 9 格輪廓就把內文丟掉——「整理成知識卡」是一句
//  沒有人在做的承諾（2026-09-24 老闆第三次追問「知識卡內被建立了什麼」時查到）。
//  ⛔ 卡**不直接上線**：寫成 `draft`，他在知識庫一張一張點頭才變 `indexed`、才對客人講話。
//  ⛔ 每次推一步（一步最多 2 頁，各一次切卡 LLM）：跟讀網站同一個理由，一次做完一定撞逾時。
//  推進的人有三個：精靈（他在採用草稿時背景推）、知識庫頁（打開時推）、排程（每 10 分鐘補推）。
// ═══════════════════════════════════════════════════════════════════

export interface SiteCardsState {
  status: 'queued' | 'running' | 'done' | 'failed'
  /** 走過幾頁（整理出卡、或整理不出來都算走過） */
  pagesDone: number
  pagesTotal: number
  /** 建了幾張卡 */
  cards: number
  /**
   * 因為張數上限沒放進來的張數。⛔ 一定要記、要講：過濾掉東西要說得出丟了什麼
   * （記憶 `feedback_filters_must_report_what_they_dropped`）。
   */
  trimmed: number
  /** 整理不出卡的頁（網址＋一句原因） */
  pagesFailed: { url: string, reason: string }[]
  /** 正在推的那一次拿著的租約（epoch ms）；過期就當沒人在推 */
  leaseUntil?: number
  error?: string
}

/** 卡整理完之前，工作（含頁面內文）要留多久 */
export const SITE_CARDS_JOB_TTL_MS = 24 * 60 * 60 * 1000
/** 一步最多整理幾頁（並行；一頁一次切卡約 15–25 秒，兩頁並行仍在閘道逾時內） */
export const SITE_CARDS_PAGES_PER_STEP = 2
/**
 * 開帳這一趟最多整理幾張（`D-97` ②「先到 50」＝免費方案的總額度）。
 * ⚠️ 同一個網址匯兩次可以是 11 張或 92 張（`D-97` 實測），張數不穩——所以要封頂，
 *    而且超過的張數照實記（`trimmed`），畫面講得出「還有 N 張沒整理進來」。
 */
export const SITE_CARDS_MAX_TOTAL = 50
/** 一頁最多幾張（別讓一頁長長的商品清單吃掉整個上限，其他頁一張都沒有） */
export const SITE_CARDS_MAX_PER_PAGE = 15
const SITE_CARDS_LEASE_MS = 90_000

/** 輪廓那一份記著「整理卡的工作是哪一份」（知識庫頁靠它找得到進度；⛔ 不經 saveStoreProfile，免得被整份覆寫洗掉） */
export async function setSiteCardsJobId(workspaceId: string, jobId: string, db: Firestore = getDb()) {
  await db.collection('storeProfiles').doc(workspaceId).set({ siteCardsJobId: jobId }, { merge: true }).catch(() => {})
}

export async function getSiteCardsJobId(workspaceId: string, db: Firestore = getDb()): Promise<string> {
  const snap = await db.collection('storeProfiles').doc(workspaceId).get()
  return String(snap.data()?.siteCardsJobId ?? '')
}

/**
 * 這一頁在知識庫要叫什麼（「來自『○○』那一頁」）。
 * 首頁叫首頁；網址最後一段有中文就用它；英文代號（`/products/123`）看不懂，退回第一張卡的標題。
 */
export function sitePageLabel(url: string, firstCardTitle = ''): string {
  let path = ''
  try {
    path = new URL(url).pathname
  }
  catch { /* 網址壞掉就用卡片標題 */ }
  const segs = path.split('/').filter(Boolean)
  if (segs.length === 0) return '首頁'
  let last = segs.at(-1) ?? ''
  try {
    last = decodeURIComponent(last)
  }
  catch { /* 解不開就用原字 */ }
  last = last.replace(/\.(html?|php|aspx?)$/i, '').replace(/[-_]+/g, ' ').trim()
  if (/[一-鿿]/.test(last)) return last.slice(0, 30)
  const title = firstCardTitle.trim()
  return (title || last || '網站其中一頁').slice(0, 30)
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * 推進一步：拿租約 → 整理最多 2 頁 → 寫成等你看過的卡 → 放租約。
 * 回傳推完之後的狀態（沒有要做的事就原樣回）。
 * ⛔ 拿不到租約（別人正在推）就直接回，**不可以兩邊同時整理同一頁**（同一頁切兩次＝收兩次錢、卡建兩份）。
 */
export async function advanceSiteCards(jobId: string, db: Firestore = getDb()): Promise<SiteCardsState | null> {
  const ref = jobRef(db, jobId)
  const now = Date.now()
  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) return null
    const job = snap.data() as StoreProfileJobDoc
    const cards = job.cards
    if (!cards || cards.status === 'done' || cards.status === 'failed') return { job, claimed: false }
    if (cards.leaseUntil && cards.leaseUntil > now) return { job, claimed: false }
    tx.update(ref, { 'cards.status': 'running', 'cards.leaseUntil': now + SITE_CARDS_LEASE_MS, updatedAt: FieldValue.serverTimestamp() })
    return { job, claimed: true }
  })
  if (!claimed) return null
  const { job } = claimed
  if (!claimed.claimed) return job.cards ?? null

  const state: SiteCardsState = { ...job.cards!, status: 'running', pagesFailed: [...(job.cards!.pagesFailed ?? [])] }
  const wid = job.workspaceId
  const todo = job.pages.slice(state.pagesDone, state.pagesDone + SITE_CARDS_PAGES_PER_STEP)

  try {
    // 維運額度用完就停在這裡：⛔ 不算失敗（下個月額度回來、或升級之後照樣推得動）
    await assertMaintenanceBudget(wid)
    let room = Math.max(0, SITE_CARDS_MAX_TOTAL - state.cards)
    const results = await runWithLlmBudget(wid, () => Promise.all(todo.map(async (page) => {
      try {
        const r = await chunkSegment(page.text.slice(0, SEGMENT_CHAR_LEN), `開帳時讀的網站頁面：${page.url}`)
        return { page, ok: true as const, ...r }
      }
      catch (e) {
        return { page, ok: false as const, reason: String((e as Error)?.message || '整理失敗').slice(0, 120) }
      }
    })))

    let inputTokens = 0
    let outputTokens = 0
    let embeddingTokens = 0
    for (const r of results) {
      if (!r.ok) {
        state.pagesFailed.push({ url: r.page.url, reason: r.reason })
        continue
      }
      inputTokens += r.inputTokens
      outputTokens += r.outputTokens
      const perPage = r.chunks.slice(0, SITE_CARDS_MAX_PER_PAGE)
      const keep = perPage.slice(0, room)
      state.trimmed += r.chunks.length - keep.length
      room -= keep.length
      if (!keep.length) {
        if (!r.chunks.length) state.pagesFailed.push({ url: r.page.url, reason: '這一頁整理不出可以回答客人的內容' })
        continue
      }
      // 一頁一份資料（知識庫側欄看得到「首頁」「黑豆水」那幾份），卡掛在它底下
      const sourceId = randomUUID()
      const nowTs = FieldValue.serverTimestamp()
      await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).set({
        workspaceId: wid,
        type: 'url',
        name: sitePageLabel(r.page.url, keep[0]?.title),
        url: r.page.url,
        folderId: null,
        filePath: '',
        contentHash: sha256(r.page.text),
        appliedContentHash: sha256(r.page.text),
        etag: '',
        lastModified: '',
        refreshIntervalSec: 0,
        // ⛔ 不排自動同步：這幾份是開帳讀的、他還沒點頭；同步偵測到變動會跑去問他一件他還沒答應要的事
        refreshIntervalMinutes: 0,
        onChangeBehavior: 'notify',
        generateOverview: false,
        lastFetchedAt: nowTs,
        outdatedAt: null,
        status: 'ready',
        isDeleted: false,
        chunkCount: keep.length,
        /** 這份資料是開帳讀網站整理出來的（知識庫「等你看過」那一區靠它分組） */
        origin: 'onboarding-site',
        createdAt: nowTs,
        updatedAt: nowTs,
      })
      for (const c of keep) {
        const made = await createKnowledgeChunk(db, {
          workspaceId: wid,
          chunkId: randomUUID(),
          title: c.title,
          content: c.content,
          tags: c.tags,
          questions: c.questions,
          sourceId,
          skipUsageRecording: true,
          draft: true,
        })
        embeddingTokens += made.embeddingTokens
        state.cards++
      }
    }
    state.pagesDone += todo.length
    // ⚠️ 花掉的錢照實入帳（`D-89`：開帳讀網站原本那一次 LLM 沒入帳，這裡不重蹈覆轍）
    if (inputTokens || outputTokens) {
      await recordAiUsage(wid, { inputTokens, outputTokens, importInputTokens: inputTokens, importOutputTokens: outputTokens }, db)
    }
    if (embeddingTokens) await recordAiUsage(wid, { buildEmbeddingTokens: embeddingTokens }, db)
    state.status = state.pagesDone >= state.pagesTotal ? 'done' : 'queued'
  }
  catch (e) {
    const code = Number((e as { statusCode?: number })?.statusCode)
    // 429＝維運額度擋下：停在原地等（不算失敗、不前進）；其他錯誤＝這一步的頁算走過但記原因
    if (code === 429) {
      state.status = 'queued'
      state.error = '這個月的整理額度用完了，下個月會接著整理'
    }
    else {
      for (const p of todo) state.pagesFailed.push({ url: p.url, reason: String((e as Error)?.message || '整理失敗').slice(0, 120) })
      state.pagesDone += todo.length
      state.status = state.pagesDone >= state.pagesTotal ? 'done' : 'queued'
    }
  }

  const { leaseUntil: _lease, ...toSave } = state
  await ref.set({ cards: { ...toSave, leaseUntil: 0 }, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  invalidateKnowledgeChunkCount(wid)
  return { ...toSave, leaseUntil: 0 }
}

/**
 * 排程補推（`/api/cron/run-tasks`，每 10 分鐘）。精靈只盯 20 秒、之後就沒人輪詢——
 * 沒有這一支的話，讀網站卡在半路就永遠卡在半路（「讀完會補進組織頁」那句話沒人兌現），
 * 整理卡也只有他剛好打開知識庫才會動。
 * ⛔ 一輪最多推 `maxJobs` 份；前景剛動過的（有人盯著）讓他去，跟預覽匯入的排程同一個規矩。
 * ⛔ 回報要分類照實講（掃到幾份、推了幾份、幾份有人在看）。
 */
export async function advanceStaleStoreProfileJobs(db: Firestore = getDb(), maxJobs = 2) {
  const now = Date.now()
  const [reading, carding] = await Promise.all([
    db.collection(STORE_PROFILE_JOBS_COLLECTION).where('status', '==', 'running').limit(10).get(),
    db.collection(STORE_PROFILE_JOBS_COLLECTION).where('cards.status', 'in', ['queued', 'running']).limit(10).get(),
  ])
  const quiet = (d: FirebaseFirestore.QueryDocumentSnapshot) => {
    const u = (d.data().updatedAt as Timestamp | undefined)?.toMillis?.() ?? 0
    return now - u > 20_000
  }
  const readJobs = reading.docs.filter(quiet)
  const cardJobs = carding.docs.filter(d => quiet(d) && !(((d.data().cards as SiteCardsState | undefined)?.leaseUntil ?? 0) > now))
  let advancedRead = 0
  let advancedCards = 0
  const picked = [...readJobs.map(d => ({ d, kind: 'read' as const })), ...cardJobs.map(d => ({ d, kind: 'cards' as const }))].slice(0, maxJobs)
  await Promise.all(picked.map(async ({ d, kind }) => {
    try {
      if (kind === 'read') {
        await advanceStoreProfileJob(d.id, d.data() as StoreProfileJobDoc, db)
        advancedRead++
      }
      else {
        await advanceSiteCards(d.id, db)
        advancedCards++
      }
    }
    catch (e) {
      console.warn(`[store-profile-jobs] 排程推 ${d.id} 失敗:`, (e as Error)?.message)
    }
  }))
  const expired = await cleanupExpiredStoreProfileJobs(db).catch(() => 0)
  return {
    readingScanned: reading.size,
    cardsScanned: carding.size,
    busy: reading.size - readJobs.length + carding.size - cardJobs.length,
    deferred: readJobs.length + cardJobs.length - picked.length,
    advancedRead,
    advancedCards,
    expired,
  }
}
