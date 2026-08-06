import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { deleteAiFeedbackEvent, type AiFeedbackType } from '~~/server/utils/ai-feedback-events'
import { lineUserFirestoreDocId } from '~~/shared/line-workspace'

const VALID_TYPES = new Set<AiFeedbackType>(['wrong_answer', 'draft_applied'])

/**
 * DELETE /api/conversations/:userId/ai-feedback?type=wrong_answer&turnId=...
 *   （舊路徑：?interactionAtMs=... — 見下方相容說明）
 *
 * 取消一筆回饋（客服按錯「AI 答錯了」）。
 *
 * 為什麼需要：先前只有「記一筆」沒有「刪一筆」，不小心按到就救不回來，
 * 而那筆訊號會進知識缺口聚類（≥4 字就算），誤標會讓系統擬出一張沒意義的知識卡。
 *
 * 刻意**不做**樂觀鎖（POST 有）：要取消的就是客服畫面上那一則回覆，
 * 即使客人期間又問了新問題，舊那筆也該可以撤回——這裡的識別是「刪哪一筆」，不是「跟現況比對」。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')
  const userId = String(getRouterParam(event, 'userId') ?? '').trim()
  const query = getQuery(event)
  const type = String(query.type ?? 'wrong_answer') as AiFeedbackType
  const turnId = String(query.turnId ?? '').trim()
  const interactionAtMs = Number(query.interactionAtMs ?? 0)

  if (!userId) throw createError({ statusCode: 400, statusMessage: 'userId required' })
  if (!VALID_TYPES.has(type)) throw createError({ statusCode: 400, statusMessage: 'type 不合法' })
  // turnId（新）或 interactionAtMs（舊訊息沒有 turnId 時）二擇一
  if (!turnId && (!Number.isFinite(interactionAtMs) || interactionAtMs <= 0)) {
    throw createError({ statusCode: 400, statusMessage: 'turnId 或 interactionAtMs 必須擇一' })
  }

  const db = getDb()
  const convDocId = lineUserFirestoreDocId(userId, workspaceId)

  // 跨租戶保護：對話文件必須屬於這個工作區（事件本身也會再比對一次 workspaceId）
  const snap = await db.collection('conversations').doc(convDocId).get()
  if (!snap.exists || (snap.data() as { workspaceId?: string })?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到此對話' })
  }

  const removed = await deleteAiFeedbackEvent(db, {
    workspaceId,
    userId: convDocId,
    type,
    turnId: turnId || undefined,
    interactionAtMs,
  })

  // removed=false（本來就沒標記過）不是錯誤：前端要的結果「現在是未標記」已經成立
  return { ok: true, removed }
})
