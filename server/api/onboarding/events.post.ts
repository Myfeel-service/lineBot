import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireAuth, requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { isOnboardingEvent, sanitizeEventProps } from '~~/shared/onboarding-events'
import { createRateLimiter } from '~~/server/utils/rate-limit'

/**
 * POST /api/onboarding/events  body: { sessionId, flow, workspaceId?, events: [{ event, props?, at? }] }
 *
 * 開通步驟紀錄（`C-250`③，`D-100` C-1）。只寫不讀（看的畫面之後再做）。
 * - 打造那一趟前幾格**還沒有帳號**（workspaceId 空）：只驗登入
 * - 有帶 workspaceId：驗他看得到這個帳號（⛔ 不讓人往別家帳號底下塞紀錄）
 * - 事件名稱照 `shared/onboarding-events.ts` 那張表收；⛔ 不認得的丟掉，但**記一筆丟了幾個**
 * ⚠️ 失敗不影響精靈：前端送完不等回應、錯了也不講（這是紀錄，不是功能）
 */
const COLLECTION = 'onboardingEvents'
const MAX_EVENTS = 30

/**
 * 每個人 10 分鐘最多寫 300 筆（`G-105`）。原本不限：任何一個 Google 帳號都能打，一次 30 筆，
 * 按住不放就是免費幫我們灌寫入費。
 * - **算的是事件數不是請求數**：一個請求最多 30 筆，只算請求的話上限要乘 30 才是真的寫入量。
 * - **key 是 uid**：這支一定要登入，uid 偽造不了（⛔ 不用 IP：開帳的人常在同一間辦公室）。
 * - 為什麼是 300：打造＋接 LINE 兩趟全走完大約 30～60 筆（多數事件一趟只記一次，最多的是
 *   一題一筆的 `profile_answer`、一樣草稿一筆的 `draft_decision`、測試對話一題一筆的
 *   `playground_sent`）；300＝同一個人 10 分鐘內連走五趟還有剩，正常用碰不到。
 * ⚠️ best-effort（單一執行個體內有效，見 `rate-limit.ts`）。
 */
const eventLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 300 })

export default defineEventHandler(async (event) => {
  const body = await readBody<{ sessionId?: unknown, flow?: unknown, workspaceId?: unknown, events?: unknown }>(event)
  const claimed = typeof body?.workspaceId === 'string' ? body.workspaceId.trim() : ''
  // ⚠️ 有帶帳號就記**驗過的那一個**（守衛自己從 body 解析），⛔ 不直接信 body 上的字串
  const ctx = claimed ? await requireWorkspaceAccess(event, 'viewer') : await requireAuth(event)
  const uid = ctx.uid
  const workspaceId = claimed ? ((ctx as { workspaceId?: string }).workspaceId || claimed) : ''

  const sessionId = String(body?.sessionId ?? '').slice(0, 40)
  const flow = body?.flow === 'line' ? 'line' : body?.flow === 'build' ? 'build' : 'other'
  const list = Array.isArray(body?.events) ? body.events.slice(0, MAX_EVENTS) : []
  const tooMany = Array.isArray(body?.events) ? Math.max(0, body.events.length - MAX_EVENTS) : 0

  const known = list.filter(raw => isOnboardingEvent((raw as { event?: unknown })?.event))
  const unknown = list.length - known.length
  // 只拿認得的事件去扣名額（不認得的本來就不寫，⛔ 不該吃掉正常事件的額度）
  const rl = eventLimiter.take(uid, known.length)
  const limited = known.length - rl.granted

  const db = getDb()
  const batch = db.batch()
  let written = 0
  for (const raw of known.slice(0, rl.granted)) {
    const name = (raw as { event?: unknown }).event as string
    const { props, dropped } = sanitizeEventProps((raw as { props?: unknown })?.props)
    const clientAt = Number((raw as { at?: unknown })?.at)
    batch.set(db.collection(COLLECTION).doc(), {
      workspaceId: workspaceId || null,
      uid,
      sessionId,
      flow,
      event: name,
      props,
      ...(dropped ? { droppedProps: dropped } : {}),
      // 前端的時間拿來排「同一場裡的先後」（送出是一批一批的）；伺服器時間拿來算「隔多久」
      ...(Number.isFinite(clientAt) && clientAt > 0 ? { clientAt } : {}),
      at: FieldValue.serverTimestamp(),
    })
    written++
  }
  if (written) await batch.commit()
  // ⛔ 過濾掉的要說得出丟了什麼（記憶 `feedback_filters_must_report_what_they_dropped`）
  if (unknown || tooMany) console.warn(`[onboarding-events] 丟掉 ${unknown} 個不認得的事件、${tooMany} 個超過一批上限的事件（session ${sessionId}）`)
  // 被節流擋掉的同樣要說得出來；同一個視窗只記第一次（猛打的人不該順便灌 log）
  if (rl.firstRejection) console.warn(`[onboarding-events] uid ${uid} 超過 10 分鐘上限，丟掉 ${limited} 個事件（之後這個視窗內再丟的不另記）`)
  return { written, unknown, tooMany, ...(limited ? { limited } : {}) }
})
