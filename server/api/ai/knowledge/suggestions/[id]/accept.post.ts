import { v4 as uuidv4 } from 'uuid'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import {
  createKnowledgeChunk,
  normalizeChunkInput,
  validateChunkInput,
} from '~~/server/utils/ai-knowledge-chunks'
import { KNOWLEDGE_SOURCES_COLLECTION } from '~~/server/utils/ai-knowledge-sources'
import {
  KNOWLEDGE_SUGGESTIONS_COLLECTION,
  SUGGESTION_RESOLVED_TTL_DAYS,
  countDraftBlanks,
  resolveHandoffsByQueries,
} from '~~/server/utils/ai-knowledge-suggest'
import { answerWithAi } from '~~/server/utils/ai-answer'
import type { KnowledgeSuggestionDoc } from '~~/shared/types/ai-knowledge'

/** 試答驗證的時間上限：答題管線有自己的逾時，這裡是最後保險，超時回 null 不擋採用 */
const VERIFY_TIMEOUT_MS = 15_000

/**
 * POST /api/ai/knowledge/suggestions/:id/accept
 * Body: { title, content, tags[], questions[] }（UI 可能改過草稿，以送來的為準）
 *
 * 「採用並學習」一鍵收掉整個閉環：
 *   1. 建知識卡（同手寫卡：自動建 manual source、同步 embedding）
 *   2. 建議標記 accepted
 *   3. 監控頁對應的轉真人案例自動標「已處理」（不用再回去逐筆按）
 *   4. 用代表問句試答一次（isTest，不進品質統計），回報 AI 現在答不答得出來
 *
 * 內容防護：草稿還有「【請填寫：…】」佔位符就擋下——那些是知識庫查不到、
 * LLM 依規則留空的事實，沒補完存進去等於讓 AI 拿空格回答客人。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')
  const id = String(getRouterParam(event, 'id') ?? '').trim()
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' })

  // 先驗內容(純計算、不碰 DB):不合格就 400,不要先去佔用建議的狀態
  const rawBody = await readBody(event)
  const input = normalizeChunkInput(rawBody)
  const err = validateChunkInput(input)
  if (err) throw createError({ statusCode: 400, statusMessage: err })
  const blanks = countDraftBlanks(input.content)
  if (blanks > 0) {
    throw createError({
      statusCode: 400,
      statusMessage: `內容還有 ${blanks} 個「請填寫」待補——那是知識庫裡查不到的資訊，補上正確內容才能讓 AI 學`,
    })
  }

  const db = getDb()
  const suggestionRef = db.collection(KNOWLEDGE_SUGGESTIONS_COLLECTION).doc(id)

  // 在交易裡把 pending 佔走（改成中間態 accepting）再建卡。
  // 不這樣做的話「檢查 status → 建 source → embed → 改 status」中間有好幾秒空窗，
  // 兩個分頁同時按採用會建出兩張幾乎一樣的卡（相近卡片會引發反問與混答，本專案踩過）。
  const suggestion = await db.runTransaction(async (tx) => {
    const snap = await tx.get(suggestionRef)
    const data = snap.data() as KnowledgeSuggestionDoc | undefined
    if (!snap.exists || data?.workspaceId !== workspaceId) {
      throw createError({ statusCode: 404, statusMessage: '找不到這筆建議' })
    }
    if (data.status !== 'pending') {
      throw createError({ statusCode: 409, statusMessage: '這筆建議已被處理過，請重新整理清單' })
    }
    tx.update(suggestionRef, { status: 'accepting', updatedAt: FieldValue.serverTimestamp() })
    return data
  })

  const sourceId = uuidv4()
  const chunkId = uuidv4()
  let result: Awaited<ReturnType<typeof createKnowledgeChunk>>
  try {
    // 1. 建卡（同 /api/ai/knowledge/create：手寫單張 = 一個 manual source 包一張卡）
    const now = FieldValue.serverTimestamp()
    await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).set({
      workspaceId,
      type: 'manual',
      name: input.title.slice(0, 200),
      url: '',
      folderId: null,
      filePath: '',
      contentHash: '',
      etag: '',
      lastModified: '',
      refreshIntervalSec: 0,
      refreshIntervalMinutes: 0,
      onChangeBehavior: 'notify',
      lastFetchedAt: now,
      outdatedAt: null,
      status: 'ready',
      chunkCount: 1,
      createdAt: now,
      updatedAt: now,
    })

    result = await createKnowledgeChunk(db, {
      workspaceId,
      chunkId,
      title: input.title,
      content: input.content,
      tags: input.tags,
      questions: input.questions,
      sourceId,
    })
  }
  catch (e) {
    // 建卡失敗要把建議放回 pending。卡在 accepting 的話它從清單消失、
    // 又不能採用也不能忽略——使用者只會看到建議「不見了」。
    await suggestionRef.set({ status: 'pending', updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      .catch(() => {})
    throw e
  }

  // 2. 建議銷案（處理完的建議帶 expireAt，靠 TTL 自動清；不清的話去重比對的上限總會被撞到）
  await suggestionRef.set({
    status: 'accepted',
    acceptedAt: FieldValue.serverTimestamp(),
    acceptedChunkId: chunkId,
    acceptedSourceId: sourceId,
    expireAt: Timestamp.fromMillis(Date.now() + SUGGESTION_RESOLVED_TTL_DAYS * 24 * 3600_000),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true })

  // 3. 監控頁對應案例自動標已處理（失敗不影響採用本身）
  const resolvedConversations = await resolveHandoffsByQueries(db, workspaceId, suggestion.queries ?? [])
    .catch((e) => {
      console.warn('[kb-suggest] resolve handoffs failed:', (e as Error)?.message)
      return 0
    })

  // 4. 試答驗證（embedding 失敗就不必試了）
  let verify: { decision: string; confidence: number } | null = null
  const verifyQuery = suggestion.sampleQueries?.[0] ?? suggestion.queries?.[0] ?? ''
  if (result.status === 'indexed' && verifyQuery) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const out = await Promise.race([
        answerWithAi({ workspaceId, query: verifyQuery, isTest: true, skipDisambiguation: true }),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), VERIFY_TIMEOUT_MS) }),
      ])
      if (out) verify = { decision: out.decision, confidence: Number(out.confidence ?? 0) }
    }
    catch (e) {
      console.warn('[kb-suggest] verify failed:', (e as Error)?.message)
    }
    finally {
      // 答題先回來時要清掉計時器，否則 Lambda 會為了這個掛著的 timer 多醒 15 秒
      if (timer) clearTimeout(timer)
    }
  }

  return {
    chunkId,
    sourceId,
    status: result.status,
    failureReason: result.failureReason ?? null,
    resolvedConversations,
    verify,
  }
})
