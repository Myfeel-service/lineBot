import { getDb } from '~~/server/utils/firebase'
import { requireSuperAdmin } from '~~/server/utils/workspace-auth'

/**
 * GET /api/richmenu/debug-aliases?workspaceId=...
 * Query LINE directly to see what aliases actually exist and what richMenuId they point to.
 *
 * ⛔ 只給超管（`G-105`）：這是當初查「選單切換失效」用的除錯端點，前端沒有任何地方呼叫它。
 * 原本客服級就能打＝任何客服都能拿它反覆打 LINE API、看 LINE 的原始錯誤回應。
 * 超管沒有「自己的帳號」，所以 workspaceId 一定要明講（⛔ 不帶就回 400，不可以變成全站範圍——
 * 見 `G-104`「超管沒帶帳號 id 時會變成全站範圍」）。
 */
export default defineEventHandler(async (event) => {
  await requireSuperAdmin(event)
  const workspaceId = String(getQuery(event).workspaceId || '').trim()
  if (!workspaceId) throw createError({ statusCode: 400, statusMessage: 'workspaceId is required' })
  const db = getDb()
  const snap = await db.collection('richmenus').where('workspaceId', '==', workspaceId).get()

  const results = []

  for (const doc of snap.docs) {
    const data = doc.data()
    const aliasId = data.aliasId ?? `rm${doc.id.replace(/-/g, '').slice(0, 28)}`

    let lineStatus: any = null
    try {
      lineStatus = await getRichMenuAlias(aliasId, workspaceId)
    } catch (e: any) {
      lineStatus = { error: e.message ?? String(e) }
    }

    results.push({
      firestoreId: doc.id,
      name: data.name,
      richMenuId: data.richMenuId,      // What Firestore thinks the richMenuId is
      aliasId,
      lineAlias: lineStatus,            // What LINE actually has for this alias
    })
  }

  return results
})
