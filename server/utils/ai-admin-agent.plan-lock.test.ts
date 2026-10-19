/**
 * 小幫手擬推播草稿、方案做不到時（`C-352`①）：泡泡與卡片講同一句（推播頁鎖住時那一句），⛔ 不採用模型寫的「我幫你建…」。
 *
 * 以前照樣出確認卡、按了就建好一份送不出去的草稿——他到推播頁才看到那一格鎖住。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    delete: () => ({ __op: 'delete' }),
    increment: (n: number) => ({ __op: 'increment', n }),
    serverTimestamp: () => ({ __op: 'ts' }),
    vector: (v: number[]) => ({ __op: 'vector', v }),
  },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('./tagging', () => ({ addTagsToUser: vi.fn() }))
const { generateJson } = vi.hoisted(() => ({ generateJson: vi.fn() }))
vi.mock('./gemini', () => ({ generateJson }))
vi.mock('./ai-settings', () => ({ getAiSettings: async () => ({}), setAiSettings: async () => ({}) }))
const auditLogs: unknown[] = []
vi.mock('./audit-log', () => ({ writeAuditLog: async (i: unknown) => { auditLogs.push(i) } }))
vi.mock('./script-health', () => ({ invalidateScriptHealthCache: vi.fn() }))
let lock: string | null = null
vi.mock('./broadcast-plan-gate', () => ({
  broadcastPlanBlockFor: vi.fn(async () => lock),
  workspaceBroadcastTier: vi.fn(async () => null),
  assertBroadcastPlanAllows: vi.fn(async () => {}),
}))

;(globalThis as any).createError = (o: any) => Object.assign(new Error(o?.statusMessage || 'error'), o)
;(globalThis as any).useRuntimeConfig = () => ({ cronSecret: 'test-secret', firebasePrivateKey: '' })
const fetchCalls: string[] = []
;(globalThis as any).$fetch = async (url: string) => { fetchCalls.push(url); return { estimatedCount: 12 } }

const { runAdminAgentChat } = await import('./ai-admin-agent')
const { broadcastLockText } = await import('~~/shared/billing/plans')

function makeDb() {
  return {
    collection: (name: string) => {
      const rows = name === 'tags' ? [{ id: 't1', name: 'VIP' }] : []
      const chain: any = {
        where: () => chain,
        orderBy: () => chain,
        limit: () => chain,
        select: () => chain,
        get: async () => ({ size: rows.length, docs: rows.map(r => ({ id: r.id, data: () => ({ workspaceId: 'w1', ...r }) })) }),
        count: () => ({ get: async () => ({ data: () => ({ count: rows.length }) }) }),
      }
      return { ...chain, doc: () => ({ get: async () => ({ exists: false }), update: async () => {} }) }
    },
  } as any
}

const ask = () => runAdminAgentChat({
  db: makeDb(),
  workspaceId: 'w1',
  uid: 'u1',
  role: 'admin',
  message: '幫我發推播給 VIP：週末來店拿鐵第二杯半價',
  // 上一張是別件事：一般情況卡上會多一句「上面那張還沒按確定」——方案做不到的卡沒有確認鈕，那句沒有意義
  lastProposal: { opId: 'ai-settings-handoff-sla', args: { minutes: 30 } },
})

beforeEach(() => {
  generateJson.mockReset()
  auditLogs.length = 0
  fetchCalls.length = 0
  lock = null
})

describe('小幫手擬推播草稿：方案做不到時先講（C-352①）', () => {
  it('🔴 輕量方案要發給 VIP → 泡泡講「先不建」（⛔ 不是模型寫的「我幫你建…」），原因（推播頁那一句）在卡片上', async () => {
    lock = broadcastLockText('basic')
    generateJson.mockResolvedValueOnce({
      data: { action: 'propose', op: 'broadcast-draft-create', args: { name: 'VIP 半價', text: '週末來店拿鐵第二杯半價', tagName: 'VIP' }, text: '好，我幫你建一則給 VIP 的草稿。' },
      inputTokens: 5,
      outputTokens: 5,
    })

    const res = await ask()

    expect(res.reply).toBe('這則草稿先不建，建了也發不出去。')
    expect(res.reply, '⛔ 同一句話不在泡泡跟卡片各出現一次').not.toContain(lock!)
    expect(res.pendingOp?.preview.planLocked).toBe(true)
    expect(res.pendingOp?.preview.summary).toBe(lock)
    expect(res.pendingOp?.preview.warning ?? '', '⛔ 沒有確認鈕的卡不講「按這張…」').not.toContain('按這張')
    // 這一輪什麼都沒建
    expect(fetchCalls).not.toContain('/api/broadcast/create')
    expect(auditLogs).toHaveLength(0)
  })

  it('對照組：方案發得了 → 照常出確認卡、泡泡用模型那句', async () => {
    generateJson.mockResolvedValueOnce({
      data: { action: 'propose', op: 'broadcast-draft-create', args: { name: 'VIP 半價', text: '週末來店拿鐵第二杯半價', tagName: 'VIP' }, text: '好，我幫你建一則給 VIP 的草稿。' },
      inputTokens: 5,
      outputTokens: 5,
    })

    const res = await ask()

    expect(res.pendingOp?.preview.planLocked).toBeUndefined()
    expect(res.pendingOp?.preview.confirmLabel).toBe('確定建草稿')
    expect(res.reply).toContain('我幫你建')
    // 證明上一條沒有那句是因為卡片做不到，不是因為這個情境本來就不會出現
    expect(res.pendingOp?.preview.warning).toContain('按這張')
  })
})
