import { describe, expect, it, vi } from 'vitest'

/**
 * 每日對帳把「扣不到款、寬限期滿」的降級落地時，要在訂閱上留一筆紀錄（`B-16`）：
 * 「已降回免費」通知信照它寄、超管扣款失敗清單照它列。少了這筆，降級之後什麼都不會發生——
 * 以前就是這樣，客人是發現 AI 沒在回才知道。降級本身不變（只多寫一格）。
 */

vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('./payuni', () => ({ cancelCardBinding: vi.fn() }))

const { runPaymentReconcile } = await import('./payment')
import type { WorkspaceSubscription } from '~~/shared/billing/plans'

function makeDb(workspaces: Record<string, { subscription: WorkspaceSubscription }>) {
  const writes = new Map<string, any>()
  const docs = (filter: (s: WorkspaceSubscription) => boolean) => Object.entries(workspaces)
    .filter(([, w]) => filter(w.subscription))
    .map(([id, w]) => ({ id, data: () => w, ref: { update: async (d: any) => { writes.set(id, d) } } }))
  return {
    writes,
    collection: (c: string) => ({
      where: (field: string, op: string, value: unknown) => ({
        async get() {
          if (c !== 'workspaces') return { docs: [] }
          if (field === 'subscription.currentPeriodEnd' && op === '<')
            return { docs: docs(s => (s.currentPeriodEnd ?? '') < (value as string)) }
          if (field === 'subscription.status' && op === '==')
            return { docs: docs(s => s.status === value) }
          throw new Error(`unexpected query ${field} ${op}`)
        },
      }),
    }),
  }
}

// 2026-10-20 台北
const OCT20 = new Date(Date.UTC(2026, 9, 20, 1, 0, 0))

const pastDue = (over: Partial<WorkspaceSubscription> = {}): WorkspaceSubscription => ({
  planId: 'starter', status: 'past_due', currentPeriodStart: '2026-10-16', currentPeriodEnd: '2026-11-15', anchorDay: 16,
  autoRenew: true, payuniCardToken: 'HASH1', lastChargeError: '授權失敗', ...over,
})

describe('runPaymentReconcile — 扣不到款降級時留紀錄（`B-16`）', () => {
  it('🔴 寬限期滿（10/16 那期、10/19 最後一天）→ 降回免費＋記下從哪個方案、哪天降、信還沒寄', async () => {
    const db = makeDb({ ws1: { subscription: pastDue() } })
    const r = await runPaymentReconcile(OCT20, db as any, null)
    expect(r.downgraded).toBe(1)
    const sub = db.writes.get('ws1').subscription as WorkspaceSubscription
    expect(sub.planId).toBe('free')
    expect(sub.nonPaymentDowngrade).toEqual({ fromPlanId: 'starter', on: '2026-10-20', emailSent: false })
  })

  it('還在寬限期 → 不降、不留紀錄', async () => {
    const db = makeDb({ ws1: { subscription: pastDue({ currentPeriodStart: '2026-10-18', currentPeriodEnd: '2026-11-17', anchorDay: 18 }) } })
    await runPaymentReconcile(OCT20, db as any, null)
    expect(db.writes.get('ws1')?.subscription?.nonPaymentDowngrade).toBeUndefined()
  })

  it('客戶自己按了取消、到期降回免費 → 不留（那不是扣款失敗，不寄「扣不到款」的信）', async () => {
    const sub: WorkspaceSubscription = { ...pastDue(), status: 'active', currentPeriodStart: '2026-09-16', currentPeriodEnd: '2026-10-15', cancelAtPeriodEnd: true }
    const db = makeDb({ ws1: { subscription: sub } })
    const r = await runPaymentReconcile(OCT20, db as any, null)
    expect(r.downgraded).toBe(1)
    expect(db.writes.get('ws1').subscription.nonPaymentDowngrade).toBeUndefined()
  })
})
