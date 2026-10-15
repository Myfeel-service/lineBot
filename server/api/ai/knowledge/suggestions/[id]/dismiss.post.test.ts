/**
 * 「AI 建議補的知識」收掉一題的兩種收法（`C-318`，2026-10-15 拍板 `D-126`④）：
 *  ① 沒帶 reason（舊版畫面）＝「不用管」，跟改版前一樣：記下次數、180 天後 TTL 清掉、稽核講「翻倍會再提醒」
 *  ② reason＝handoff（「交給真人就好」）：記下原因、⛔ 不設 TTL（清掉這筆＝同一類又會被當成新的列出來）、稽核講「交給真人，不補知識」
 *  ③ 看不懂的 reason 400（⛔ 不默默當成「不用管」）；已處理過的 409 照舊
 * 跑在記憶體裡的假 Firestore 上，正式庫零讀零寫。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const DELETE = Symbol('FieldValue.delete')
  return {
    DELETE,
    FieldValue: { serverTimestamp: () => '__ts__', delete: () => DELETE },
    Timestamp: { fromMillis: (ms: number) => ({ toMillis: () => ms }) },
  }
})
vi.mock('firebase-admin/firestore', () => ({ FieldValue: h.FieldValue, Timestamp: h.Timestamp }))

const WS = 'ws1'
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: WS, uid: 'staff-1' })),
}))
vi.mock('~~/server/utils/ai-knowledge-suggest', () => ({
  KNOWLEDGE_SUGGESTIONS_COLLECTION: 'knowledgeSuggestions',
  SUGGESTION_RESOLVED_TTL_DAYS: 180,
}))
vi.mock('~~/server/utils/audit-log', () => ({ writeAuditLog: vi.fn(async () => {}) }))

type Doc = Record<string, any>
const STORE: Record<string, Doc> = {}
const db: any = {
  collection: () => ({
    doc: (id: string) => ({
      get: async () => ({ exists: !!STORE[id], data: () => (STORE[id] ? { ...STORE[id] } : undefined) }),
      set: async (patch: Doc) => {
        const cur = { ...(STORE[id] ?? {}) }
        for (const [k, v] of Object.entries(patch)) {
          if (v === h.DELETE) delete cur[k]
          else cur[k] = v
        }
        STORE[id] = cur
      },
    }),
  }),
}
vi.mock('~~/server/utils/firebase', () => ({ getDb: () => db }))

let body: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getRouterParam', () => 's1')
vi.stubGlobal('readBody', async () => body)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { writeAuditLog } = await import('~~/server/utils/audit-log')
const { default: handler } = await import('./dismiss.post')
const call = () => (handler as unknown as (e: unknown) => Promise<any>)({}).catch((e: any) => e)
const auditNote = () => String((vi.mocked(writeAuditLog).mock.calls[0]![0] as { note?: string }).note)

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(STORE)) delete STORE[k]
  STORE.s1 = { workspaceId: WS, status: 'pending', topic: '濾網有沒有備品', eventCount: 4 }
  body = {}
})

describe('收掉一題建議（C-318）', () => {
  it('① 沒帶 reason＝「不用管」：跟改版前一樣，180 天後清掉、翻倍會再提醒', async () => {
    const res = await call()
    expect(res).toEqual({ ok: true, reason: 'ignore' })
    expect(STORE.s1).toMatchObject({ status: 'dismissed', dismissReason: 'ignore', seenCountAtDismiss: 4 })
    expect(STORE.s1!.expireAt?.toMillis()).toBeGreaterThan(Date.now() + 170 * 24 * 3600_000)
    expect(auditNote()).toContain('再翻一倍的話還會再提醒一次')
  })

  it('② 交給真人就好：記下原因、不設 TTL、稽核照講', async () => {
    STORE.s1!.expireAt = 'old' // 就算以前留著（例如放回清單前的殘留），也要清掉
    body = { reason: 'handoff' }
    const res = await call()
    expect(res).toEqual({ ok: true, reason: 'handoff' })
    expect(STORE.s1).toMatchObject({ status: 'dismissed', dismissReason: 'handoff', seenCountAtDismiss: 4 })
    expect('expireAt' in STORE.s1!).toBe(false)
    expect(auditNote()).toBe('「濾網有沒有備品」這類問題交給真人，不補知識')
  })

  it('③ 看不懂的 reason 400，⛔ 不默默當成「不用管」；也不收前端送來的 personal_order（那是掃描自己收的）', async () => {
    for (const reason of ['hand_off', 'personal_order', 1]) {
      body = { reason }
      const err = await call()
      expect(err.statusCode).toBe(400)
    }
    expect(STORE.s1!.status).toBe('pending')
    expect(writeAuditLog).not.toHaveBeenCalled()
  })

  it('③ 已經處理過的照舊 409', async () => {
    STORE.s1!.status = 'accepted'
    body = { reason: 'handoff' }
    const err = await call()
    expect(err.statusCode).toBe(409)
    expect(STORE.s1!.status).toBe('accepted')
  })
})
