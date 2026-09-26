/**
 * 加進通知名單（`C-250`③：開帳按了「是我」的那支手機）。
 *
 * ⭐ 為什麼要有：綁定手機原本不會加進名單——「客人要找你本人、早上的摘要會傳到這支手機」
 *    就只是一句沒人兌現的話。這裡守三件事：加得進去、不擠掉別人、不替他打開他刻意關掉的通知。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { store } = vi.hoisted(() => ({ store: { doc: null as any, writes: [] as any[] } }))
vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => ({}), delete: () => ({}) } }))
vi.mock('./firebase', () => ({
  getDb: () => ({
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: store.doc != null, data: () => store.doc }),
        update: async (p: any) => { store.writes.push({ kind: 'update', p }) },
        set: async (p: any) => { store.writes.push({ kind: 'set', p }) },
      }),
    }),
  }),
}))
vi.mock('./ai-settings', () => ({ AI_SETTINGS_COLLECTION: 'aiSettings', invalidateAiSettingsCache: vi.fn() }))
vi.mock('./line', () => ({ getUserProfile: vi.fn(), replyMessage: vi.fn() }))
vi.mock('./line-oa-basic-id', () => ({ resolveLineOaBasicId: vi.fn() }))

import { addToHandoffNotify, HANDOFF_NOTIFY_MAX } from './member-line-bind'

beforeEach(() => {
  store.doc = null
  store.writes = []
})

describe('addToHandoffNotify', () => {
  it('新帳號（名單空的）：加進去、順手把通知打開', async () => {
    store.doc = { handoffNotify: { enabled: false, lineUserIds: [] } }
    expect(await addToHandoffNotify('w', 'U1', '王小明')).toBe('added')
    const p = store.writes[0].p
    expect(p['handoffNotify.lineUserIds']).toEqual(['U1'])
    expect(p['handoffNotify.enabled']).toBe(true)
    expect(p['handoffNotify.displayNames']).toEqual({ U1: '王小明' })
  })

  it('⛔ 名單有人但通知是關著的＝他刻意關的：加進名單、⛔ 不替他打開', async () => {
    store.doc = { handoffNotify: { enabled: false, lineUserIds: ['U9'] } }
    expect(await addToHandoffNotify('w', 'U1', '')).toBe('added')
    expect(store.writes[0].p['handoffNotify.enabled']).toBeUndefined()
  })

  it('已經在名單上（含舊資料的 `workspace_U…` 形式）→ 不重複加', async () => {
    store.doc = { handoffNotify: { enabled: true, lineUserIds: ['w_U1'] } }
    expect(await addToHandoffNotify('w', 'U1', '')).toBe('already')
    expect(store.writes).toHaveLength(0)
  })

  it(`⛔ 滿了（${HANDOFF_NOTIFY_MAX} 位）→ 回 full、不擠掉別人`, async () => {
    store.doc = { handoffNotify: { enabled: true, lineUserIds: Array.from({ length: HANDOFF_NOTIFY_MAX }, (_, i) => `U${i + 10}`) } }
    expect(await addToHandoffNotify('w', 'U1', '')).toBe('full')
    expect(store.writes).toHaveLength(0)
  })

  it('還沒有 AI 設定文件：只寫名單這一格（⛔ 不寫一整份設定覆蓋預設值）', async () => {
    store.doc = null
    expect(await addToHandoffNotify('w', 'U1', '王')).toBe('added')
    expect(store.writes[0]).toMatchObject({ kind: 'set', p: { handoffNotify: { enabled: true, lineUserIds: ['U1'] } } })
  })
})
