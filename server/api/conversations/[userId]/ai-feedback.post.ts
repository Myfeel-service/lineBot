import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { logAiFeedbackEvent, type AiFeedbackType } from '~~/server/utils/ai-feedback-events'
import { lineUserFirestoreDocId } from '~~/shared/line-workspace'
import type { AiConversationMeta } from '~~/shared/types/ai-knowledge'

const VALID_TYPES = new Set<AiFeedbackType>(['wrong_answer', 'draft_applied'])

function tsToMs(raw: unknown): number {
  if (!raw) return 0
  const v = raw as { toMillis?: () => number; seconds?: number; _seconds?: number }
  if (typeof v.toMillis === 'function') return v.toMillis()
  const sec = v.seconds ?? v._seconds
  return typeof sec === 'number' ? sec * 1000 : 0
}

/**
 * POST /api/conversations/:userId/ai-feedback
 * Body: { type: 'wrong_answer' | 'draft_applied', interactionAtMs }
 *
 * 客服對「畫面上那一次 AI 互動」的回饋：
 *   - wrong_answer：AI 答錯了（會進知識缺口掃描，帶當時命中的卡直接指向該修哪張）
 *   - draft_applied：採用了 AI 建議草稿（草稿品質的長期指標）
 *
 * interactionAtMs 是必填的樂觀鎖：aiMeta 只存「最近一次」，客服看著舊那題按「答錯」時
 * 客人可能已經又問了一題並被答掉。不比對的話會把回饋記到**新那題**上——
 * 指錯該修哪張卡，還把答對的題目標成答錯。不符就回 409 要前端重新載入。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')
  const userId = String(getRouterParam(event, 'userId') ?? '').trim()
  const body = await readBody(event)
  const type = String(body?.type ?? '') as AiFeedbackType
  const interactionAtMs = Number(body?.interactionAtMs ?? 0)
  if (!userId) throw createError({ statusCode: 400, statusMessage: 'userId required' })
  if (!VALID_TYPES.has(type)) throw createError({ statusCode: 400, statusMessage: 'type 不合法' })
  if (!Number.isFinite(interactionAtMs) || interactionAtMs <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'interactionAtMs required' })
  }

  const db = getDb()
  // doc id 一律用正規化後的對話文件 id：取消標記（DELETE）與「是否已標記」（ai-context）
  // 都要算出同一個 id，任何一邊用未正規化的原始參數就會對不上
  const convDocId = lineUserFirestoreDocId(userId, workspaceId)
  const snap = await db.collection('conversations').doc(convDocId).get()
  const data = snap.data() as { workspaceId?: string; aiMeta?: AiConversationMeta } | undefined
  if (!snap.exists || data?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到此對話' })
  }
  const meta = data?.aiMeta
  if (!meta?.lastQuery) {
    throw createError({ statusCode: 400, statusMessage: '這位客人沒有可回饋的 AI 互動紀錄' })
  }

  // 樂觀鎖：畫面上那一次互動必須就是現在 aiMeta 上的那一次（容許 1 秒時間戳誤差）
  const currentAtMs = tsToMs(meta.updatedAt)
  if (Math.abs(currentAtMs - interactionAtMs) > 1000) {
    throw createError({
      statusCode: 409,
      statusMessage: '這位客人已經有新的 AI 互動，請重新整理後再標記',
    })
  }

  await logAiFeedbackEvent(db, {
    workspaceId,
    userId: convDocId,
    type,
    query: String(meta.lastQuery ?? ''),
    chunkIds: (meta.lastSourceChunkIds ?? []).map(String),
    // 以 aiMeta.updatedAt 當「這一次互動」的識別 → 重複標記覆寫同一筆，不會灌大缺口計數
    interactionAtMs: currentAtMs,
  })

  return { ok: true }
})
