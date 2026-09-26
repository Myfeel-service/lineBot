/**
 * LINE 通知送到了沒（`C-270`⑥）：封鎖的人天天「被發」卻一則都沒收到，原本完全沒有人知道。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({ FieldValue: { delete: () => '__del__' } }))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('./line', () => ({ pushMessage: vi.fn() }))

import {
  bareLineUserId,
  classifyNotifyPushFailure,
  markNotifyRecipientBlocked,
  recipientDeliveryState,
  recordNotifyDelivery,
} from './line-notify-delivery'

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

describe('classifyNotifyPushFailure', () => {
  it('LINE 說封鎖／不是好友 → blocked（兩種 LINE 回同一句）', () => {
    expect(classifyNotifyPushFailure({ status: 400, body: '{"message":"The user hasn\'t added the LINE Official Account as a friend"}' }).kind).toBe('blocked')
    expect(classifyNotifyPushFailure({ status: 403, body: 'blocked' }).kind).toBe('blocked')
  })
  it('當月額度用完 → quota；憑證壞掉 → 講去哪修', () => {
    expect(classifyNotifyPushFailure({ status: 429, body: 'You have reached your monthly limit.' }).kind).toBe('quota')
    expect(classifyNotifyPushFailure({ status: 401, body: 'Authentication failed' }).reason).toContain('組織與 LINE')
  })
  it('連不上（不是 LINE 的錯）→ other，⛔ 不當成封鎖', () => {
    expect(classifyNotifyPushFailure(new Error('ECONNRESET'))).toEqual({ kind: 'other', reason: '連不上 LINE' })
  })
})

describe('recipientDeliveryState', () => {
  it('封鎖優先：成功時間比較新也算收不到（LINE 對封鎖的人推播不一定回錯）', () => {
    expect(recipientDeliveryState({ okAt: 10, blockedAt: 5 }).state).toBe('blocked')
  })
  it('最後一次是失敗才算收不到；舊的失敗被新的成功蓋過', () => {
    expect(recipientDeliveryState({ okAt: 5, failAt: 10, failReason: 'x' })).toEqual({ state: 'failing', at: 10, reason: 'x' })
    expect(recipientDeliveryState({ okAt: 10, failAt: 5 }).state).toBe('ok')
  })
  it('從來沒傳過 → never（⛔ 不當成收不到，剛加進來的人不該一進來就變黃）', () => {
    expect(recipientDeliveryState(undefined).state).toBe('never')
    expect(recipientDeliveryState({}).state).toBe('never')
  })
})

describe('recordNotifyDelivery（⛔ 它會吞自己的錯，所以這裡斷言「真的寫了」）', () => {
  it('一次寫一份：成功的記 okAt、封鎖的連 blockedAt 一起記；舊資料的 `W_U…` 收斂成純 id', async () => {
    const { db, writes } = fakeDb()
    await recordNotifyDelivery('W', [
      { lineUserId: 'W_U1', ok: true },
      { lineUserId: 'U2', ok: false, error: { status: 400, body: 'blocked' } },
      { lineUserId: 'U3', ok: true, kind: 'confirm' },
    ], db)
    expect(writes).toHaveLength(1)
    expect(writes[0]!.col).toBe('lineNotifyDelivery')
    expect(writes[0]!.id).toBe('W')
    expect(writes[0]!.opts).toEqual({ merge: true })
    const r = writes[0]!.patch.recipients
    expect(Object.keys(r).sort()).toEqual(['U1', 'U2', 'U3'])
    expect(r.U1.okKind).toBe('notify')
    expect(r.U2).toMatchObject({ failKind: 'blocked' })
    expect(typeof r.U2.blockedAt).toBe('number')
    expect(r.U3.okKind).toBe('confirm')
  })

  it('寫不進去只寫 log，⛔ 不讓通知本身失敗', async () => {
    const db = { collection: () => ({ doc: () => ({ set: async () => { throw new Error('boom') } }) }) } as any
    await expect(recordNotifyDelivery('W', [{ lineUserId: 'U1', ok: true }], db)).resolves.toBeUndefined()
  })
})

describe('markNotifyRecipientBlocked', () => {
  it('封鎖記時間；重新加好友把那一格刪掉', async () => {
    const { db, writes } = fakeDb()
    await markNotifyRecipientBlocked('W', 'U1', true, db)
    await markNotifyRecipientBlocked('W', 'U1', false, db)
    expect(typeof writes[0]!.patch.recipients.U1.blockedAt).toBe('number')
    expect(writes[1]!.patch.recipients.U1.blockedAt).toBe('__del__')
  })
  it('bareLineUserId', () => {
    expect(bareLineUserId('W', 'W_U1')).toBe('U1')
    expect(bareLineUserId('W', 'U1')).toBe('U1')
  })
})
