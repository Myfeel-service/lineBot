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

import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
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
    await jobRef(db, jobId).set({ status: 'done', guesses, siteRead, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
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
