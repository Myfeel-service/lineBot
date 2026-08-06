import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { KNOWLEDGE_CHUNKS_COLLECTION } from '~~/server/utils/ai-knowledge-chunks'
import { AI_TURNS_COLLECTION } from '~~/server/utils/ai-turns'
import { AI_FEEDBACK_EVENTS_COLLECTION, aiFeedbackDocId } from '~~/server/utils/ai-feedback-events'
import { lineUserFirestoreDocId, lineUserIdFromFirestoreDocId } from '~~/shared/line-workspace'
import type { AiContextPayload } from '~~/shared/types/ai-knowledge'
import type { AiTurnDoc } from '~~/shared/types/ai-knowledge'

/**
 * GET /api/conversations/:userId/ai-turn/:turnId
 *
 * 「這一則 AI 回覆當時是怎麼判斷的」。與 ai-context 回同一個形狀（AiContextPayload），
 * 差別只在資料來源：這支讀**那一次**的 aiTurns 快照，ai-context 讀「最近一次」的 aiMeta。
 * 形狀一致是刻意的——後台兩處共用同一個脈絡元件，兩邊講的話才不會不一樣。
 */
export default defineEventHandler(async (event): Promise<AiContextPayload> => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')
  const userIdRaw = String(getRouterParam(event, 'userId') ?? '').trim()
  const turnId = String(getRouterParam(event, 'turnId') ?? '').trim()
  if (!userIdRaw) throw createError({ statusCode: 400, statusMessage: 'userId required' })
  if (!turnId) throw createError({ statusCode: 400, statusMessage: 'turnId required' })

  const db = getDb()
  const lineUserId = lineUserIdFromFirestoreDocId(userIdRaw, workspaceId)
  const convDocId = lineUserFirestoreDocId(lineUserId, workspaceId)

  const snap = await db.collection('conversations').doc(convDocId)
    .collection(AI_TURNS_COLLECTION).doc(turnId).get()
  if (!snap.exists) throw createError({ statusCode: 404, statusMessage: '找不到這一次 AI 回合' })

  const turn = snap.data() as AiTurnDoc
  // 子集合不會自己帶租戶邊界：turn 上存了 workspaceId 就要比對，否則換個網址就能讀別家的脈絡
  if (turn.workspaceId !== workspaceId) {
    throw createError({ statusCode: 403, statusMessage: 'workspace mismatch' })
  }

  const ids = Array.isArray(turn.sourceChunkIds) ? turn.sourceChunkIds.slice(0, 5) : []
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
    // 「這一回合標過答錯了嗎」：doc id 算得出來，一次點讀即可（讀失敗當成沒標記，不讓整張卡掛掉）
    db.collection(AI_FEEDBACK_EVENTS_COLLECTION)
      .doc(aiFeedbackDocId({ workspaceId, userId: convDocId, type: 'wrong_answer', turnId }))
      .get()
      .then(s => s.exists)
      .catch(() => false),
  ])

  return {
    hasMeta: true,
    lastDecision: turn.decision,
    lastConfidence: Number(turn.confidence ?? 0),
    lastHandoffReason: turn.handoffReason ?? null,
    lastQuery: String(turn.query ?? ''),
    lastAnswerKind: turn.answerKind ?? 'kb',
    suggestedReply: String(turn.suggestedReply ?? ''),
    handoffSummary: String(turn.handoffSummary ?? ''),
    sources: ids.map(id => ({
      chunkId: id,
      title: titleByChunkId[id] ?? '(卡片已刪除)',
      exists: id in titleByChunkId,
    })),
    wrongMarked,
    // 回合的脈絡綁在 turnId 上，不再靠時間戳指認是哪一次（見 ai-feedback.post.ts）
    turnId,
    updatedAtMs: 0,
  }
})
