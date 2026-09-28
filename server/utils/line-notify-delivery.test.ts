/**
 * LINE 通知送到了沒（`C-270`⑥、`C-271`②④⑦⑧）：封鎖的人天天「被發」卻一則都沒收到，原本完全沒有人知道；
 * 反過來也不可以把 LINE 一時出錯當成「收不到」，或加了好友還永遠黃著。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getDb, settings } = vi.hoisted(() => ({
  getDb: vi.fn(),
  settings: { ids: [] as string[] },
}))
vi.mock('firebase-admin/firestore', () => ({ FieldValue: { delete: () => '__del__' } }))
vi.mock('./firebase', () => ({ getDb }))
vi.mock('./line', () => ({ pushMessage: vi.fn() }))
vi.mock('./ai-settings', () => ({
  getAiSettings: vi.fn(async () => ({ handoffNotify: { lineUserIds: settings.ids } })),
}))

import {
  classifyNotifyPushFailure,
  isUndeliverable,
  markNotifyRecipientBlocked,
  recipientDeliveryState,
  recordNotifyDelivery,
  syncNotifyRecipientFollowState,
} from './line-notify-delivery'

/** 真的長得像 LINE 帳號的 id（U＋32 位十六進位）：舊資料 `W_U…` 的收斂只認這種 */
const U1 = `U${'1'.repeat(32)}`
const U2 = `U${'2'.repeat(32)}`
const U3 = `U${'3'.repeat(32)}`

function fakeDb() {
  const writes: { col: string, id: string, patch: any, opts: any }[] = []
  const db = {
    collection: (col: string) => ({
      doc: (id: string) => ({
        set: async (patch: any, opts: any) => { writes.push({ col, id, patch, opts }) },
      }),
    }),
  } as any
  return { db, writes }
}

beforeEach(() => {
  getDb.mockReset()
  settings.ids = []
})

describe('classifyNotifyPushFailure（種類判斷走 line-send-error.ts 那一份）', () => {
  it('LINE 說封鎖／不是好友 → blocked（兩種 LINE 回同一句）', () => {
    expect(classifyNotifyPushFailure({ status: 400, body: '{"message":"The user hasn\'t added the LINE Official Account as a friend"}' }).kind).toBe('blocked')
    expect(classifyNotifyPushFailure({ status: 403, body: 'blocked' }).kind).toBe('blocked')
  })
  it('當月額度用完 → quota；憑證壞掉 → auth（講去哪修）；內容被拒 → invalid', () => {
    expect(classifyNotifyPushFailure({ status: 429, body: 'You have reached your monthly limit.' }).kind).toBe('quota')
    expect(classifyNotifyPushFailure({ status: 401, body: 'Authentication failed' })).toMatchObject({ kind: 'auth' })
    expect(classifyNotifyPushFailure({ status: 401, body: 'x' }).reason).toContain('組織與 LINE')
    expect(classifyNotifyPushFailure({ status: 400, body: 'The property, \'to\', in the request body is invalid' }).kind).toBe('invalid')
  })
  it('🔴 一時的（LINE 5xx、送太快、斷線）→ transient，⛔ 不當成封鎖也不當成一直失敗（`C-271`⑦）', () => {
    expect(classifyNotifyPushFailure({ status: 503, body: 'Service Unavailable' }).kind).toBe('transient')
    expect(classifyNotifyPushFailure({ status: 429, body: 'Too many requests' }).kind).toBe('transient')
    expect(classifyNotifyPushFailure(new Error('ECONNRESET'))).toEqual({ kind: 'transient', reason: '連不上 LINE' })
  })
})

describe('recipientDeliveryState', () => {
  it('封鎖優先：成功時間比較新也算收不到（LINE 對封鎖的人推播不一定回錯）', () => {
    expect(recipientDeliveryState({ okAt: 10, blockedAt: 5 })).toMatchObject({ state: 'blocked', via: 'unfollow' })
    expect(recipientDeliveryState({ blockedAt: 5, blockedVia: 'push' })).toMatchObject({ state: 'blocked', via: 'push' })
  })
  it('最後一次是「一直會失敗」才算收不到；舊的失敗被新的成功蓋過', () => {
    expect(recipientDeliveryState({ okAt: 5, failAt: 10, failReason: 'x' })).toEqual({ state: 'failing', at: 10, reason: 'x' })
    expect(recipientDeliveryState({ okAt: 10, failAt: 5 }).state).toBe('ok')
  })
  it('🔴 一時的失敗 → glitch，⛔ 不算收不到（兩顆提醒都不亮）', () => {
    const s = recipientDeliveryState({ okAt: 5, glitchAt: 10, glitchReason: 'LINE 那邊暫時有問題' })
    expect(s.state).toBe('glitch')
    expect(isUndeliverable(s)).toBe(false)
    expect(isUndeliverable(recipientDeliveryState({ okAt: 5, failAt: 10 }))).toBe(true)
  })
  it('從來沒傳過 → never（⛔ 不當成收不到，剛加進來的人不該一進來就變黃）', () => {
    expect(recipientDeliveryState(undefined).state).toBe('never')
    expect(recipientDeliveryState({}).state).toBe('never')
  })
})

