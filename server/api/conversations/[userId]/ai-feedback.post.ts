import type { Firestore } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { chunkContentFingerprint, logAiFeedbackEvent, type AiFeedbackType } from '~~/server/utils/ai-feedback-events'
import { AI_TURNS_COLLECTION } from '~~/server/utils/ai-turns'
import { KNOWLEDGE_CHUNKS_COLLECTION } from '~~/server/utils/ai-knowledge-chunks'
import { lineUserFirestoreDocId } from '~~/shared/line-workspace'
import { isWrongAnswerReason, type AiConversationMeta, type AiTurnDoc, type WrongAnswerReason } from '~~/shared/types/ai-knowledge'

const VALID_TYPES = new Set<AiFeedbackType>(['wrong_answer', 'draft_applied'])

/**
 * 「資料寫錯」選的那一條（`D-135`）：⛔ 只收當時撈到的那幾條裡的（不能借這支把任意一條標成寫錯），
 * 而且要同一個工作區；順便記下標記當下的內容指紋，之後看內容有沒有變來判斷改好了沒。
 * 卡不在了、或不是這個工作區的＝回 null（不擋標記本身，只是不列進待辦）；讀卡暫時失敗＝照記、指紋留空。
 */
async function pickChunk(
  db: Firestore,
  workspaceId: string,
  chunkId: string,
  citedIds: string[],
): Promise<{ chunkId: string; contentHash: string } | null> {
  if (!chunkId) return null
  if (!citedIds.includes(chunkId)) {
    throw createError({ statusCode: 400, statusMessage: '選的那一條不是 AI 這次參考的知識' })
  }
  const snap = await db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(chunkId).get().catch(() => null)
  // 讀卡暫時失敗：照樣記下是哪一條、指紋留空＝「當成還沒改」（寧可多掛著，也不要整筆不見，`/code-review` 10-19）。
  // ⚠️ chunkId 已經確認是這次撈到的那幾條之一（上面那關），不會借這裡把別家的掛上去
  if (!snap) return { chunkId, contentHash: '' }
  const data = snap.data() as { workspaceId?: string; content?: string } | undefined
  if (!snap.exists || data?.workspaceId !== workspaceId) return null
  return { chunkId, contentHash: chunkContentFingerprint(data?.content) }
}

function tsToMs(raw: unknown): number {
  if (!raw) return 0
  const v = raw as { toMillis?: () => number; seconds?: number; _seconds?: number }
  if (typeof v.toMillis === 'function') return v.toMillis()
  const sec = v.seconds ?? v._seconds
  return typeof sec === 'number' ? sec * 1000 : 0
}

