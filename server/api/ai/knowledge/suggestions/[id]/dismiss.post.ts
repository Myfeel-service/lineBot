import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { KNOWLEDGE_SUGGESTIONS_COLLECTION, SUGGESTION_RESOLVED_TTL_DAYS } from '~~/server/utils/ai-knowledge-suggest'
import type { KnowledgeSuggestionDoc } from '~~/shared/types/ai-knowledge'

/**
 * POST /api/ai/knowledge/suggestions/:id/dismiss
 *
 * 忽略這個主題。不會永久消失：之後同主題事件數翻倍會重新浮出（惡化要重新被看見），
 * 判斷基準就是這裡記下的 seenCountAtDismiss。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')
  const id = String(getRouterParam(event, 'id') ?? '').trim()
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' })

  const db = getDb()
  const ref = db.collection(KNOWLEDGE_SUGGESTIONS_COLLECTION).doc(id)
  const snap = await ref.get()
  const data = snap.data() as KnowledgeSuggestionDoc | undefined
  if (!snap.exists || data?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到這筆建議' })
  }
  // 只有還在待處理的才能忽略。少了這道守門，另一個分頁上的舊清單可以把「已採用」
  // 的建議改成 dismissed —— 卡已經建好了，之後事件數翻倍還會被當缺口重新浮出，
  // 要店家再寫一張同樣的卡。
  if (data.status !== 'pending') {
    throw createError({ statusCode: 409, statusMessage: '這筆建議已被處理過，請重新整理清單' })
  }

  await ref.set({
    status: 'dismissed',
    dismissedAt: FieldValue.serverTimestamp(),
    seenCountAtDismiss: Number(data?.eventCount ?? 0),
    // 處理完的建議 180 天後由 TTL 清掉（去重比對才不會撞上限）
    expireAt: Timestamp.fromMillis(Date.now() + SUGGESTION_RESOLVED_TTL_DAYS * 24 * 3600_000),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true })

  return { ok: true }
})
