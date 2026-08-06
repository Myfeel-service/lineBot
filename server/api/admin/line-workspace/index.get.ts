import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { getLineWorkspaceCredentials } from '~~/server/utils/line-workspace-credentials'
import type { LineWorkspaceDoc } from '~~/shared/line-workspace'

function secretSuffix(value: unknown): { configured: boolean; suffix: string | null } {
  const v = String(value ?? '').trim()
  if (!v) return { configured: false, suffix: null }
  /** 過短時不揭露末四碼，避免外洩完整 secret／token */
  if (v.length < 12) return { configured: true, suffix: null }
  return { configured: true, suffix: v.slice(-4) }
}

/**
 * GET /api/admin/line-workspace
 * 回傳目前 workspaces/default 狀態（不含完整 secret／token）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'admin')
  const wid = String(workspaceId || '').trim()
  if (!wid) throw createError({ statusCode: 400, statusMessage: 'workspaceId is required' })

  // 對外正式網址（PUBLIC_BASE_URL）。設定頁要拿它組「貼到 LINE 的網址」、以及跟 LINE 上
  // 已設定的網址比對——不能用瀏覽器當下的網址：同一套系統可能有自訂網域＋amplifyapp
  // 兩個入口，拿瀏覽網址比會誤判「LINE 填錯了」。沒設定就回空字串，前端退回瀏覽網址。
  const publicBaseUrl = String(useRuntimeConfig(event).appBaseUrl || '').trim().replace(/\/$/, '')

  const db = getDb()
  const snap = await db.collection('workspaces').doc(wid).get()
  const saved = snap.exists ? (snap.data() as LineWorkspaceDoc) : null

  const access = secretSuffix(saved?.channelAccessToken)
  const secret = secretSuffix(saved?.channelSecret)

  const creds = await getLineWorkspaceCredentials(wid)

  return {
    id: wid,
    publicBaseUrl,
    savedInFirestore: snap.exists,
    name: String(saved?.name ?? '').trim() || wid,
    defaultLiffId: String(saved?.defaultLiffId ?? '').trim(),
    /** 實際用於 CTA fallback（僅 Firestore） */
    effectiveDefaultLiffId: String(creds.defaultLiffId ?? '').trim(),
    channelAccessTokenConfigured: access.configured,
    channelAccessTokenSuffix: access.suffix,
    channelSecretConfigured: secret.configured,
    channelSecretSuffix: secret.suffix,
  }
})
