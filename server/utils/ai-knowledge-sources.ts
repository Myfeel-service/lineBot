/**
 * knowledgeSources 服務層：CRUD + 簡單列表查詢。
 *
 * Source = 「匯入的來源」（PDF / 網址 / 手打）。每個 source 自動切出多張 chunk，
 * chunk.sourceId 指回 source.id。手打單卡（type='manual'）也可有 source 把它們群組起來。
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import {
  addWorkspaceProductName,
  invalidateSourceProductCache,
  invalidateTagIndexCache,
  KNOWLEDGE_CHUNKS_COLLECTION,
} from './ai-knowledge-chunks'
import type {
  KnowledgeSourceDoc,
  KnowledgeSourceStatus,
  KnowledgeSourceType,
} from '~~/shared/types/ai-knowledge'

export const KNOWLEDGE_SOURCES_COLLECTION = 'knowledgeSources'

// ── Catalog source ids cache ──────────────────────────────────────
// 「型錄/列表來源」(generateOverview=true) 旗下有很多*不同產品*共用同一個 sourceId。
// 答題時 dedupeBySource 不該把它們當「同主題」併掉，所以需要快速查出哪些 sourceId 是型錄。
// 小量資料 + 答題熱路徑，快取 60s 避免每次答題多打 Firestore。
const CATALOG_SRC_TTL_MS = 60_000
const catalogSrcCache = new Map<string, { expiresAt: number; ids: Set<string> }>()

export function invalidateCatalogSourceCache(workspaceId: string) {
  catalogSrcCache.delete(workspaceId)
}

/**
 * 回傳此 workspace 中「型錄/列表來源」(generateOverview=true) 的 sourceId 集合。
 * 通用——只看 generateOverview 旗標，不綁任何特定站台/租戶。
 */
export async function getCatalogSourceIds(
  db: Firestore,
  workspaceId: string,
): Promise<Set<string>> {
  const cached = catalogSrcCache.get(workspaceId)
  if (cached && cached.expiresAt > Date.now()) return cached.ids

  const ids = new Set<string>()
  try {
    // 只用 workspaceId 過濾（單欄位、免複合索引），generateOverview 在程式端篩。
    // 加上限：型錄來源本來就少，避免在答題熱路徑做無上限讀取。
    const snap = await db.collection(KNOWLEDGE_SOURCES_COLLECTION)
      .where('workspaceId', '==', workspaceId)
      .limit(200)
      .get()
    for (const d of snap.docs) {
      if (d.data()?.generateOverview === true) ids.add(d.id)
    }
  }
  catch (e) {
    // 查詢失敗（缺 index 等）不擋答題：回空集合 = 維持舊行為（全部 dedupe）
    console.warn('[ai-knowledge-sources] getCatalogSourceIds failed:', e)
  }
  catalogSrcCache.set(workspaceId, { expiresAt: Date.now() + CATALOG_SRC_TTL_MS, ids })
  return ids
}

export interface SourceSummary {
  id: string
  type: KnowledgeSourceType
  name: string
  url: string
  /** 所屬資料夾；null = 未分類 */
  folderId: string | null
  status: KnowledgeSourceStatus
  failureReason?: string
  chunkCount: number
  refreshIntervalMinutes: number
  onChangeBehavior: 'notify' | 'log_only'
  /** 所屬產品的正規名稱；'' = 非單一產品來源。改動後要重建該來源索引才生效。 */
  productName: string
  /** type='url'：是否允許小幅文字變動自動套用（預設 true） */
  urlAutoApply: boolean
  lastFetchedAtMs: number
  outdatedAtMs: number
  updatedAtMs: number
}

function tsToMs(raw: unknown): number {
  if (!raw) return 0
  const v = raw as { toMillis?: () => number; seconds?: number; _seconds?: number }
  if (typeof v.toMillis === 'function') return v.toMillis()
  const sec = v.seconds ?? v._seconds
  return typeof sec === 'number' ? sec * 1000 : 0
}

