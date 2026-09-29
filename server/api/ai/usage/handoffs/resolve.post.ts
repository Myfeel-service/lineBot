import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { lineUserFirestoreDocId } from '~~/shared/line-workspace'

/**
 * POST /api/ai/usage/handoffs/resolve
 * Body: { userId }
 *
 * 把監控頁「轉真人案例」標記為已處理（補卡完成 / 不需處理）。
 * 寫 aiMeta.handoffResolvedAt；之後若同客人又發生新 handoff（aiMeta.updatedAt 更新），
 * 案例會自動回到未處理狀態（resolvedAt < updatedAt）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'knowledge.write')
  const body = await readBody(event)
  const userId = String(body?.userId ?? '').trim()
  if (!userId) throw createError({ statusCode: 400, statusMessage: 'userId required' })

  const db = getDb()
  const ref = db.collection('conversations').doc(lineUserFirestoreDocId(userId, workspaceId))
  const snap = await ref.get()
  if (!snap.exists || snap.data()?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到此對話' })
  }

  await ref.set({
    aiMeta: { handoffResolvedAt: FieldValue.serverTimestamp() },
  }, { merge: true })

  return { ok: true }
})
