import { v4 as uuidv4 } from 'uuid'
import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { capMapSize } from '~~/server/utils/bounded-cache'
import {
  broadcastEverHandedToSender,
  clickTargetInBroadcast,
  collectClickTrackableUris,
} from '~~/server/utils/broadcast-click-track'
import { renderModuleToLineMessages } from '~~/server/utils/handler'
import { extractBroadcastTriggerModuleId } from '~~/shared/broadcast-content'
import type { BroadcastClickLogDoc } from '~~/shared/types/tag-broadcast'

/**
 * GET /api/r/:token
 * 推播點擊追蹤 redirect
 *
 * token 格式（Base64url）:
 *   `${campaignId}|${deliveryId}|${userId}|${linkKey}|${targetUrl}`
 *
 * 流程：
 * 1. 解碼 token
 * 2. 拿推播本身驗證目標網址（`G-95`，見下）
 * 3. 寫入 broadcastClickLogs
 * 4. 302 redirect 到 targetUrl
 *
 * 若 token 無效，直接 redirect 到首頁，不顯示錯誤頁
 *
 * 🔴 `G-95`：token 沒有簽章，以前只看網址是不是 http 開頭就轉＝任何人都能組出
 * 「我們網域 → 任何網站」的連結拿去釣魚，還能灌那則推播的點擊數、每打一次寫一筆。
 *
 * ⛔ **為什麼是「驗證」而不是「改成簽章」**：已經發出去的推播，連結躺在客人的 LINE 聊天紀錄裡，
 * 一則都收不回來。改成要簽章的話，那些舊連結全部失效——客人點了只會回首頁。
 * 所以改成：推播必須存在、必須真的送出過，而且目標網址必須是**那則推播送出時真的包過的網址**
 * （跟包裝走同一條版型走法，見 `broadcast-click-track.ts`）。對不上一律回首頁、⛔ 不記點擊。
 * 這樣舊連結照樣能用，偽造的連結只能轉到那家自己放進推播的網址（＝本來就會轉的地方）。
 *
 * ⚠️ 模組型推播（`messages` 是一張「觸發模組」的卡、送出時整份換成模組內容）：
 *   ① `C-246` 之後送的看 `sentContent.messages`（當時內容）；
 *   ② 更早送的沒有留存，只能拿**模組現在的內容**照送出的方式重新組一次再比。
 *   ⚠️ 所以：更早送出、而且模組後來把那個網址改掉的舊連結，會對不上、回首頁。這是沒有留存
 *      當時內容的代價，⛔ 不用「同網域就放行」補——那等於把這個洞留一半。
 */

/** 模組現在的內容算出來的網址集合，短暫快取：公開端點，⛔ 不能讓每一次亂點都重組一次模組 */
const MODULE_URIS_TTL_MS = 5 * 60 * 1000
const MODULE_URIS_MAX_ENTRIES = 500
const moduleUrisCache = new Map<string, { uris: Set<string>, expiresAt: number }>()

async function urisFromCurrentModule(
  campaignId: string,
  campaign: { workspaceId?: unknown, messages?: unknown },
): Promise<Set<string>> {
  const moduleId = extractBroadcastTriggerModuleId(campaign.messages as unknown[])
  const workspaceId = String(campaign.workspaceId || '').trim()
  if (!moduleId || !workspaceId) return new Set()

  const hit = moduleUrisCache.get(campaignId)
  if (hit && hit.expiresAt > Date.now()) return hit.uris

  // 跟送出端（`broadcast-send.ts`）同一個組法、同一個 requestOrigin，組出來的網址才會一樣
  const requestOrigin = String(useRuntimeConfig().clickTrackingBaseUrl || '').trim().replace(/\/$/, '')
  const rendered = await renderModuleToLineMessages(moduleId, { workspaceId, requestOrigin }).catch((e) => {
    console.warn('[click-track] 重組模組失敗，當作對不上:', String((e as Error)?.message ?? e).slice(0, 160))
    return null
  })
  const uris = collectClickTrackableUris(rendered?.lineMessages ?? [])
  moduleUrisCache.set(campaignId, { uris, expiresAt: Date.now() + MODULE_URIS_TTL_MS })
  capMapSize(moduleUrisCache, MODULE_URIS_MAX_ENTRIES)
  return uris
}

export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, 'token')

  if (!token) {
    return sendRedirect(event, '/', 302)
  }

  let campaignId = ''
  let deliveryId = ''
  let userId = ''
  let linkKey = ''
  let targetUrl = ''

  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf-8')
    const parts = decoded.split('|')
    if (parts.length < 5) throw new Error('invalid token')
    const restParts = parts.slice(4)
    campaignId = parts[0] ?? ''
    deliveryId = parts[1] ?? ''
    userId = parts[2] ?? ''
    linkKey = parts[3] ?? ''
    targetUrl = restParts.join('|') // URL 本身可能含 | 符號
  }
  catch {
    return sendRedirect(event, '/', 302)
  }

  if (!targetUrl.startsWith('http') || !campaignId) {
    return sendRedirect(event, '/', 302)
  }

  // ⚠️ campaignId 是 token 裡的任意字串：含 `/` 之類的值 `.doc()` 會直接丟例外，一律當「沒有這則」。
  //    讀不到（庫掛了）也一樣回首頁：驗不了就不轉，⛔ 不可以退回「先轉再說」——那就是開放轉址
  const campaign = await (async () => {
    try {
      const snap = await getDb().collection('broadcasts').doc(campaignId).get()
      return snap.exists ? (snap.data() as Record<string, unknown>) : null
    }
    catch {
      return null
    }
  })()

  const allowed = campaign !== null
    && broadcastEverHandedToSender(campaign)
    && (clickTargetInBroadcast(targetUrl, campaign)
      || (await urisFromCurrentModule(campaignId, campaign)).has(targetUrl.trim()))
  if (!campaign || !allowed) {
    // ⛔ 對不上就不記、不轉：記了就是讓人灌點擊數；轉了就是開放轉址。丟了什麼留一行
    let host = ''
    try { host = new URL(targetUrl).host } catch { /* 網址本身壞掉，host 留空 */ }
    console.warn('[click-track] 目標網址對不上推播，回首頁不記點擊:', campaignId.slice(0, 64), host.slice(0, 100), campaign ? '' : '(沒有這則推播)')
    return sendRedirect(event, '/', 302)
  }

  // 寫入點擊 log（非同步，不阻塞 redirect）
  try {
    const db = getDb()
    // token 不含 workspaceId（舊格式），從 campaign doc 補查；查不到留空字串
    const workspaceId = String(campaign.workspaceId || '').trim()
    const logDoc: BroadcastClickLogDoc = {
      workspaceId,
      campaignId,
      deliveryId: deliveryId || null,
      userId: userId || null,
      linkKey,
      targetUrl,
      clickedAt: FieldValue.serverTimestamp(),
    }
    await db.collection('broadcastClickLogs').doc(uuidv4()).set(logDoc)
  }
  catch (err) {
    console.error('[click-track] Failed to write click log:', err)
  }

  return sendRedirect(event, targetUrl, 302)
})