/** 把 raw doc 轉成 UI 友善的 summary（時間戳轉 ms、有預設值） */
export function docToSourceSummary(id: string, raw: Partial<KnowledgeSourceDoc>): SourceSummary {
  return {
    id,
    type: (raw.type ?? 'file') as KnowledgeSourceType,
    name: String(raw.name ?? ''),
    url: String(raw.url ?? ''),
    folderId: raw.folderId ?? null,
    status: (raw.status ?? 'ready') as KnowledgeSourceStatus,
    failureReason: raw.failureReason,
    chunkCount: Number(raw.chunkCount ?? 0),
    refreshIntervalMinutes: Number(raw.refreshIntervalMinutes ?? 0),
    onChangeBehavior: raw.onChangeBehavior === 'log_only' ? 'log_only' : 'notify',
    productName: String(raw.productName ?? '').trim(),
    urlAutoApply: raw.urlAutoApply !== false,
    lastFetchedAtMs: tsToMs(raw.lastFetchedAt),
    outdatedAtMs: tsToMs(raw.outdatedAt),
    updatedAtMs: tsToMs(raw.updatedAt),
  }
}

/**
 * 列出某 workspace 的所有 source（依 updatedAt 倒序）。
 */
export async function listSources(
  db: Firestore,
  workspaceId: string,
  limit = 100,
): Promise<SourceSummary[]> {
  const snap = await db.collection(KNOWLEDGE_SOURCES_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .orderBy('updatedAt', 'desc')
    .limit(limit)
    .get()
  return snap.docs.map(d => docToSourceSummary(d.id, d.data() as any))
}

/**
 * 取得單一 source（含 workspace 比對）。找不到回 null。
 */
export async function getSource(
  db: Firestore,
  sourceId: string,
  workspaceId: string,
): Promise<{ id: string; data: KnowledgeSourceDoc } | null> {
  const snap = await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).get()
  if (!snap.exists) return null
  const data = snap.data() as KnowledgeSourceDoc
  if (data.workspaceId !== workspaceId) return null
  return { id: snap.id, data }
}

/**
 * 重新算 chunkCount（給 source detail 顯示「目前有幾張卡」）。
 */
export async function countSourceChunks(
  db: Firestore,
  workspaceId: string,
  sourceId: string,
): Promise<number> {
  const snap = await db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .where('sourceId', '==', sourceId)
    .count()
    .get()
  return snap.data().count
}

/**
 * 列出某 source 旗下的所有 chunk（給 source detail panel）。
 */
export async function listChunksBySource(
  db: Firestore,
  workspaceId: string,
  sourceId: string,
): Promise<Array<{ id: string; title: string; content: string; tags: string[]; status: string; failureReason?: string; isOverview: boolean; manuallyEditedAtMs: number; updatedAtMs: number; activeUntilMs: number; expiredAtMs: number }>> {
  const snap = await db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .where('sourceId', '==', sourceId)
    .get()
  return snap.docs.map((d) => {
    const data = d.data() as any
    return {
      id: d.id,
      title: String(data?.title ?? ''),
      content: String(data?.content ?? ''),
      tags: Array.isArray(data?.tags) ? data.tags.map(String) : [],
      status: String(data?.status ?? 'pending'),
      ...(data?.failureReason ? { failureReason: String(data.failureReason) } : {}),
      isOverview: data?.isOverview === true,
      manuallyEditedAtMs: tsToMs(data?.manuallyEditedAt),
      updatedAtMs: tsToMs(data?.updatedAt),
      activeUntilMs: tsToMs(data?.activeUntil),
      expiredAtMs: tsToMs(data?.expiredAt),
    }
  })
}

/**
 * 刪除 source 與底下所有 chunk。給「整批退場」用。
 * 注意：不刪 file storage（filePath），那是另一個生命週期。
 */
