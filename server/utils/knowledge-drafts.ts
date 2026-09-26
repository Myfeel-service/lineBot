/**
 * 「等你看過」的知識卡（`C-250`③，`D-97`：①要 ②先到 50 ③一張張看）。
 *
 * 卡是開帳讀網站時整理出來的（`store-profile-jobs.ts` 的 advanceSiteCards），狀態 `draft`：
 *   - 試答模式讀得到（畫面會標明「這句還不會對客人講」）
 *   - ⛔ LINE 對客人只用 `indexed`——**點頭只有這一支**（adoptDrafts）
 *   - 不算額度；採用才算。額度不夠時**收到滿為止**，剩下的留著、講清楚還有幾張
 *     （⛔ 不再是「整批 403、一張都拿不到、還叫新帳號刪掉不需要的」，`D-97` 浮出來的那件事）
 *   - 刪掉＝真刪（沒點頭過的提案不進回收桶）
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { KNOWLEDGE_CHUNKS_COLLECTION, buildEmbeddingText, runIndexOnChunk } from '~~/server/utils/ai-knowledge-chunks'
import { KNOWLEDGE_SOURCES_COLLECTION, countSourceChunks } from '~~/server/utils/ai-knowledge-sources'
import { getKnowledgeChunkQuota, invalidateKnowledgeChunkCount, type KnowledgeChunkQuotaStatus } from '~~/server/utils/ai-knowledge-quota'
import { getSiteCardsJobId, loadStoreProfileJob, type SiteCardsState } from '~~/server/utils/store-profile-jobs'

/** 一次最多列幾張（開帳上限 50，留餘裕給之後別的來源也產草稿） */
const MAX_LIST = 200

export interface DraftCard {
  id: string
  title: string
  content: string
  questions: string[]
  /** ⚠️ 要回傳：畫面改字存檔走 `PUT /api/ai/knowledge/[id]`，那支沒帶 tags 會把標籤洗成空的 */
  tags: string[]
}

export interface DraftPage {
  sourceId: string
  name: string
  url: string
  cards: DraftCard[]
}

export interface DraftsOverview {
  total: number
  pages: DraftPage[]
  /** 整理卡的工作還在不在、做到哪（知識庫頁要講得出「還在整理第 3／5 頁」與「有 N 張沒整理進來」） */
  generating: (Omit<SiteCardsState, 'leaseUntil' | 'leaseId' | 'pending'>) | null
  /** 額度（全收會用掉幾張要在按下去之前看得到）；null＝方案讀不到 */
  quota: KnowledgeChunkQuotaStatus | null
}

/** 整理進度（對外那一份：⛔ 不帶租約與切好還沒建的卡——那是內部狀態，而且 pending 一次最多 15 張全文） */
async function siteCardsProgress(workspaceId: string, db: Firestore): Promise<DraftsOverview['generating']> {
  const jobId = await getSiteCardsJobId(workspaceId, db).catch(() => '')
  if (!jobId) return null
  const job = await loadStoreProfileJob(jobId, db).catch(() => null)
  if (!job?.cards || job.workspaceId !== workspaceId) return null
  const { leaseUntil: _l, leaseId: _i, pending: _p, ...rest } = job.cards
  return rest
}

/**
 * 只要張數與進度（小幫手面板、落地導覽用）：⛔ 不讀卡片全文。
 * 2026-09-26 code review：小幫手每次打開面板都打整支 `listDrafts`（最多讀 200 張全文＋來源＋額度）只為了一個數字。
 */
export async function countDrafts(workspaceId: string, db: Firestore = getDb()): Promise<{ total: number, generating: DraftsOverview['generating'] }> {
  const agg = await db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .where('status', '==', 'draft')
    .count()
    .get()
  return { total: agg.data().count, generating: await siteCardsProgress(workspaceId, db) }
}

export async function listDrafts(workspaceId: string, db: Firestore = getDb()): Promise<DraftsOverview> {
  const snap = await db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .where('status', '==', 'draft')
    .limit(MAX_LIST)
    .get()

  const bySource = new Map<string, DraftCard[]>()
  for (const d of snap.docs) {
    const c = d.data()
    const sid = String(c.sourceId ?? '')
    const list = bySource.get(sid) ?? []
    list.push({
      id: d.id,
      title: String(c.title ?? ''),
      content: String(c.content ?? ''),
      questions: Array.isArray(c.questions) ? c.questions.map(String) : [],
      tags: Array.isArray(c.tags) ? c.tags.map(String) : [],
    })
    bySource.set(sid, list)
  }

  const sourceIds = [...bySource.keys()].filter(Boolean)
  const sourceDocs = sourceIds.length
    ? await db.getAll(...sourceIds.map(id => db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(id)))
    : []
  const pages: DraftPage[] = []
  for (const s of sourceDocs) {
    const data = s.data()
    // ⛔ 別家的來源（資料異常）不列：卡的 workspaceId 已經對過，來源再對一次
    if (!s.exists || data?.workspaceId !== workspaceId) continue
    pages.push({ sourceId: s.id, name: String(data.name ?? ''), url: String(data.url ?? ''), cards: bySource.get(s.id) ?? [] })
  }
  const orphan = bySource.get('')
  if (orphan?.length) pages.push({ sourceId: '', name: '其他', url: '', cards: orphan })

  return {
    total: snap.size,
    pages,
    generating: await siteCardsProgress(workspaceId, db),
    quota: await getKnowledgeChunkQuota(workspaceId, db).catch(() => null),
  }
}

