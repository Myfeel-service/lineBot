import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import {
  invalidateLineWorkspaceCredentialsCache,
} from '~~/server/utils/line-workspace-credentials'
import {
  fetchLineWebhookEndpoint,
  postLineWebhookTest,
} from '~~/server/utils/line-webhook-remote'
import {
  channelConflictMessage,
  checkChannelBindingConflict,
  rememberChannelBinding,
} from '~~/server/utils/line-channel-binding'

type PutBody = {
  name?: string
  defaultLiffId?: string
  channelAccessToken?: string
  channelSecret?: string
  /** 為 true 時刪除整份 workspaces/default。 */
  clearWorkspace?: boolean
  /** 為 true 時：儲存後自動呼叫 LINE 測試 Webhook；失敗僅回傳警告，不回滾憑證。 */
  verifyWebhookOnSave?: boolean
  /** 可選：期望與 LINE 後台登記的 Webhook URL 比對。 */
  compareWebhookUrl?: string
}

type WebhookVerificationResult = {
  ok: boolean
  message: string
}

function normalizeWebhookUrl(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  try {
    const u = new URL(s)
    u.hash = ''
    let path = u.pathname.replace(/\/+$/, '') || '/'
    if (path !== '/' && path.endsWith('/')) path = path.slice(0, -1)
    u.pathname = path
    return u.href.replace(/\/$/, '')
  }
  catch {
    return s.replace(/\/+$/, '')
  }
}

/**
 * PUT /api/admin/line-workspace
 * 以 merge 更新。`channelAccessToken` / `channelSecret` 僅在 body 含該欄位時寫入；
 * 傳空字串表示刪除該欄位（改由環境變數補齊）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'admin')
  const wid = String(workspaceId || '').trim()
  if (!wid) throw createError({ statusCode: 400, statusMessage: 'workspaceId is required' })

  const body = await readBody(event) as PutBody

  if (body?.clearWorkspace === true) {
    const db = getDb()
    await db.collection('workspaces').doc(wid).delete().catch(() => {})
    invalidateLineWorkspaceCredentialsCache()
    return { ok: true, id: wid, cleared: true }
  }

  const db = getDb()
  const ref = db.collection('workspaces').doc(wid)
  const snap = await ref.get()
  const previous = snap.exists ? snap.data() as Record<string, unknown> : null

  const updates: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  }

  if (body?.name !== undefined) {
    updates.name = String(body.name).trim() || wid
  }
  else if (!snap.exists) {
    updates.name = wid
  }

  if (Object.prototype.hasOwnProperty.call(body, 'defaultLiffId')) {
    const v = String(body.defaultLiffId ?? '').trim()
    updates.defaultLiffId = v ? v : FieldValue.delete()
  }

  /** 這次存進去的頻道身分（存檔成功後記在文件上，之後比對免再打 LINE） */
  let boundBotUserId = ''

  if (Object.prototype.hasOwnProperty.call(body, 'channelAccessToken')) {
    const v = String(body.channelAccessToken ?? '').trim()

    // 存檔前先擋「這個官方帳號已經被別的工作區接走了」（2026-08-19 老闆實測挖出、
    // 08-21 拍板「要擋」）。同一個頻道被兩邊綁著時，客人訊息會整批進到簽章先對上的
    // 那一邊，這邊一則都收不到，而且所有檢查都會是綠的——事後幾乎查不出來，
    // 所以只能在寫進去的當下攔。
    // ⛔ 問不到頻道身分時放行：我方連不出去不該變成客戶不能上線。
    if (v) {
      const { identity, conflicts } = await checkChannelBindingConflict(db, wid, v)
      if (conflicts.length) {
        throw createError({
          statusCode: 409,
          statusMessage: channelConflictMessage(conflicts),
          data: { reason: 'lineChannelAlreadyBound', conflicts },
        })
      }
      if (identity.kind === 'ok') boundBotUserId = identity.botUserId
    }

    updates.channelAccessToken = v ? v : FieldValue.delete()
    // 憑證被清掉時頻道身分要跟著清，否則會留著一個對不到憑證的舊身分去擋別人
    if (!v) updates.lineBotUserId = FieldValue.delete()
  }

  if (Object.prototype.hasOwnProperty.call(body, 'channelSecret')) {
    const v = String(body.channelSecret ?? '').trim()
    updates.channelSecret = v ? v : FieldValue.delete()
  }

  await ref.set(updates, { merge: true })
  invalidateLineWorkspaceCredentialsCache()
  if (boundBotUserId) await rememberChannelBinding(db, wid, boundBotUserId)

  let webhookVerification: WebhookVerificationResult | undefined

  if (body?.verifyWebhookOnSave === true) {
    const merged = {
      ...(previous || {}),
      ...updates,
    } as Record<string, unknown>
    const channelAccessToken = String(merged.channelAccessToken ?? '').trim()
    const compareWebhookUrl = normalizeWebhookUrl(String(body.compareWebhookUrl ?? ''))

    if (!channelAccessToken) {
      webhookVerification = {
        ok: false,
        message: '已儲存，但 Firestore 仍缺少 Channel Access Token，無法驗證 Webhook',
      }
    }
    else {
      const getRes = await fetchLineWebhookEndpoint(channelAccessToken)
      if (!getRes.ok) {
        webhookVerification = {
          ok: false,
          message: getRes.status === 404
            ? '已儲存，但 LINE 後台尚未設定 Webhook URL'
            : `已儲存，但 LINE 查詢 Webhook 失敗（HTTP ${getRes.status}）`,
        }
      }
      else if (compareWebhookUrl) {
        const endpoint = normalizeWebhookUrl(String(getRes.data.endpoint || ''))
        if (endpoint !== compareWebhookUrl) {
          webhookVerification = {
            ok: false,
            message: '已儲存，但 LINE 後台 Webhook URL 與系統網址不一致',
          }
        }
      }

      if (!webhookVerification) {
        const testRes = await postLineWebhookTest(channelAccessToken, {})
        if (!testRes.ok) {
          webhookVerification = {
            ok: false,
            message: `已儲存，但 LINE 測試 API 失敗（HTTP ${testRes.status}）`,
          }
        }
        else if (!testRes.data.success) {
          webhookVerification = {
            ok: false,
            message: `已儲存，但 Webhook 測試未通過（${testRes.data.reason || 'UNKNOWN'}${testRes.data.statusCode != null ? ` / HTTP ${testRes.data.statusCode}` : ''}）`,
          }
        }
        else {
          webhookVerification = {
            ok: true,
            message: '已儲存，Webhook 驗證通過',
          }
        }
      }
    }
  }

  return { ok: true, id: wid, webhookVerification }
})