export async function deleteSourceWithChunks(
  db: Firestore,
  workspaceId: string,
  sourceId: string,
): Promise<{ chunksDeleted: number }> {
  const source = await getSource(db, sourceId, workspaceId)
  if (!source) return { chunksDeleted: 0 }

  const chunksSnap = await db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .where('sourceId', '==', sourceId)
    .get()

  const batch = db.batch()
  for (const doc of chunksSnap.docs) batch.delete(doc.ref)
  // 變動偵測的全文暫存（subcollection）也一併清掉，避免孤兒 doc
  batch.delete(db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).collection('cache').doc('extracted'))
  batch.delete(db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId))
  await batch.commit()
  invalidateTagIndexCache(workspaceId)
  invalidateCatalogSourceCache(workspaceId)

  return { chunksDeleted: chunksSnap.size }
}

export interface UpdateSourceSettingsInput {
  refreshIntervalMinutes?: number
  onChangeBehavior?: 'notify' | 'log_only'
  name?: string
  /** 移動到指定資料夾；null = 移出資料夾（未分類） */
  folderId?: string | null
  /** 所屬產品名；'' = 清空（非單一產品來源）。改動後呼叫端要觸發該來源 reindex 才生效。 */
  productName?: string
  /** type='url'：小幅變動是否自動套用 */
  urlAutoApply?: boolean
}

/**
 * 更新 source 的設定（refresh 頻率、處理方式、顯示名稱、所屬資料夾）。
 * 只動使用者可配置的欄位；不動 hash / etag / lastFetchedAt 等系統管理欄位。
 */
export async function updateSourceSettings(
  db: Firestore,
  workspaceId: string,
  sourceId: string,
  input: UpdateSourceSettingsInput,
): Promise<SourceSummary | null> {
  const source = await getSource(db, sourceId, workspaceId)
  if (!source) return null

  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() }
  if (input.refreshIntervalMinutes != null) {
    const n = Number(input.refreshIntervalMinutes)
    update.refreshIntervalMinutes = Number.isFinite(n) ? Math.max(0, Math.min(43_200, Math.round(n))) : 0
  }
  if (input.onChangeBehavior === 'notify' || input.onChangeBehavior === 'log_only') {
    update.onChangeBehavior = input.onChangeBehavior
  }
  if (typeof input.name === 'string' && input.name.trim()) {
    update.name = input.name.trim().slice(0, 200)
  }
  if (input.folderId !== undefined) {
    update.folderId = input.folderId ? String(input.folderId) : null
  }
  if (typeof input.urlAutoApply === 'boolean') {
    update.urlAutoApply = input.urlAutoApply
  }
  if (typeof input.productName === 'string') {
    const clean = input.productName.trim().slice(0, 60)
    update.productName = clean || FieldValue.delete()
  }

  await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).update(update)
  if (typeof input.productName === 'string') {
    // 索引流程 60s 快取要立刻失效，之後的 reindex 才吃得到新產品名；索引清單只增不刪
    invalidateSourceProductCache(sourceId)
    const clean = input.productName.trim().slice(0, 60)
    if (clean) await addWorkspaceProductName(db, workspaceId, clean)
  }
  const fresh = await getSource(db, sourceId, workspaceId)
  return fresh ? docToSourceSummary(fresh.id, fresh.data) : null
}

/**
 * 標 source「偵測到變動，等使用者確認」。
 * 由排程任務在比對到 contentHash 變了之後呼叫。
 */
export async function markSourceOutdated(
  db: Firestore,
  sourceId: string,
): Promise<void> {
  await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).update({
    outdatedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  })
}

/**
 * 清掉「偵測到變動」旗標（套用 re-sync 後呼叫）。
 */
export async function clearSourceOutdated(
  db: Firestore,
  sourceId: string,
): Promise<void> {
  await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).update({
    outdatedAt: null,
    updatedAt: FieldValue.serverTimestamp(),
  })
}
