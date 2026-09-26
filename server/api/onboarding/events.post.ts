import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireAuth, requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { isOnboardingEvent, sanitizeEventProps } from '~~/shared/onboarding-events'

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

  const db = getDb()
  const batch = db.batch()
  let written = 0
  let unknown = 0
  for (const raw of list) {
    const name = (raw as { event?: unknown })?.event
    if (!isOnboardingEvent(name)) {
      unknown++
      continue
    }
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
  return { written, unknown, tooMany }
})
