import { getDb } from '~~/server/utils/firebase'
import { requireCapability, requireSuperAdmin } from '~~/server/utils/workspace-auth'
import { AI_FEEDBACK_EVENTS_COLLECTION, markFeedbackHandled, pendingMarks, toPendingMarkEvent } from '~~/server/utils/ai-feedback-events'

/** 看近 30 天（跟知識庫「被同事標記寫錯了」同一個窗口） */
const WINDOW_DAYS = 30
/** 讀最近幾筆回饋：吃既有的 (workspaceId, createdAt) 索引，跟小幫手那顆同一個查法 */
const SCAN_LIMIT = 100
const MAX_ITEMS = 20

/**
 * 兩種「記下來了」的答錯標記，給有人看、有人收（`D-136`，2026-10-19）。
 * 以前畫面跟同事說「記下來了」，卻沒有任何地方會再出現。
 *
 * GET  /api/ai/feedback-marks
 *   同事標「這題應該交給真人」、還沒處理的那幾題（AI 設定的敏感詞卡列出來）。要 `ai.settings.write`。
 * POST /api/ai/feedback-marks  Body: { reason, ids: string[] }
 *   處理好了：
 *   - reason=should_handoff：管理員加了敏感詞並存檔、或按了「不用」。要 `ai.settings.write`，只收這個工作區的
 *   - reason=ai_mistake：超管「全站異常總覽」那份清單改好一筆。只有超管，跨工作區
 *
 * ⚠️ 刻意一支端點收兩件事：多開路由會讓不相干的 $fetch 型別推導爆掉（TS2589，見記憶 reference_nuxt_typecheck_traps）
 */
export default defineEventHandler(async (event) => {
  const method = getMethod(event)

  if (method === 'GET') {
    const { workspaceId } = await requireCapability(event, 'ai.settings.write')
    const snap = await getDb().collection(AI_FEEDBACK_EVENTS_COLLECTION)
      .where('workspaceId', '==', workspaceId)
      .orderBy('createdAt', 'desc')
      .limit(SCAN_LIMIT)
      .get()
    const items = pendingMarks(snap.docs.map(toPendingMarkEvent), 'should_handoff', Date.now() - WINDOW_DAYS * 86_400_000)
      .slice(0, MAX_ITEMS)
      .map(m => ({ id: m.id, query: m.query, createdAtMs: m.createdAtMs }))
    return { items }
  }

  if (method !== 'POST') throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })

  const body = await readBody(event)
  const reason = String(body?.reason ?? '')
  const ids: string[] = Array.isArray(body?.ids) ? body.ids.map((x: unknown) => String(x ?? '').trim()).filter(Boolean) : []
  if (!ids.length) throw createError({ statusCode: 400, statusMessage: 'ids required' })
  if (ids.length > MAX_ITEMS) throw createError({ statusCode: 400, statusMessage: `一次最多 ${MAX_ITEMS} 筆` })

  let ctx: { uid: string; workspaceId?: string }
  if (reason === 'should_handoff') {
    const { uid, workspaceId } = await requireCapability(event, 'ai.settings.write')
    ctx = { uid, workspaceId }
  }
  else if (reason === 'ai_mistake') {
    const { uid } = await requireSuperAdmin(event)
    ctx = { uid }
  }
  else {
    throw createError({ statusCode: 400, statusMessage: 'reason 不合法' })
  }

  const db = getDb()
  let handled = 0
  for (const id of ids) {
    if (await markFeedbackHandled(db, id, { reason, ...ctx })) handled++
  }
  return { ok: true, handled }
})
