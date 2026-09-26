/**
 * 「手機加好友、電腦按『是我』」（`C-250`③）。
 *
 * 🔴 這幾條守的是安全閘：按「是我」會把那支 LINE 綁成管理員、加進內部通知名單——
 *    綁錯人＝客人收到我們的內部通知。所以只認**這段時間內新進來的**、而且伺服器自己再驗一次。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => ({ __op: 'ts' }) } }))
vi.mock('./firebase', () => ({ getDb: () => { throw new Error('test 必須自帶 db') } }))
const { findLatestPeerActiveConversation } = vi.hoisted(() => ({ findLatestPeerActiveConversation: vi.fn(async () => null as any) }))
vi.mock('./conversation-peer-activity', () => ({ findLatestPeerActiveConversation }))

import { clampSince, confirmPhoneFollower, findNewFollower, PHONE_TEST_WINDOW_MS, phoneTestSince, sinceFromLookback } from './onboarding-phone-test'

const ts = (ms: number) => ({ toMillis: () => ms })
const NOW = 1_800_000_000_000

function makeDb(users: Record<string, any>, convs: Record<string, any> = {}) {
  const writes: Array<{ col: string, id: string, p: any }> = []
  const col = (name: string) => {
    const store = name === 'users' ? users : convs
    const q: any = {
      where: () => q,
      orderBy: () => q,
      limit: () => q,
      get: async () => ({
        docs: Object.entries(store)
          .sort((a, b) => (b[1].createdAt?.toMillis?.() ?? 0) - (a[1].createdAt?.toMillis?.() ?? 0))
          .map(([id, data]) => ({ id, data: () => data })),
      }),
      doc: (id: string) => ({
        get: async () => ({ exists: store[id] != null, data: () => store[id] }),
        set: async (p: any) => { writes.push({ col: name, id, p }); store[id] = { ...(store[id] ?? {}), ...p } },
      }),
    }
    return q
  }
  return { db: { collection: col } as any, writes }
}

describe('時間窗', () => {
  it('⛔ 最多往回一小時、不能是未來；給亂的值就只看最近 5 分鐘', () => {
    expect(clampSince(NOW - 2 * PHONE_TEST_WINDOW_MS, NOW)).toBe(NOW - PHONE_TEST_WINDOW_MS)
    expect(clampSince(NOW + 60_000, NOW)).toBe(NOW)
    expect(clampSince('abc', NOW)).toBe(NOW - 5 * 60_000)
    expect(clampSince(NOW - 90_000, NOW)).toBe(NOW - 90_000)
  })

  it('🔴 用「往回看多久」算起點：電腦時鐘快了也不影響（code review：原本電腦快 5 分鐘就永遠等不到）', () => {
    // 前端送的是「等了 3 分鐘＋前面 2 分鐘」這段長度，起點由伺服器自己的時間往回推
    expect(sinceFromLookback(5 * 60_000, NOW)).toBe(NOW - 5 * 60_000)
    expect(sinceFromLookback(3 * PHONE_TEST_WINDOW_MS, NOW)).toBe(NOW - PHONE_TEST_WINDOW_MS)
    expect(sinceFromLookback('abc', NOW)).toBe(NOW - 5 * 60_000)
    // 新的參數優先；舊分頁送的 since 照舊收
    expect(phoneTestSince({ lookbackMs: '60000', since: NOW + 999_999 }, NOW)).toBe(NOW - 60_000)
    expect(phoneTestSince({ since: NOW - 90_000 }, NOW)).toBe(NOW - 90_000)
  })
})

describe('封鎖後重加好友也算（code review：重加時 createdAt 不會變）', () => {
  it('lastFollowedAt 在時間窗內＝算這一下加好友', async () => {
    const { db } = makeDb({
      'w_Uboss': { workspaceId: 'w', lineUserId: 'Uboss', displayName: '老闆本人', createdAt: ts(NOW - 99_999_999), lastFollowedAt: ts(NOW - 3000) },
    })
    expect(await findNewFollower('w', NOW - 60_000, new Set(), db)).toMatchObject({ lineUserId: 'Uboss', via: 'follow', at: NOW - 3000 })
  })

  it('按「是我」時伺服器再驗也認 lastFollowedAt', async () => {
    const { db } = makeDb({
      'w_Uboss': { workspaceId: 'w', lineUserId: 'Uboss', createdAt: ts(Date.now() - 99_999_999), lastFollowedAt: ts(Date.now() - 1000) },
    })
    expect(await confirmPhoneFollower('w', 'Uboss', Date.now() - 60_000, db)).toMatchObject({ via: 'follow' })
  })

  it('⚠️ 新索引還沒部署（查詢丟錯）：第一次加好友那條照常，而且講得出什麼看不到了', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = makeDb({ 'w_Unew': { workspaceId: 'w', lineUserId: 'Unew', createdAt: ts(NOW - 5000) } })
    const orig = db.collection
    db.collection = (name: string) => {
      const c = orig(name)
      if (name !== 'users') return c
      return { ...c, where: () => ({ orderBy: (f: string) => f === 'lastFollowedAt'
        ? { limit: () => ({ get: async () => { throw new Error('FAILED_PRECONDITION: The query requires an index') } }) }
        : c.orderBy(f) }) }
    }
    expect(await findNewFollower('w', NOW - 60_000, new Set(), db)).toMatchObject({ lineUserId: 'Unew' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('封鎖後重加的人這一次偵測不到'), expect.any(String))
    warn.mockRestore()
  })
})

describe('找這段時間新進來的那一位', () => {
  it('新加好友的最新那一位；⛔ 時間窗之前加的不算、封鎖的不算、按過「不是我」的不算', async () => {
    const { db } = makeDb({
      'w_Uold': { workspaceId: 'w', lineUserId: 'Uold', displayName: '老客人', createdAt: ts(NOW - 3_600_000) },
      'w_Ublk': { workspaceId: 'w', lineUserId: 'Ublk', displayName: '封鎖了', createdAt: ts(NOW - 1000), isBlocked: true },
      'w_Unew': { workspaceId: 'w', lineUserId: 'Unew', displayName: '王小明', pictureUrl: 'p.png', createdAt: ts(NOW - 5000) },
    })
    const hit = await findNewFollower('w', NOW - 60_000, new Set(), db)
    expect(hit).toMatchObject({ lineUserId: 'Unew', displayName: '王小明', via: 'follow' })
    expect(await findNewFollower('w', NOW - 60_000, new Set(['Unew']), db)).toBeNull()
  })

  it('早就是好友（加不了第二次）→ 剛傳訊息的那一位也算', async () => {
    const { db } = makeDb({ 'w_Uold': { workspaceId: 'w', lineUserId: 'Uold', displayName: '老闆本人', createdAt: ts(NOW - 99_999_999) } })
    findLatestPeerActiveConversation.mockResolvedValueOnce({ data: () => ({ userId: 'Uold', lastPeerActivityAt: ts(NOW - 2000) }) })
    const hit = await findNewFollower('w', NOW - 60_000, new Set(), db)
    expect(hit).toMatchObject({ lineUserId: 'Uold', displayName: '老闆本人', via: 'message' })
  })
})

describe('按了「是我」：伺服器自己再驗一次', () => {
  it('⛔ 不是這段時間新進來的 → 驗不過（不信任前端給的 id）', async () => {
    const { db, writes } = makeDb({ 'w_Uold': { workspaceId: 'w', lineUserId: 'Uold', createdAt: ts(NOW - 99_999_999) } })
    expect(await confirmPhoneFollower('w', 'Uold', NOW - 60_000, db)).toBeNull()
    expect(writes).toHaveLength(0)
  })

  it('⛔ 別家的使用者驗不過', async () => {
    const { db } = makeDb({ 'w_Ux': { workspaceId: 'other', lineUserId: 'Ux', createdAt: ts(NOW - 1000) } })
    expect(await confirmPhoneFollower('w', 'Ux', NOW - 60_000, db)).toBeNull()
  })

  it('新加好友的驗得過，而且這一下記成「收到了」（setup-status 看 lastPeerActivityAt）', async () => {
    const { db, writes } = makeDb({ 'w_Unew': { workspaceId: 'w', lineUserId: 'Unew', displayName: '王小明', createdAt: ts(Date.now() - 1000) } })
    const r = await confirmPhoneFollower('w', 'Unew', Date.now() - 60_000, db)
    expect(r).toMatchObject({ lineUserId: 'Unew', via: 'follow' })
    expect(writes.find(w => w.col === 'conversations')?.p.lastPeerActivityAt).toEqual({ __op: 'ts' })
  })
})
