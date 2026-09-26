/**
 * 加進通知名單（`C-250`③：開帳按了「是我」的那支手機）。
 *
 * ⭐ 為什麼要有：綁定手機原本不會加進名單——「客人要找你本人、早上的摘要會傳到這支手機」
 *    就只是一句沒人兌現的話。這裡守：加得進去、不擠掉別人、不替他打開他刻意關掉的通知，
 *    🔴 而且**關著的時候要說關著**（2026-09-26 code review：原本照樣回 added，精靈就承諾會收到）；
 *    寫入走交易（同時按不會掉人）；換手機綁定時舊那支從名單拿掉。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { store } = vi.hoisted(() => ({
  store: {
    doc: null as any,
    writes: [] as any[],
    txUsed: false,
    members: {} as Record<string, any>,
  },
}))
vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => ({}), delete: () => '__del__' } }))
vi.mock('./firebase', () => {
  const aiRef = {
    get: async () => ({ exists: store.doc != null, data: () => store.doc }),
    update: async (p: any) => { store.writes.push({ kind: 'update', p }) },
    set: async (p: any) => { store.writes.push({ kind: 'set', p }) },
  }
  const memberRef = (id: string) => ({
    id,
    get: async () => ({ exists: store.members[id] != null, data: () => store.members[id] }),
  })
  return {
    getDb: () => ({
      collection: (col: string) => col === 'workspaceMembers'
        ? {
            doc: (id: string) => memberRef(id),
            where: () => ({ where: () => ({ get: async () => ({ docs: [] }) }) }),
          }
        : { doc: () => aiRef },
      runTransaction: async (fn: (tx: any) => unknown) => {
        store.txUsed = true
        return fn({
          get: (r: any) => r.get(),
          update: (r: any, p: any) => r.update(p),
          set: (r: any, p: any) => r.set(p),
        })
      },
      batch: () => ({ update: () => {}, commit: async () => {} }),
    }),
  }
})
vi.mock('./ai-settings', () => ({ AI_SETTINGS_COLLECTION: 'aiSettings', invalidateAiSettingsCache: vi.fn() }))
vi.mock('./line', () => ({ getUserProfile: vi.fn(), replyMessage: vi.fn() }))
vi.mock('./line-oa-basic-id', () => ({ resolveLineOaBasicId: vi.fn() }))

import { addToHandoffNotify, bindMemberLineUser, HANDOFF_NOTIFY_MAX } from './member-line-bind'

beforeEach(() => {
  store.doc = null
  store.writes = []
  store.txUsed = false
  store.members = {}
})

describe('addToHandoffNotify', () => {
  it('新帳號（名單空的）：加進去、順手把通知打開（走交易）', async () => {
    store.doc = { handoffNotify: { enabled: false, lineUserIds: [] } }
    expect(await addToHandoffNotify('w', 'U1', '王小明')).toBe('added')
    const p = store.writes[0].p
    expect(p['handoffNotify.lineUserIds']).toEqual(['U1'])
    expect(p['handoffNotify.enabled']).toBe(true)
    expect(p['handoffNotify.displayNames']).toEqual({ U1: '王小明' })
    expect(store.txUsed).toBe(true)
  })

  it('名單有人、通知開著：加進去＝added', async () => {
    store.doc = { handoffNotify: { enabled: true, lineUserIds: ['U9'] } }
    expect(await addToHandoffNotify('w', 'U1', '')).toBe('added')
  })

  it('🔴 名單有人但通知是關著的＝他刻意關的：加進名單、⛔ 不替他打開，而且回 off（⛔ 不可以回 added）', async () => {
    store.doc = { handoffNotify: { enabled: false, lineUserIds: ['U9'] } }
    expect(await addToHandoffNotify('w', 'U1', '')).toBe('off')
    expect(store.writes[0].p['handoffNotify.lineUserIds']).toEqual(['U9', 'U1'])
    expect(store.writes[0].p['handoffNotify.enabled']).toBeUndefined()
  })

  it('已經在名單上（含舊資料的 `workspace_U…` 形式）→ 不重複加；通知關著就回 off', async () => {
    store.doc = { handoffNotify: { enabled: true, lineUserIds: ['w_U1'] } }
    expect(await addToHandoffNotify('w', 'U1', '')).toBe('already')
    store.doc = { handoffNotify: { enabled: false, lineUserIds: ['U1'] } }
    expect(await addToHandoffNotify('w', 'U1', '')).toBe('off')
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

describe('bindMemberLineUser：換一支手機綁定', () => {
  it('舊那支從通知名單拿掉（⛔ 不然它繼續收通知、卻已經不屬於任何成員）', async () => {
    store.members['u1_w'] = { lineUserId: 'Uold' }
    store.doc = { handoffNotify: { enabled: true, lineUserIds: ['Uold', 'Uother'], displayNames: { Uold: '舊手機' } } }
    // memberDocId 的格式由實作決定：兩種都放，找得到哪個算哪個
    store.members['w_u1'] = store.members['u1_w']
    expect(await bindMemberLineUser('w', 'u1', { lineUserId: 'Unew', displayName: '新手機', pictureUrl: '' })).toBe(true)
    const removed = store.writes.find(w => w.kind === 'update' && w.p['handoffNotify.lineUserIds'])
    expect(removed?.p['handoffNotify.lineUserIds']).toEqual(['Uother'])
    expect(removed?.p['handoffNotify.displayNames']).toEqual({})
  })

  it('綁回同一支：名單不動', async () => {
    store.members['u1_w'] = { lineUserId: 'Usame' }
    store.members['w_u1'] = store.members['u1_w']
    store.doc = { handoffNotify: { enabled: true, lineUserIds: ['Usame'] } }
    await bindMemberLineUser('w', 'u1', { lineUserId: 'Usame', displayName: '', pictureUrl: '' })
    expect(store.writes).toHaveLength(0)
  })
})
