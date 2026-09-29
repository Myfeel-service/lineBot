import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { writeAuditLog } from '~~/server/utils/audit-log'
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
  /**
   * 為 true 時清掉本頁存的 LINE 憑證（Token／Secret，連同跟著 Token 的頻道身分）。
   * ⚠️ 名字是歷史包袱：以前真的會刪掉整份 workspaces 文件（見下方 `G-97`），前端還用這個名字呼叫。
   */
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
  const { workspaceId, uid } = await requireCapability(event, 'line.manage')
  const wid = String(workspaceId || '').trim()
  if (!wid) throw createError({ statusCode: 400, statusMessage: 'workspaceId is required' })

  const body = await readBody(event) as PutBody

  /**
   * 「清除憑證」：**只清本頁存的那幾格**，不動文件的其他部分（`G-97`，2026-09-29 權限盤點）。
   *
   * 🔴 原本是 `workspaces/{wid}.delete()`——按鈕文案寫「清掉本頁存的 Token／Secret」，
   *    實際卻把整份帳號文件刪掉，一起消失的有：
   *    - 方案與訂閱（帳號掉回免費）
   *    - 所屬組織 id（組織管理員從此進不去——他們的權限是靠這份文件上的組織 id 查出來的；
   *      組織停用也擋不到這個帳號了）
   *    - 發票抬頭
   *    按鈕目前藏著（`organization.vue` 的 showClearStoredCredentials），但 API 一直開著。
   *
   * 清的三格跟「把 Token 存成空字串」那條路一致：Token、Secret，
   * 加上跟著 Token 的頻道身分（lineBotUserId，留著會用一個對不到憑證的舊身分去擋別人綁同一個頻道）。
   * ⛔ 文件不存在就什麼都不寫：`set(merge)` 會憑空生出一份只有 updatedAt 的文件。
   */
  if (body?.clearWorkspace === true) {
    const db = getDb()
    const ref = db.collection('workspaces').doc(wid)
    const snap = await ref.get()
    const previous = snap.exists ? snap.data() as Record<string, unknown> : null
    const CREDENTIAL_FIELDS = ['channelAccessToken', 'channelSecret', 'lineBotUserId'] as const
    const present = CREDENTIAL_FIELDS.filter(k => previous?.[k] !== undefined)
    if (present.length) {
      await ref.set({
        ...Object.fromEntries(present.map(k => [k, FieldValue.delete()])),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true })
    }
    invalidateLineWorkspaceCredentialsCache()
    // 紀錄照舊要寫（清掉憑證＝這個帳號收不到訊息了，事後要查得到是誰清的）。
    // ⛔ 只記「哪幾格被清」，值本身不進紀錄（跟下方 line-workspace.put 同一種寫法，畫面印出來也一樣）；
    //    一格都沒有就不寫，免得留一筆「清掉了 0 項」
    if (present.length) await writeAuditLog({
      workspaceId,
      uid,
      actor: 'human',
      action: 'line-workspace.clear',
      after: Object.fromEntries(present.map(k => [k, '（已清除）'])),
      note: `清掉本頁存的 LINE 憑證（${present.length} 項）；方案、所屬組織、發票抬頭等其他設定不受影響`,
    })
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

  // 哪幾格的值**真的變了**（拿存檔前那份快照比對；清除算一種變動）
  const changedKeys = Object.keys(updates).filter((k) => {
    if (k === 'updatedAt') return false
    const next = updates[k] as any
    const prev = (previous as Record<string, unknown> | null)?.[k]
    if (next?.methodName === 'FieldValue.delete') return prev !== undefined
    return JSON.stringify(prev ?? null) !== JSON.stringify(next ?? null)
  })

  // 操作紀錄：⛔只記「哪幾項被動過」，值本身由稽核層遮罩（憑證絕不可落進紀錄裡，
  // 那會讓稽核自己變成第二個外洩面）。換過鑰匙卻查不到是誰換的，是最不該有的空白。
  // ⛔ 一格都沒變就整筆不寫：留一筆「更新了 0 項」只會把真正的變更淹掉。
  if (changedKeys.length) await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'line-workspace.put',
    // ⛔ 只記「值真的變了」的那幾格。
    //    排掉 updatedAt 還不夠：這一頁每次存檔都會把某些欄位原封不動一起送上來
    //    （組織頁固定帶 defaultLiffId），照單全收的話，什麼都沒改按一下存檔
    //    也會留一筆「更新了 1 項 LINE 連線設定」——而這一頁存在的理由
    //    正是回答「憑證是誰換的」，多報一項就是在紀錄裡說謊。
    after: Object.fromEntries(changedKeys.map(k =>
      [k, (updates[k] as any)?.methodName === 'FieldValue.delete' ? '（已清除）' : '（已更新）'],
    )),
    note: `更新了 ${changedKeys.length} 項 LINE 連線設定`,
  })
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
