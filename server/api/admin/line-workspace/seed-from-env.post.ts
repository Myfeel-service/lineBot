import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import {
  invalidateLineWorkspaceCredentialsCache,
  getLineWorkspaceCredentials,
} from '~~/server/utils/line-workspace-credentials'
import { DEFAULT_LINE_WORKSPACE_ID } from '~~/shared/line-workspace'
import { safeSecretEqual } from '~~/server/utils/cron-auth'

/**
 * POST /api/admin/line-workspace/seed-from-env
 * 將 runtimeConfig（來自 .env）的 LINE 憑證寫入 Firestore `workspaces/default`，供之後多 OA 擴充。
 *
 * 需帶與排程相同的密鑰：Header `X-Cron-Secret: <CRON_SECRET>`
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const cronSecret = String(config.cronSecret || '').trim()
  const headerSecret = String(getHeader(event, 'x-cron-secret') || '').trim()
  // 常數時間比對（`G-107`⑬）；沒設密鑰時 safeSecretEqual 一律回 false＝照舊擋
  if (!safeSecretEqual(headerSecret, cronSecret)) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  const channelAccessToken = String(config.lineChannelAccessToken || '').trim()
  const channelSecret = String(config.lineChannelSecret || '').trim()
  if (!channelAccessToken || !channelSecret) {
    throw createError({
      statusCode: 400,
      statusMessage: 'LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET 未設定，無法寫入',
    })
  }

  const defaultLiffId = String(process.env.LIFF_DEFAULT_ID || '').trim()

  const db = getDb()
  await db.collection('workspaces').doc(DEFAULT_LINE_WORKSPACE_ID).set({
    name: 'default',
    channelAccessToken,
    channelSecret,
    ...(defaultLiffId ? { defaultLiffId } : {}),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true })

  invalidateLineWorkspaceCredentialsCache()
  const check = await getLineWorkspaceCredentials(DEFAULT_LINE_WORKSPACE_ID)

  return {
    ok: true,
    id: DEFAULT_LINE_WORKSPACE_ID,
    hasDefaultLiffId: Boolean(check.defaultLiffId),
  }
})