describe('recordNotifyDelivery（⛔ 它會吞自己的錯，所以這裡斷言「真的寫了」）', () => {
  it('一次寫一份：成功記 okAt、封鎖記 failAt＋blockedAt、一時的只記 glitchAt；舊資料的 `W_U…` 收斂成純 id', async () => {
    const { db, writes } = fakeDb()
    await recordNotifyDelivery('W', [
      { lineUserId: `W_${U1}`, ok: true },
      { lineUserId: U2, ok: false, error: { status: 400, body: 'blocked' } },
      { lineUserId: U3, ok: false, error: { status: 500, body: 'oops' } },
    ], db)
    expect(writes).toHaveLength(1)
    expect(writes[0]!.col).toBe('lineNotifyDelivery')
    expect(writes[0]!.id).toBe('W')
    expect(writes[0]!.opts).toEqual({ merge: true })
    const r = writes[0]!.patch.recipients
    expect(Object.keys(r).sort()).toEqual([U1, U2, U3])
    expect(r[U1].okKind).toBe('notify')
    expect(r[U2]).toMatchObject({ failKind: 'blocked', blockedVia: 'push' })
    expect(typeof r[U2].blockedAt).toBe('number')
    expect(typeof r[U3].glitchAt).toBe('number')
    expect(r[U3].failAt).toBeUndefined()
  })

  it('寫不進去只寫 log，⛔ 不讓通知本身失敗', async () => {
    const db = { collection: () => ({ doc: () => ({ set: async () => { throw new Error('boom') } }) }) } as any
    await expect(recordNotifyDelivery('W', [{ lineUserId: U1, ok: true }], db)).resolves.toBeUndefined()
  })

  it('🔴 連 getDb() 都丟例外也不 reject（`C-271`⑧：原本是預設參數、在 try 外面求值 → 已送出的摘要被當失敗重發）', async () => {
    getDb.mockImplementation(() => { throw new Error('no db') })
    await expect(recordNotifyDelivery('W', [{ lineUserId: U1, ok: true }])).resolves.toBeUndefined()
  })
})

describe('封鎖／加好友', () => {
  it('封鎖記時間；🔴 加好友時連退件紀錄一起清（`C-271`④：只清封鎖的話，封鎖期間被退回的那筆還比成功新）', async () => {
    const { db, writes } = fakeDb()
    await markNotifyRecipientBlocked('W', U1, true, db)
    await markNotifyRecipientBlocked('W', U1, false, db)
    expect(writes[0]!.patch.recipients[U1]).toMatchObject({ blockedVia: 'unfollow' })
    expect(typeof writes[0]!.patch.recipients[U1].blockedAt).toBe('number')
    expect(writes[1]!.patch.recipients[U1]).toEqual({
      blockedAt: '__del__', blockedVia: '__del__', failAt: '__del__', failKind: '__del__', failReason: '__del__',
    })
  })

  it('🔴 名單上的人加好友 → 清（`C-271`②：還沒加好友就綁定、被退回記成封鎖的人，加好友後要轉回來）', async () => {
    const { db, writes } = fakeDb()
    getDb.mockReturnValue(db)
    settings.ids = [U1]
    await syncNotifyRecipientFollowState('W', U1, false)
    expect(writes).toHaveLength(1)
    expect(writes[0]!.patch.recipients[U1].blockedAt).toBe('__del__')
  })

  it('不在名單上的客人（絕大多數）→ 什麼都不寫', async () => {
    const { db, writes } = fakeDb()
    getDb.mockReturnValue(db)
    settings.ids = [U2]
    await syncNotifyRecipientFollowState('W', U1, true)
    expect(writes).toHaveLength(0)
  })
})
