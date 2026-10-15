import { v4 as uuidv4 } from 'uuid'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import {
  createKnowledgeChunk,
  normalizeChunkInput,
  validateChunkInput,
} from '~~/server/utils/ai-knowledge-chunks'
import { KNOWLEDGE_SOURCES_COLLECTION } from '~~/server/utils/ai-knowledge-sources'
import { assertKnowledgeChunkQuota, invalidateKnowledgeChunkCount } from '~~/server/utils/ai-knowledge-quota'
import {
  KNOWLEDGE_SUGGESTIONS_COLLECTION,
  SUGGESTION_RESOLVED_TTL_DAYS,
  countDraftBlanks,
  resolveHandoffsByQueries,
  splitSuggestionQueries,
} from '~~/server/utils/ai-knowledge-suggest'
import { answerWithAi } from '~~/server/utils/ai-answer'
import { writeAuditLog } from '~~/server/utils/audit-log'
import type { KnowledgeSuggestionDoc } from '~~/shared/types/ai-knowledge'

/** 試答驗證的時間上限：答題管線有自己的逾時，這裡是最後保險，超時回 null 不擋採用 */
const VERIFY_TIMEOUT_MS = 15_000

/**
 * POST /api/ai/knowledge/suggestions/:id/accept
 * Body: { title, content, tags[], questions[], answeredQueries? }（UI 可能改過草稿，以送來的為準）
 *
 * `C-318`（2026-10-15）：畫面改成「寫一句答案」→ 同一個「補一條知識」小視窗（KnowledgeAddOneDialog），
 * 標題／內容是他打的一兩句（或 AI 整理過的）、問法自動帶勾的客人原句、標籤只有 AI 整理時才有。這支收的東西不變。
 *
 * 「採用並學習」一鍵收掉整個閉環：
 *   1. 建知識卡（同手寫卡：自動建 manual source、同步 embedding）
 *   2. 建議標記 accepted
 *   3. 監控頁對應的轉真人案例自動標「已處理」（不用再回去逐筆按）
 *   4. 用代表問句試答一次（isTest，不進品質統計），回報 AI 現在答不答得出來
 *
 * 內容防護：草稿還有「【請填寫：…】」佔位符就擋下——那些是知識庫查不到、
 * LLM 依規則留空的事實，沒補完存進去等於讓 AI 拿空格回答客人。
 *
 * 只採用其中幾題（`C-311`）：Body 多帶 answeredQueries＝「這一條回答了哪幾題」勾的客人原句。
 *   · 沒帶（舊版畫面還開著）或全勾＝整組採用，跟以前一模一樣
 *   · 只勾幾題＝上面 2～4 步只對勾的那幾題做；沒勾的留在同一筆建議、照舊待處理
 *     （為什麼留在同一筆、不另開一筆，見 ai-knowledge-suggest.ts 的 `C-311` 段落）
 *   額度、交易佔位（防兩個分頁各建一條）、稽核都照舊。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'knowledge.write')
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
  // `C-311`：勾了哪幾題。不是陣列＝舊版畫面（沒有勾選這回事）→ 整組採用
  const ticked: string[] | null = Array.isArray(rawBody?.answeredQueries)
    ? (rawBody.answeredQueries as unknown[]).map(q => String(q ?? '').trim()).filter(Boolean).slice(0, 100)
    : null
  if (ticked && !ticked.length) {
    throw createError({ statusCode: 400, statusMessage: '請至少勾一題，這一條回答了哪幾題' })
  }

  const db = getDb()

  // 方案知識量守門（D-69 拍板④）。**擺在交易之前**：額度不夠時連建議的狀態都不該動，
  // 否則它會先被佔成 accepting、再靠 catch 放回 pending，中間那段從清單上消失。
  await assertKnowledgeChunkQuota(workspaceId, 1, db)

  const suggestionRef = db.collection(KNOWLEDGE_SUGGESTIONS_COLLECTION).doc(id)

  // 在交易裡把 pending 佔走（改成中間態 accepting）再建卡。
  // 不這樣做的話「檢查 status → 建 source → embed → 改 status」中間有好幾秒空窗，
  // 兩個分頁同時按採用會建出兩張幾乎一樣的卡（相近卡片會引發反問與混答，本專案踩過）。
  const { suggestion, answered, partial } = await db.runTransaction(async (tx) => {
    const snap = await tx.get(suggestionRef)
    const data = snap.data() as KnowledgeSuggestionDoc | undefined
    if (!snap.exists || data?.workspaceId !== workspaceId) {
      throw createError({ statusCode: 404, statusMessage: '找不到這筆建議' })
    }
    if (data.status !== 'pending') {
      throw createError({ statusCode: 409, statusMessage: '這筆建議已被處理過，請重新整理清單' })
    }
    // `C-311`：勾的題目要真的還在這一組。另一個分頁先回答掉了（或掃描後已不在窗口裡）就一題都不算——
    // 放行的話會為已經回答過的問題再建一條一樣的
    let answered: string[] = []
    let partial = false
    if (ticked) {
      const split = splitSuggestionQueries(data, ticked)
      if (!split.answered.length) {
        throw createError({ statusCode: 409, statusMessage: '你勾的問題已經處理過了，請重新整理清單' })
      }
      answered = split.answered
      partial = split.remaining !== null
    }
    tx.update(suggestionRef, { status: 'accepting', updatedAt: FieldValue.serverTimestamp() })
    return { suggestion: data, answered, partial }
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
      /**
       * 資料清單的主查詢是 `isDeleted == false`（`C-49E`／`C-137`）——少了這一格，這一份只靠「舊資料」那一輪撈：
       * 那一輪只看最近更新的 100 份（含回收桶的），資料一多它就從左邊清單消失（AI 照樣用、後台找不到）。
       * `/api/ai/knowledge/create` 早就有寫；`C-318` 讓這條路變成「寫一句答案」的主路，補上。
       */
      isDeleted: false,
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
  invalidateKnowledgeChunkCount(workspaceId)

  // 2. 建議銷案（處理完的建議帶 expireAt，靠 TTL 自動清；不清的話去重比對的上限總會被撞到）
  const acceptedPatch = {
    status: 'accepted',
    acceptedAt: FieldValue.serverTimestamp(),
    acceptedChunkId: chunkId,
    acceptedSourceId: sourceId,
    expireAt: Timestamp.fromMillis(Date.now() + SUGGESTION_RESOLVED_TTL_DAYS * 24 * 3600_000),
    updatedAt: FieldValue.serverTimestamp(),
  }
  /** 還留在清單上的題數（整組採用＝0） */
  let remainingQuestions = 0
  if (!partial) {
    await suggestionRef.set(acceptedPatch, { merge: true })
  }
  else {
    // `C-311`：沒勾的留在同一筆、放回待處理。用交易重讀一次再算：建卡那幾秒內掃描可能剛好更新過這一筆
    // （多了新的問句、次數變了），拿佔位前的舊快照直接蓋回去會把那些更新蓋掉。
    remainingQuestions = await db.runTransaction(async (tx) => {
      const snap = await tx.get(suggestionRef)
      if (!snap.exists) return 0
      const { remaining } = splitSuggestionQueries(snap.data() as KnowledgeSuggestionDoc, answered)
      if (!remaining) {
        // 期間掃描把其他題目都拿掉了（過了窗口）＝實際上整組都回答了
        tx.set(suggestionRef, acceptedPatch, { merge: true })
        return 0
      }
      tx.set(suggestionRef, {
        status: 'pending',
        queries: remaining.queries,
        queryCounts: remaining.queryCounts ?? FieldValue.delete(),
        sampleQueries: remaining.sampleQueries,
        eventCount: remaining.eventCount,
        sampled: remaining.sampled,
        answeredQueries: remaining.answeredQueries,
        // 草稿是寫給整組的、剛剛已經拿去建了一條：留著的話列表標題對不上剩下的題目，
        // 再按一次採用還會建出重複的一條。清掉＋名字退回客人原句（列表標成「客人問」），下一輪掃描照剩下的題目重擬、改名
        draft: null,
        blanksCount: 0,
        draftError: FieldValue.delete(),
        topic: remaining.topic,
        topicIsRaw: true,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true })
      return remaining.queries.length
    })
  }

  // 3. 監控頁對應案例自動標已處理（失敗不影響採用本身）。
  // 只採用其中幾題時只銷那幾題（`C-311`）：沒勾的還沒人回答，把它們的對話標成已處理＝悄悄關掉別人的待辦
  const resolvedConversations = await resolveHandoffsByQueries(db, workspaceId, partial ? answered : (suggestion.queries ?? []))
    .catch((e) => {
      console.warn('[kb-suggest] resolve handoffs failed:', (e as Error)?.message)
      return 0
    })

  // 4. 試答驗證（embedding 失敗就不必試了）。只採用其中幾題時拿勾的第一題試——代表句可能正是沒回答的那題
  let verify: { decision: string; confidence: number } | null = null
  const verifyQuery = partial
    ? answered[0]!
    : (suggestion.sampleQueries?.[0] ?? suggestion.queries?.[0] ?? '')
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

  // 稽核（`C-254`）：採用建議＝多一張卡（計費維度），而且會順手把監控頁的案例標成已處理。
  // `C-311`：寫明回答了幾題、還有幾題留在清單——只看「採用了」會以為整組都處理掉了
  const answeredQuestions = partial ? answered.length : (suggestion.queries?.length || suggestion.sampleQueries?.length || 0)
  const questionsNote = answeredQuestions
    ? `（回答了 ${answeredQuestions} 題${remainingQuestions ? `，還有 ${remainingQuestions} 題留在清單上` : ''}）`
    : ''
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'knowledge.suggestionAccept',
    targetId: chunkId,
    after: { title: input.title, cardStatus: result.status, answeredQuestions, remainingQuestions },
    // `C-309`：操作紀錄是店家看得到的字，量詞跟全站一樣講「條」
    note: `採用了 AI 的建議並建成一條知識${questionsNote}${resolvedConversations ? `，順手把 ${resolvedConversations} 筆對話標成已處理` : ''}`,
  }, db)

  return {
    chunkId,
    sourceId,
    status: result.status,
    failureReason: result.failureReason ?? null,
    resolvedConversations,
    verify,
    /** `C-311`：沒勾、還留在清單上的題數（整組採用＝0）。畫面靠它決定要不要重讀清單、提示講不講 */
    remainingQuestions,
  }
})
