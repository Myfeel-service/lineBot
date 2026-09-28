import { v4 as uuidv4 } from 'uuid'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import type { DemoLeadDoc, DemoLeadSource } from '~~/shared/types/demo-lead'
import { BILLING_PLANS, type BillingPlanId } from '~~/shared/billing/plans'
import { createRateLimiter, rateLimitClientIp } from '~~/server/utils/rate-limit'

/**
 * POST /api/leads —— 公開端點（不需登入）。
 *
 * 落地頁「預約 Demo」表單與無權限迎賓頁「加入候補名單」都打這支，把訪客留下的
 * 聯絡方式寫進 demoLeads。這是整個導購漏斗的第一站，原本表單只在前端設個
 * submitted=true、名單直接蒸發（黑洞）。
 *
 * 防灌水（公開端點必備，但刻意輕量——不擋到真人）：
 *   ① honeypot：隱藏欄位 company 有值 = 機器人，靜默回成功、不寫入
 *   ② 欄位長度上限：擋超大 payload
 *   ③ 短窗去重：同一 contact 5 分鐘內重送不重複建檔（避免手殘連點 / 重整）
 *   ④ 記憶體級 per-IP 節流：暖啟動的 Lambda 內擋連續猛送（best-effort）
 */

const FIELD_MAX = { name: 60, contact: 200, industry: 40, need: 60 } as const
const DEDUP_WINDOW_MS = 5 * 60 * 1000

// best-effort per-IP 節流：模組級 Map，僅在暖啟動的同一 Lambda 實例內有效。
// 真正擋機器人的是 honeypot；這層只是再擋一手同 IP 連續猛送。
// ⚠️ 改用共用的 `rate-limit.ts`（`G-105`）：原本那份 key 沒上限、每個 key 的時間戳陣列也會被猛送養胖。
const IP_WINDOW_MS = 10 * 60 * 1000
const IP_MAX = 8
const ipLimiter = createRateLimiter({ windowMs: IP_WINDOW_MS, max: IP_MAX })

function trim(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => ({})) as Record<string, unknown>

  // ① honeypot：真人看不到這個欄位、不會填；有值就是機器人 → 假裝成功，不寫入
  if (trim(body.company, 200)) {
    return { ok: true }
  }

  const name = trim(body.name, FIELD_MAX.name)
  const contact = trim(body.contact, FIELD_MAX.contact)
  const industry = trim(body.industry, FIELD_MAX.industry)
  const need = trim(body.need, FIELD_MAX.need)

  // 聯絡方式是唯一必填（Email 或 LINE ID 皆可，不強制 email 格式以免擋掉留 LINE ID 的人）
  if (contact.length < 3) {
    throw createError({ statusCode: 400, statusMessage: '請留下聯絡方式（Email 或 LINE ID）' })
  }
  // 明顯亂填的 email 擋一下（有 @ 才驗，沒 @ 視為 LINE ID）
  if (contact.includes('@') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) {
    throw createError({ statusCode: 400, statusMessage: 'Email 格式看起來怪怪的，請再確認一次' })
  }

  const rawSource = trim(body.source, 40)
  const source: DemoLeadSource
    = rawSource === 'welcome_waitlist' ? 'welcome_waitlist'
      : rawSource === 'other' ? 'other'
        : 'landing_demo'

  const rawPlan = trim(body.planId, 40)
  const interestedPlanId: string | null
    = rawPlan && BILLING_PLANS[rawPlan as BillingPlanId] ? rawPlan : null

  // ④ per-IP 節流（best-effort）
  // ⛔ 不用 `getRequestIP(event, { xForwardedFor: true })`：它取 X-Forwarded-For 最左邊那格，
  //    那是客人自己能填的，每次換一個值就繞過了（`G-105`）。為什麼取最右邊見 `rateLimitClientIp`。
  const ip = rateLimitClientIp(event)
  if (ipLimiter.take(ip).limited) {
    throw createError({ statusCode: 429, statusMessage: '送出太頻繁了，請稍後再試' })
  }

  const db = getDb()

  // ③ 短窗去重：同 contact 最近一筆若在 5 分鐘內，視為重送，直接回成功不重複建檔。
  //    用純 equality 查詢（無需 composite index），在記憶體比對 createdAt。
  const dupSnap = await db.collection('demoLeads')
    .where('contact', '==', contact)
    .limit(5)
    .get()
  const now = Date.now()
  const isRecentDup = dupSnap.docs.some((d) => {
    const created = d.get('createdAt')
    const ms = created instanceof Timestamp ? created.toMillis() : 0
    return ms > 0 && now - ms < DEDUP_WINDOW_MS
  })
  if (isRecentDup) {
    return { ok: true, deduped: true }
  }

  const ts = FieldValue.serverTimestamp()
  const doc: DemoLeadDoc = {
    name,
    contact,
    industry,
    need,
    interestedPlanId,
    source,
    status: 'new',
    userAgent: trim(getHeader(event, 'user-agent'), 300) || null,
    note: null,
    createdAt: ts,
    updatedAt: ts,
  }

  await db.collection('demoLeads').doc(uuidv4()).set(doc)
  return { ok: true }
})
