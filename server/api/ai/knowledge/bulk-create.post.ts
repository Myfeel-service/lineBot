import { createHash } from 'node:crypto'
import { v4 as uuidv4 } from 'uuid'
import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { invalidateCatalogSourceCache, recycleSourceChunks } from '~~/server/utils/ai-knowledge-sources'
import { assertMaintenanceBudget, recordAiUsage } from '~~/server/utils/ai-usage'
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
  // 維運額度前置檢查（C-45）：讓使用者在開始前就看到「額度不足」，而不是建到一半死
  await assertMaintenanceBudget(workspaceId)
  const body = await readBody(event)

  /**
   * importId（C-46 冪等鍵，前端帶預覽 jobId）：150 張卡 × embedding 會超過閘道 30 秒——
   * Lambda 其實建完了，前端卻收到逾時、使用者再按一次。有 importId 時 source 與每張卡
   * 的 id 都決定性導出：重按覆寫同一批 doc，不會留下「說有 150 條實際 30 條」的殭屍來源
   * ＋第二批重複卡＋二次 embedding 費。
   */
  const importId = String(body?.importId ?? '').trim().slice(0, 64)
  const idFor = (suffix: string) =>
    createHash('sha256').update(`bulk:${workspaceId}:${importId}:${suffix}`).digest('hex').slice(0, 32)

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

  /**
   * `replaceSourceId`（`C-135`）：把這批卡**蓋回既有那一份資料**，而不是新建一份。
   *
   * 為什麼要有：同名警告原本唯一的建議是「改個名字」——照做的人就製造出第三份重複
   * （2026-09-04 在 MYFEEL 看到同一本說明書並存三份的實況）。人真正想做的事是
   * 「這份我重傳了、用新的蓋掉舊的」，那就得有一條路真的做得到。
   *
   * 舊卡走**軟刪除**（進回收桶 30 天）不是真刪：蓋錯了要救得回來，
   * 而且來源本身留著＝資料夾、產品名、同步設定、卡片以外的設定都不會被洗掉。
   */
  const replaceSourceId = String(body?.replaceSourceId ?? '').trim().slice(0, 64)
  let replacedChunks = 0

  // ── 建 knowledgeSource ────────────────────────
  // text 也建（type='manual'，C-47）：原本 text 不建 source → sourceId 恆 null、
  // 使用者確認過的「所屬產品」從未寫入任何地方（畫面有欄位、系統還花一次 LLM 預填＝白花），
  // 整批卡變成 7/31 稽核反覆咬人的「無主卡」——客人指名問另一台時被拿去混答，
  // 而且不屬於任何來源、無法整批管理。手寫單卡（create.post.ts）早就這樣做了，比照辦理。
  let sourceId: string | null = null
  const sourceType = String(body?.source?.type ?? '').trim() as KnowledgeSourceType | 'text'
  if (sourceType === 'file' || sourceType === 'url' || sourceType === 'gsheet' || sourceType === 'text') {
    sourceId = importId ? idFor('source') : uuidv4()
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

    // ── 「更新既有那一份」：接管既有 source id，舊卡先進回收桶 ──────────
    if (replaceSourceId) {
      const existingSnap = await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(replaceSourceId).get()
      const existing = existingSnap.data() as { workspaceId?: string } | undefined
      // 跨租戶保護：找不到或不是自己的，寧可報錯也不要默默改成「新建一份」——
      // 使用者按的是「更新」，結果多出一份重複，正是這條路要修掉的病
      if (!existingSnap.exists || existing?.workspaceId !== workspaceId) {
        throw createError({ statusCode: 404, statusMessage: '找不到要更新的資料（可能已被刪除），請重新整理後再試' })
      }
      sourceId = replaceSourceId
      // 舊卡進回收桶（30 天內救得回來）；批次與「已在回收桶不重蓋」的規矩收在 utils 裡
      replacedChunks = await recycleSourceChunks(db, workspaceId, sourceId)
    }

    const sourcePayload: Record<string, unknown> = {
      workspaceId,
      // 貼上文字沒有可重抓的外部來源 → 歸 manual（與手寫單卡同類：不排同步、不偵測變動）
      type: sourceType === 'text' ? 'manual' : sourceType,
      name: String(body?.source?.name ?? '').trim(),
      url: sourceUrl,
      folderId: typeof body?.source?.folderId === 'string' ? body.source.folderId : null,
      filePath: '', // Phase 1b 不存原檔；要存到 Storage 可以擴
      contentHash: String(body?.source?.contentHash ?? '').trim(),
      // 這批卡就是從這一版內容切出來的 → 同時當成「重新同步」的比對基準。
      // 沒有基準的來源（舊資料、貼上文字）第一次重新同步仍會照跑重切＋比對。
      appliedContentHash: String(body?.source?.contentHash ?? '').trim(),
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
      isDeleted: false, // listSources 查詢層過濾用
      chunkCount: inputs.length + (overviewInput ? 1 : 0),
      createdAt: now,
      updatedAt: now,
    }

    if (replaceSourceId) {
      /**
       * 更新既有資料＝**只蓋這次真的重傳的東西**，其餘一律留著。
       * ⛔不可以整包覆蓋：那會把使用者在這份資料上做過的設定洗掉——所屬資料夾
       * （沒帶就是「不改」，不是「移出資料夾」）、同步頻率、Google Sheet 的
       * 分頁對應、建立日期。整包覆蓋洗掉設定這一課已經在金流的續扣資料上付過一次錢。
       */
      delete sourcePayload.createdAt
      delete sourcePayload.refreshIntervalMinutes
      delete sourcePayload.onChangeBehavior
      if (typeof body?.source?.folderId !== 'string') delete sourcePayload.folderId
      // 產品名沒帶＝不改（`...(productName ? …)` 本來就不會塞進去，這裡只是把話講明）
      await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).set(sourcePayload, { merge: true })
    }
    else {
      await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).set(sourcePayload)
    }
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
      const chunkId = importId ? idFor(`chunk:${idx}`) : uuidv4()
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
      chunkId: importId ? idFor('overview') : uuidv4(),
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

  // chunkCount 回寫實數（建 source 時寫的是「預計」數）：中途死掉重跑後這裡會補正，
  // 不再留下「說有 150 條、實際 30 條」的殭屍來源
  if (sourceId) {
    const { countSourceChunks } = await import('~~/server/utils/ai-knowledge-sources')
    const actual = await countSourceChunks(db, workspaceId, sourceId)
    await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId)
      .update({ chunkCount: actual, updatedAt: FieldValue.serverTimestamp() })
      .catch(() => {})
  }

  const indexed = results.filter(r => r.status === 'indexed').length
  const failed = results.filter(r => r.status === 'failed').length

  return {
    sourceId,
    total: results.length,
    indexed,
    failed,
    /** 「更新既有資料」時被移進回收桶的舊卡張數；結果頁要講出來（人有權知道舊的去哪了） */
    replacedChunks: replaceSourceId ? replacedChunks : 0,
    items: results,
  }
})
