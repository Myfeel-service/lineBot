import { getDb } from '~~/server/utils/firebase'
import { getLineWorkspaceCredentials } from '~~/server/utils/line-workspace-credentials'
import { requireSuperAdmin } from '~~/server/utils/workspace-auth'

/**
 * POST /api/richmenu/migrate-aliases  body（或 query）: { workspaceId }
 * Uses raw fetch (not SDK) to expose LINE's actual error body.
 *
 * ⛔ 只給超管（`G-105`）：這是別名格式改版時的一次性維護端點，前端沒有任何地方呼叫它。
 * 它會把那個帳號**每一張選單的別名先刪再重建**（中間那一刻客人按選單切換會失效），
 * 原本客服級就能按＝任何客服都能隨手打斷整個帳號的選單切換。
 * workspaceId 一定要明講，⛔ 不帶就回 400（超管沒有「自己的帳號」，見 `G-104`）。
 */
export default defineEventHandler(async (event) => {
  await requireSuperAdmin(event)
  const body = await readBody(event).catch(() => null) as { workspaceId?: unknown } | null
  const workspaceId = String(body?.workspaceId || getQuery(event).workspaceId || '').trim()
  if (!workspaceId) throw createError({ statusCode: 400, statusMessage: 'workspaceId is required' })
  const { channelAccessToken: token } = await getLineWorkspaceCredentials(workspaceId)

  const db = getDb()
  const snap = await db.collection('richmenus').where('workspaceId', '==', workspaceId).get()

  const results: any[] = []

  for (const doc of snap.docs) {
    const data = doc.data()
    const firestoreId = doc.id
    // ALWAYS recalculate in correct format — max 32 chars, alphanumeric only (LINE requirement)
    // Ignore any previously stored aliasId which may have been in wrong format
    const aliasId = `rm${firestoreId.replace(/-/g, '').slice(0, 28)}`
    const richMenuId = data.richMenuId

    if (!richMenuId) {
      results.push({ id: firestoreId, name: data.name, aliasId, status: 'skipped', detail: 'no richMenuId' })
      continue
    }

    // Step 1: Delete existing alias (raw fetch, ignore all errors)
    try {
      await fetch(`https://api.line.me/v2/bot/richmenu/alias/${aliasId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
    } catch {}

    // Step 2: Create fresh alias using raw fetch to get real LINE error
    const res = await fetch('https://api.line.me/v2/bot/richmenu/alias', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ richMenuId, richMenuAliasId: aliasId }),
    })

    const resBody = await res.json().catch(() => ({}))

    if (res.ok) {
      // Save aliasId to Firestore
      await updateDoc('richmenus', firestoreId, { aliasId })
      results.push({ id: firestoreId, name: data.name, aliasId, richMenuId, status: 'created ✅' })
    } else {
      results.push({
        id: firestoreId,
        name: data.name,
        aliasId,
        richMenuId,
        status: `failed ❌ (HTTP ${res.status})`,
        detail: resBody,  // ← This is LINE's real error JSON
      })
    }
  }

  return { total: results.length, results }
})
