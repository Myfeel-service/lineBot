import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { ensureTakeoverSummary } from '~~/server/utils/conversation-summary'
import { lineUserFirestoreDocId, lineUserIdFromFirestoreDocId } from '~~/shared/line-workspace'

/**
 * POST /api/conversations/:userId/summary
 * Body: { force?: boolean }
 *
 * 產生（或沿用）「接手前要知道的事」摘要。客服按「我接手」時觸發，
 * 或在脈絡卡上按「重新整理」（force）。
 *
 * 用 POST 不是 GET：它會花 LLM 費用並寫入文件，不是可以隨便重打的讀取。
 * 權限用 agent（＝能操作對話的人才需要接手摘要，觀察者看不到接手按鈕）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')
  const userIdRaw = String(getRouterParam(event, 'userId') ?? '').trim()
  if (!userIdRaw) throw createError({ statusCode: 400, statusMessage: 'userId required' })
  const body = await readBody(event).catch(() => ({}))

  const db = getDb()
  const lineUserId = lineUserIdFromFirestoreDocId(userIdRaw, workspaceId)
  const convDocId = lineUserFirestoreDocId(lineUserId, workspaceId)

  return await ensureTakeoverSummary(db, convDocId, workspaceId, {
    force: body?.force === true,
  })
})