export interface AdoptResult {
  adopted: string[]
  /** 因為額度滿了沒收的（⛔ 要講得出幾張，不可以靜靜只收一部分） */
  leftForQuota: string[]
  /** 不是這個帳號的、或早就不是等你看過的（重按、別的分頁先按了） */
  skipped: string[]
  quota: KnowledgeChunkQuotaStatus | null
}

/**
 * 點頭：draft → indexed（沒向量就當場補算）。**收到滿為止**。
 * ⚠️ 額度一次讀、一次算：同一秒兩個分頁同時按全收，最壞多收幾張——跟既有建卡守門同一個取捨
 *    （`assertKnowledgeChunkQuota` 也是先讀再寫），不值得為此上交易。
 */
export async function adoptDrafts(workspaceId: string, chunkIds: string[], db: Firestore = getDb()): Promise<AdoptResult> {
  const ids = [...new Set(chunkIds.map(String).filter(Boolean))].slice(0, MAX_LIST)
  const refs = ids.map(id => db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(id))
  const snaps = ids.length ? await db.getAll(...refs) : []
  const eligible = snaps.filter(s => s.exists && s.data()?.workspaceId === workspaceId && s.data()?.status === 'draft')
  const skipped = snaps.filter(s => !eligible.includes(s)).map(s => s.id)

  const quota = await getKnowledgeChunkQuota(workspaceId, db).catch(() => null)
  const room = !quota || quota.limit == null ? eligible.length : Math.max(0, quota.limit - quota.used)
  const take = eligible.slice(0, room)
  const leftForQuota = eligible.slice(room).map(s => s.id)

  const adopted: string[] = []
  for (const s of take) {
    const c = s.data()!
    if (c.embedding) {
      await s.ref.update({ status: 'indexed', updatedAt: FieldValue.serverTimestamp() })
    }
    else {
      // 整理時向量沒算成（例如當時額度擋下）：先落 pending 再算——算不成就是 failed，排程會重試
      await s.ref.update({ status: 'pending', updatedAt: FieldValue.serverTimestamp() })
      await runIndexOnChunk(db, s.id, buildEmbeddingText(String(c.title ?? ''), String(c.content ?? ''), Array.isArray(c.questions) ? c.questions : []), workspaceId)
    }
    adopted.push(s.id)
  }
  invalidateKnowledgeChunkCount(workspaceId)
  return {
    adopted,
    leftForQuota,
    skipped,
    quota: adopted.length ? await getKnowledgeChunkQuota(workspaceId, db).catch(() => quota) : quota,
  }
}

/** 刪掉沒點頭的卡（真刪）；那一頁的卡都刪光了，那一頁的資料也一起收掉（⛔ 不留一份 0 張的空殼在側欄） */
export async function dismissDrafts(workspaceId: string, chunkIds: string[], db: Firestore = getDb()): Promise<{ dismissed: string[], skipped: string[] }> {
  const ids = [...new Set(chunkIds.map(String).filter(Boolean))].slice(0, MAX_LIST)
  const snaps = ids.length ? await db.getAll(...ids.map(id => db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(id))) : []
  const eligible = snaps.filter(s => s.exists && s.data()?.workspaceId === workspaceId && s.data()?.status === 'draft')
  const skipped = snaps.filter(s => !eligible.includes(s)).map(s => s.id)
  const batch = db.batch()
  const touchedSources = new Set<string>()
  for (const s of eligible) {
    batch.delete(s.ref)
    const sid = String(s.data()?.sourceId ?? '')
    if (sid) touchedSources.add(sid)
  }
  if (eligible.length) await batch.commit()
  for (const sid of touchedSources) {
    const left = await countSourceChunks(db, workspaceId, sid).catch(() => -1)
    const ref = db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sid)
    if (left === 0) {
      const src = await ref.get()
      // ⛔ 只收開帳整理出來的那種來源：店家自己建的資料就算 0 張也是他的
      if (src.exists && src.data()?.workspaceId === workspaceId && src.data()?.origin === 'onboarding-site') await ref.delete()
    }
    else if (left > 0) {
      await ref.update({ chunkCount: left, updatedAt: FieldValue.serverTimestamp() }).catch(() => {})
    }
  }
  invalidateKnowledgeChunkCount(workspaceId)
  return { dismissed: eligible.map(s => s.id), skipped }
}
