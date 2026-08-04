import { v4 as uuidv4 } from 'uuid'
import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { invalidateCatalogSourceCache } from '~~/server/utils/ai-knowledge-sources'
import { recordAiUsage } from '~~/server/utils/ai-usage'
import { parseGoogleSheetUrl } from '~~/server/utils/google-sheets'
import {
  addWorkspaceProductName,
  createKnowledgeChunk,
  normalizeChunkInput,
  validateChunkInput,
} from '~~/server/utils/ai-knowledge-chunks'
import type { KnowledgeChunkStatus, KnowledgeSourceType } from '~~/shared/types/ai-knowledge'

const KNOWLEDGE_SOURCES_COLLECTION = 'knowledgeSources'

/** 同時跑幾張卡的 embedding。Gemini 免費層 RPM 15、付費層 1000+，5 算保守 */
const EMBED_CONCURRENCY = 5

// 分段切卡（大型目錄）單次可產出超過 50 張；150 張 × ~300ms embed / 併發 5 ≈ 9 秒，仍在請求時限內
const MAX_BULK_CHUNKS = 150

/**
 * POST /api/ai/knowledge/bulk-create
 * Body: {
 *   source: { type: 'file' | 'url' | 'text', name, url?, contentHash?, productName? },
 *   chunks: [{ title, content, tags[] }]
 * }
 *
 * 流程：建 knowledgeSource（type=text 跳過）→ 批次建 chunks（含 embedding）→ 回報每張卡狀態。
 * 失敗的卡會是 status='failed'，可由排程任務或手動 reindex 救回。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')
  const body = await readBody(event)

  const rawChunks = Array.isArray(body?.chunks) ? body.chunks : []
  if (!rawChunks.length) {
    throw createError({ statusCode: 400, statusMessage: '請至少選擇一張卡片匯入' })
  }
  if (rawChunks.length > MAX_BULK_CHUNKS) {
    throw createError({ statusCode: 400, statusMessage: `單次最多匯入 ${MAX_BULK_CHUNKS} 張卡` })
  }

  const inputs = rawChunks.map(normalizeChunkInput)
  for (const input of inputs) {
    const err = validateChunkInput(input)
    if (err) throw createError({ statusCode: 400, statusMessage: `卡片「${input.title || '未命名'}」：${err}` })
  }

  // 列表頁的「總覽卡」與一般卡分開傳：它帶 isOverview，re-sync 時要能單獨辨識 / 重生
  const rawOverview = body?.overviewCard
  const overviewInput = rawOverview?.title && rawOverview?.content
    ? { ...normalizeChunkInput(rawOverview), isOverview: true }
    : null
  if (overviewInput) {
    const err = validateChunkInput(overviewInput)
    if (err) throw createError({ statusCode: 400, statusMessage: `總表：${err}` })
  }

  const db = getDb()

  // ── 建 knowledgeSource（type=text 不建） ────────────────────────
  let sourceId: string | null = null
  const sourceType = String(body?.source?.type ?? '').trim() as KnowledgeSourceType | 'text'
  if (sourceType === 'file' || sourceType === 'url' || sourceType === 'gsheet') {
    sourceId = uuidv4()
    const now = FieldValue.serverTimestamp()
    const sourceUrl = String(body?.source?.url ?? '').trim()

    // gsheet：解析出 id/gid 供自動同步比對（不靠 url 字串），預設每小時自動同步
    let gsheetFields: Record<string, unknown> = {}
    if (sourceType === 'gsheet') {
      const ref = parseGoogleSheetUrl(sourceUrl)
      if (!ref) throw createError({ statusCode: 400, statusMessage: '無效的 Google Sheet 連結' })
      gsheetFields = {
        gsheetId: ref.spreadsheetId,
        gsheetGid: ref.gid,
        gsheetAutoApply: body?.source?.autoApply !== false,
      }
    }

    // 自動同步頻率（分鐘）：gsheet 每小時、url 每天、檔案不自動
    const refreshIntervalMinutes = sourceType === 'gsheet' ? 60 : sourceType === 'url' ? 1440 : 0

    // 產品名（P1-1）：匯入預覽自動偵測、使用者確認後帶進來。先寫進 source doc 再建卡，
    // 底下 createKnowledgeChunk → runIndexOnChunk 會即時繼承（embedding 前綴 + 卡片欄位）。
    const productName = String(body?.source?.productName ?? '').trim().slice(0, 60)

    await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).set({
      workspaceId,
      type: sourceType,
      name: String(body?.source?.name ?? '').trim(),
      url: sourceUrl,
      folderId: typeof body?.source?.folderId === 'string' ? body.source.folderId : null,
      filePath: '', // Phase 1b 不存原檔；要存到 Storage 可以擴
      contentHash: String(body?.source?.contentHash ?? '').trim(),
      etag: '',
      lastModified: '',
      refreshIntervalSec: 0,
      refreshIntervalMinutes,
      onChangeBehavior: 'notify',
      generateOverview: Boolean(overviewInput),
      ...(productName ? { productName } : {}),
      ...gsheetFields,
      lastFetchedAt: now,
      outdatedAt: null,
      status: 'ready',
      chunkCount: inputs.length + (overviewInput ? 1 : 0),
      createdAt: now,
      updatedAt: now,
    })
    // 新型錄來源要讓答題端的 dedupeBySource 豁免立刻生效（不必等 60s 快取過期）
    if (overviewInput) invalidateCatalogSourceCache(workspaceId)
    // 產品索引自動維護（只增不刪）；建卡前先併入，讓 pickCardProduct 這批就吃得到
    if (productName) await addWorkspaceProductName(db, workspaceId, productName)
  }

  // ── 批次建立 chunks（含 embedding），用 concurrency 控速 ──────────
  // skipUsageRecording:150 卡逐卡記帳會對同一份月用量文件連打(~15 writes/s,被節流
  // 的寫入靜默漏記),改累計 token、最後整批記一次
  type ResultRow = { id: string; status: KnowledgeChunkStatus; title: string; failureReason?: string }
  const results: ResultRow[] = new Array(inputs.length)
  let totalEmbeddingTokens = 0

  let cursor = 0
  async function worker() {
    while (cursor < inputs.length) {
      const idx = cursor++
      const input = inputs[idx]!
      const chunkId = uuidv4()
      const r = await createKnowledgeChunk(db, {
        workspaceId,
        chunkId,
        ...input,
        sourceId,
        skipUsageRecording: true,
      })
      if (r.status === 'indexed') totalEmbeddingTokens += r.embeddingTokens
      results[idx] = { id: r.id, status: r.status, title: input.title, failureReason: r.failureReason }
    }
  }
  await Promise.all(Array.from({ length: Math.min(EMBED_CONCURRENCY, inputs.length) }, worker))

  // ── 總覽卡（若有）：最後單獨建一張，帶 isOverview ──────────────────
  if (overviewInput) {
    const r = await createKnowledgeChunk(db, {
      workspaceId,
      chunkId: uuidv4(),
      ...overviewInput,
      sourceId,
      skipUsageRecording: true,
    })
    if (r.status === 'indexed') totalEmbeddingTokens += r.embeddingTokens
    results.push({ id: r.id, status: r.status, title: overviewInput.title, failureReason: r.failureReason })
  }

  // 整批一次記帳
  if (totalEmbeddingTokens > 0) {
    await recordAiUsage(workspaceId, { buildEmbeddingTokens: totalEmbeddingTokens })
  }

  const indexed = results.filter(r => r.status === 'indexed').length
  const failed = results.filter(r => r.status === 'failed').length

  return {
    sourceId,
    total: results.length,
    indexed,
    failed,
    items: results,
  }
})
