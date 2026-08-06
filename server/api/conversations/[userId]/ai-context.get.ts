import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { KNOWLEDGE_CHUNKS_COLLECTION } from '~~/server/utils/ai-knowledge-chunks'
import { AI_FEEDBACK_EVENTS_COLLECTION, aiFeedbackDocId } from '~~/server/utils/ai-feedback-events'
import { lineUserFirestoreDocId, lineUserIdFromFirestoreDocId } from '~~/shared/line-workspace'
import type { AiConversationMeta, AiContextPayload } from '~~/shared/types/ai-knowledge'

/**
 * 回應形狀與 `ai-turn/:turnId` 共用（見 AiContextPayload）——後台是同一個脈絡元件在渲染。
 *
 * 這支給的是「這位客人**最近一次**」，turnId 一律空字串：aiMeta 沒有回合身分，
 * 只能靠 updatedAtMs 指認是哪一次（也因此才需要 ai-feedback 的 409 樂觀鎖）。
 */
type AiContextResponse = AiContextPayload

function tsToMs(raw: unknown): number {
  if (!raw) return 0
  const v = raw as { toMillis?: () => number; seconds?: number; _seconds?: number }
  if (typeof v.toMillis === 'function') return v.toMillis()
  const sec = v.seconds ?? v._seconds
  return typeof sec === 'number' ? sec * 1000 : 0
}

/**
 * GET /api/conversations/:userId/ai-context
 *
 * 回傳該對話最近一次 AI 介入的脈絡。Phase 4 真人收件匣側欄消費。
 * sources 會 hydrate 為知識卡標題（不回傳內容，避免 payload 過大）。
 */
export default defineEventHandler(async (event): Promise<AiContextResponse> => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')
  const userIdRaw = String(getRouterParam(event, 'userId') ?? '').trim()
  if (!userIdRaw) throw createError({ statusCode: 400, statusMessage: 'userId required' })

  const db = getDb()
  const lineUserId = lineUserIdFromFirestoreDocId(userIdRaw, workspaceId)
  const convDocId = lineUserFirestoreDocId(lineUserId, workspaceId)
  const snap = await db.collection('conversations').doc(convDocId).get()

  const empty: AiContextResponse = {
    hasMeta: false,
    lastDecision: '',
    lastConfidence: 0,
    lastHandoffReason: null,
    lastQuery: '',
    lastAnswerKind: 'kb',
    suggestedReply: '',
    handoffSummary: '',
    sources: [],
    wrongMarked: false,
    turnId: '',
    updatedAtMs: 0,
  }
  if (!snap.exists) return empty

  const data = snap.data() as { workspaceId?: string; aiMeta?: AiConversationMeta }
  if (data.workspaceId !== workspaceId) {
    throw createError({ statusCode: 403, statusMessage: 'workspace mismatch' })
  }
  const meta = data.aiMeta
  if (!meta) return empty

  const ids: string[] = Array.isArray(meta.lastSourceChunkIds) ? meta.lastSourceChunkIds.slice(0, 5) : []
  const updatedAtMs = tsToMs(meta.updatedAt)

  const titleByChunkId: Record<string, string> = {}
  const [, wrongMarked] = await Promise.all([
    ids.length
      ? Promise.all(ids.map(id => db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(id).get().catch(() => null)))
        .then((docs) => {
          docs.forEach((d, i) => {
            if (!d?.exists) return
            const cd = d.data() as { workspaceId?: string; title?: string }
            if (cd?.workspaceId === workspaceId) titleByChunkId[ids[i]!] = String(cd.title ?? '')
          })
        })
      : Promise.resolve(),
    // 「這一次互動標過答錯了嗎」：doc id 算得出來，一次點讀即可（讀失敗當成沒標記，不讓整張卡掛掉）
    updatedAtMs
      ? db.collection(AI_FEEDBACK_EVENTS_COLLECTION)
        .doc(aiFeedbackDocId({ workspaceId, userId: convDocId, type: 'wrong_answer', interactionAtMs: updatedAtMs }))
        .get()
        .then(s => s.exists)
        .catch(() => false)
      : Promise.resolve(false),
  ])

  return {
    hasMeta: true,
    lastDecision: meta.lastDecision,
    lastConfidence: Number(meta.lastConfidence ?? 0),
    lastHandoffReason: meta.lastHandoffReason ?? null,
    lastQuery: String(meta.lastQuery ?? ''),
    lastAnswerKind: meta.lastAnswerKind ?? 'kb',
    suggestedReply: String(meta.suggestedReply ?? ''),
    handoffSummary: String(meta.handoffSummary ?? ''),
    sources: ids.map(id => ({
      chunkId: id,
      title: titleByChunkId[id] ?? '(卡片已刪除)',
      exists: id in titleByChunkId,
    })),
    wrongMarked,
    // aiMeta 沒有回合身分：這支只能靠時間戳指認是哪一次（見 ai-feedback.post.ts 的舊路徑）
    turnId: '',
    updatedAtMs,
  }
})
