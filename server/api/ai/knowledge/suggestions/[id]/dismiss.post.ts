import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { KNOWLEDGE_SUGGESTIONS_COLLECTION, SUGGESTION_RESOLVED_TTL_DAYS } from '~~/server/utils/ai-knowledge-suggest'
import { writeAuditLog } from '~~/server/utils/audit-log'
import type { KnowledgeSuggestionDismissReason, KnowledgeSuggestionDoc } from '~~/shared/types/ai-knowledge'

/** 店家按得到的兩種（personal_order 是掃描自己收的，不收前端送來的） */
const USER_REASONS = ['ignore', 'handoff'] as const satisfies readonly KnowledgeSuggestionDismissReason[]
type UserDismissReason = (typeof USER_REASONS)[number]

/**
 * POST /api/ai/knowledge/suggestions/:id/dismiss
 * Body: { reason?: 'ignore' | 'handoff' }（沒帶＝ignore，舊版畫面照舊）
 *
 * 兩種收法（`C-318`，2026-10-15 拍板 `D-126`④「每題三選一」的後兩個）：
 * - ignore（「不用管」）：不會永久消失——之後同主題事件數翻倍會重新浮出（惡化要重新被看見），
 *   判斷基準就是這裡記下的 seenCountAtDismiss。
 * - handoff（「交給真人就好」）：這類問題本來就該真人回，不補知識。**以後不再列**（翻倍也不列，見掃描端）。
 *   知識庫沒答案時 AI 本來就會轉真人，所以這裡**不另做**轉真人的機制，只是不再叫店家補。
 *   ⛔ 不設 expireAt：TTL 清掉這一筆，同一類下一輪就會被當成新主題再列出來，等於「交給真人」只管半年。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'knowledge.write')
  const id = String(getRouterParam(event, 'id') ?? '').trim()
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' })

  const body = await readBody(event).catch(() => ({}))
  const rawReason = body?.reason
  // 帶了看不懂的值＝前端寫錯字：⛔ 不默默當成「不用管」（「交給真人」被當成會再出現的那一種，店家不會知道）
  if (rawReason != null && rawReason !== '' && !(USER_REASONS as readonly unknown[]).includes(rawReason)) {
    throw createError({ statusCode: 400, statusMessage: 'reason 只能是 ignore 或 handoff' })
  }
  const reason: UserDismissReason = rawReason === 'handoff' ? 'handoff' : 'ignore'

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
    dismissReason: reason,
    dismissedAt: FieldValue.serverTimestamp(),
    seenCountAtDismiss: Number(data?.eventCount ?? 0),
    // 「不用管」：處理完的建議 180 天後由 TTL 清掉（去重比對才不會撞上限）。
    // 「交給真人就好」：不清（見上面）；FieldValue.delete() 對不存在的欄位是 no-op
    expireAt: reason === 'handoff'
      ? FieldValue.delete()
      : Timestamp.fromMillis(Date.now() + SUGGESTION_RESOLVED_TTL_DAYS * 24 * 3600_000),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true })

  // 稽核（`C-254`）：忽略掉的是「客人一直問、AI 答不出來」的缺口。
  // ⚠️ 「不用管」不是永久消失（同主題事件數翻倍會重新浮出），備註要照實講，⛔ 不要寫成「永久忽略」
  const topic = String(data.topic ?? '')
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'knowledge.suggestionDismiss',
    targetId: id,
    before: { title: topic, itemsCount: Number(data.eventCount ?? 0) },
    note: reason === 'handoff'
      ? `「${topic}」這類問題交給真人，不補知識`
      : `「${topic}」先不處理（客人問到的次數再翻一倍的話還會再提醒一次）`,
  }, db)

  return { ok: true, reason }
})
