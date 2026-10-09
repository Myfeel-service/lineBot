import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 試發名單（`D-119` ⑥，2026-10-09 老闆「照改」）：試發只能發給名單上的人。
 * 釘三件事：①名單＝自己綁好的手機＋綁好的同事＋常找來看稿的人 ②封鎖了／不是好友了的照樣列、但不算「發得出去」
 * ③加人要是好友、有上限、不重複。
 */

const WS = 'w1'
const U_SELF = 'U00000000000000000000000000000001'
const U_ARTHUR = 'U00000000000000000000000000000002'
const U_RUIRU = 'U00000000000000000000000000000003'
const U_BLOCKED = 'U00000000000000000000000000000004'
const U_GONE = 'U00000000000000000000000000000005'

const store = vi.hoisted(() => ({
  members: [] as Record<string, unknown>[],
  saved: null as Record<string, unknown> | null,
  users: {} as Record<string, Record<string, unknown>>,
  savedWrites: [] as Record<string, unknown>[],
}))

vi.mock('./firebase', () => ({
  getFirebaseAuth: () => ({ getUsers: async () => ({ users: [{ uid: 'uOwner', email: 'kevin@x.tw' }] }) }),
  getDb: () => {
    const savedRef = {
      get: async () => ({ exists: Boolean(store.saved), data: () => store.saved }),
    }
    return {
      collection: (name: string) => ({
        where: () => ({ get: async () => ({ docs: store.members.map(m => ({ data: () => m })) }) }),
        doc: (id: string) => (name === 'users'
          ? { get: async () => ({ exists: Boolean(store.users[id]), data: () => store.users[id] }) }
          : savedRef),
      }),
      runTransaction: async (fn: (tx: unknown) => unknown) => fn({
        get: async () => ({ exists: Boolean(store.saved), data: () => store.saved }),
        set: (_ref: unknown, v: Record<string, unknown>) => { store.saved = { ...(store.saved ?? {}), ...v }; store.savedWrites.push(v) },
        update: (_ref: unknown, v: Record<string, unknown>) => { store.saved = { ...(store.saved ?? {}), ...v }; store.savedWrites.push(v) },
      }),
    }
  },
}))

const { buildTestRecipients, allowedTestRecipientIds, addTestRecipient, removeTestRecipient, TEST_RECIPIENTS_MAX } = await import('./broadcast-test-recipients')

const friend = (id: string, data: Record<string, unknown>) => { store.users[`${WS}_${id}`] = { workspaceId: WS, lineUserId: id, ...data } }

beforeEach(() => {
  store.members = [
    { uid: 'uOwner', role: 'owner', invitedEmail: '', lineUserId: U_SELF, lineDisplayName: '江' },
    { uid: 'uArthur', role: 'admin', invitedEmail: 'arthur@x.tw', lineUserId: U_ARTHUR, lineDisplayName: 'Arthur' },
    { uid: 'uJordan', role: 'admin', invitedEmail: 'jordan@x.tw' }, // 沒綁：不在名單
  ]
  store.saved = { lineUserIds: [U_RUIRU, U_BLOCKED, U_GONE, U_ARTHUR], names: { [U_GONE]: '依萱' } }
  store.users = {}
  store.savedWrites = []
  friend(U_RUIRU, { displayName: '游瑞茹' })
  friend(U_BLOCKED, { displayName: 'Alice', isBlocked: true })
  friend(U_ARTHUR, { displayName: 'Arthur' })
})

describe('試發名單長什麼樣', () => {
  it('自己綁好的手機、綁好的同事（不含沒綁的）、常找來看稿的人（已是同事的不重複）', async () => {
    const list = await buildTestRecipients(WS, 'uOwner')
    expect(list.selfIsMember).toBe(true)
    expect(list.self).toMatchObject({ lineUserId: U_SELF, displayName: '江', email: 'kevin@x.tw' })
    expect(list.members.map(m => m.lineUserId)).toEqual([U_ARTHUR])
    expect(list.saved.map(s => s.lineUserId)).toEqual([U_RUIRU, U_BLOCKED, U_GONE])
  })

  it('封鎖了／不是好友了：照樣列出來（⛔ 不安靜地消失），但標出收不到；不是好友了用存的名字', async () => {
    const list = await buildTestRecipients(WS, 'uOwner')
    expect(list.saved.find(s => s.lineUserId === U_BLOCKED)?.unreachable).toBe('blocked')
    expect(list.saved.find(s => s.lineUserId === U_GONE)).toMatchObject({ unreachable: 'gone', displayName: '依萱' })
  })

  it('⛔ 發得出去的只有收得到的人；還沒綁手機的自己不在裡面', async () => {
    expect([...await allowedTestRecipientIds(WS, 'uOwner')].sort()).toEqual([U_SELF, U_ARTHUR, U_RUIRU].sort())
    const jordan = await allowedTestRecipientIds(WS, 'uJordan')
    expect(jordan.has(U_SELF)).toBe(true) // 擁有者對 Jordan 來說是「同事」
    expect((await buildTestRecipients(WS, 'uJordan')).self).toBeNull()
  })

  it('平台管理員（不是成員）：沒有自己那一格，同事與看稿的人照列', async () => {
    const list = await buildTestRecipients(WS, 'uService')
    expect(list.selfIsMember).toBe(false)
    expect(list.self).toBeNull()
    expect(list.members).toHaveLength(2)
  })
})

describe('加人／拿掉', () => {
  it('⛔ 不是好友 → 不加', async () => {
    expect((await addTestRecipient(WS, 'U99999999999999999999999999999999')).result).toBe('not-friend')
    expect(store.savedWrites).toHaveLength(0)
  })

  it('已經在 → already；滿了 → full（⛔ 不擠掉別人）', async () => {
    expect((await addTestRecipient(WS, U_RUIRU)).result).toBe('already')
    const many = Array.from({ length: TEST_RECIPIENTS_MAX }, (_, i) => `U${String(i).padStart(32, 'a')}`)
    store.saved = { lineUserIds: many }
    friend('U77777777777777777777777777777777', { displayName: '新來的' })
    expect((await addTestRecipient(WS, 'U77777777777777777777777777777777')).result).toBe('full')
  })

  it('加進來記下名字；拿掉時名字一起清（整份換掉，merge 不會刪鍵）', async () => {
    store.saved = null
    friend('U88888888888888888888888888888888', { displayName: '陳品潔' })
    expect(await addTestRecipient(WS, 'U88888888888888888888888888888888')).toEqual({ result: 'added', displayName: '陳品潔' })
    expect(store.saved).toMatchObject({ lineUserIds: ['U88888888888888888888888888888888'], names: { U88888888888888888888888888888888: '陳品潔' } })
    expect(await removeTestRecipient(WS, 'U88888888888888888888888888888888')).toBe(true)
    expect(store.saved).toMatchObject({ lineUserIds: [], names: {} })
  })
})