/**
 * POST /api/conversations/:userId/ai-feedback
 * Body: { type, turnId }  ← 新路徑
 *       { type, interactionAtMs }  ← 舊路徑（見下）
 *       wrong_answer 另帶 reason（錯在哪，`D-135`）；reason=wrong_data 時可帶 chunkId（寫錯的那一條）。
 *       同一次回答再送一次＝覆寫（改選原因、補上是哪一條都走這條）。
 *
 * 客服對「某一則 AI 回覆」的回饋：
 *   - wrong_answer：AI 答錯了（會進知識缺口掃描，帶當時命中的卡直接指向該修哪張）
 *   - draft_applied：採用了 AI 建議草稿（草稿品質的長期指標）
 *
 * **turnId 路徑（新）**：回合快照是 append-only 的，標的是哪一次由 id 本身決定，
 * 不需要樂觀鎖——客人之後再問幾題都不影響，舊回合照樣標得到、也取消得掉。
 *
 * **interactionAtMs 路徑（舊）**：給這功能上線前送出、訊息上沒有 aiTurnId 的回覆用。
 * aiMeta 只存「最近一次」，客服看著舊那題按「答錯」時客人可能已經又問了一題並被答掉；
 * 不比對的話會把回饋記到**新那題**上——指錯該修哪張卡，還把答對的題目標成答錯。
 * 所以這條路徑仍保留 409 樂觀鎖。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'conversations.reply')
  const userId = String(getRouterParam(event, 'userId') ?? '').trim()
  const body = await readBody(event)
  const type = String(body?.type ?? '') as AiFeedbackType
  const turnId = String(body?.turnId ?? '').trim()
  const interactionAtMs = Number(body?.interactionAtMs ?? 0)
  /**
   * 錯在哪（`D-135`）：wrong_answer 一定要帶——畫面先問再送。
   * ⛔ 不帶就擋：還開著舊版畫面的分頁送來的標記沒有原因，收下來又是一筆分不出錯在哪、也不會出現在任何待辦的紀錄
   */
  const rawReason = body?.reason
  const reason: WrongAnswerReason | undefined = isWrongAnswerReason(rawReason) ? rawReason : undefined
  /** reason=wrong_data 時選的那一條（可以先不帶：選了原因、還沒選是哪一條，之後再送一次補上） */
  const chunkId = String(body?.chunkId ?? '').trim()
  if (!userId) throw createError({ statusCode: 400, statusMessage: 'userId required' })
  if (!VALID_TYPES.has(type)) throw createError({ statusCode: 400, statusMessage: 'type 不合法' })
  if (type === 'wrong_answer' && !reason) {
    throw createError({ statusCode: 400, statusMessage: '請先選這題錯在哪（畫面是舊的話請重新整理）' })
  }
  if (chunkId && reason !== 'wrong_data') {
    throw createError({ statusCode: 400, statusMessage: '只有「資料寫錯或過期了」才選是哪一條' })
  }
  if (!turnId && (!Number.isFinite(interactionAtMs) || interactionAtMs <= 0)) {
    throw createError({ statusCode: 400, statusMessage: 'turnId 或 interactionAtMs 必須擇一' })
  }

  const db = getDb()
  // doc id 一律用正規化後的對話文件 id：取消標記（DELETE）與「是否已標記」（ai-context / ai-turn）
  // 都要算出同一個 id，任何一邊用未正規化的原始參數就會對不上
  const convDocId = lineUserFirestoreDocId(userId, workspaceId)
  const snap = await db.collection('conversations').doc(convDocId).get()
  const data = snap.data() as { workspaceId?: string; aiMeta?: AiConversationMeta } | undefined
  if (!snap.exists || data?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到此對話' })
  }

  // ── 新路徑：回饋綁在那一次回合上 ─────────────────────────────
  if (turnId) {
    const turnSnap = await db.collection('conversations').doc(convDocId)
      .collection(AI_TURNS_COLLECTION).doc(turnId).get()
    if (!turnSnap.exists) {
      throw createError({ statusCode: 404, statusMessage: '找不到這一次 AI 回合' })
    }
    const turn = turnSnap.data() as AiTurnDoc
    if (turn.workspaceId !== workspaceId) {
      throw createError({ statusCode: 404, statusMessage: '找不到這一次 AI 回合' })
    }
    const citedIds = (turn.sourceChunkIds ?? []).map(String)
    const picked = await pickChunk(db, workspaceId, chunkId, citedIds)
    await logAiFeedbackEvent(db, {
      workspaceId,
      userId: convDocId,
      type,
      query: String(turn.query ?? ''),
      chunkIds: citedIds,
      turnId,
      ...(reason ? { reason } : {}),
      ...(picked ? { pickedChunks: [picked] } : {}),
      ...(uid ? { markedBy: uid } : {}),
    })
    return { ok: true }
  }

  // ── 舊路徑：只認得「最近一次」，所以要比對現況 ─────────────────
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

  const citedIds = (meta.lastSourceChunkIds ?? []).map(String)
  const picked = await pickChunk(db, workspaceId, chunkId, citedIds)
  await logAiFeedbackEvent(db, {
    workspaceId,
    userId: convDocId,
    type,
    query: String(meta.lastQuery ?? ''),
    chunkIds: citedIds,
    // 以 aiMeta.updatedAt 當「這一次互動」的識別 → 重複標記覆寫同一筆，不會灌大缺口計數
    interactionAtMs: currentAtMs,
    ...(reason ? { reason } : {}),
    ...(picked ? { pickedChunks: [picked] } : {}),
    ...(uid ? { markedBy: uid } : {}),
  })

  return { ok: true }
})
