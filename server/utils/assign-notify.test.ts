import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 指派通知（`H-16`）：把客人指派給別的同事時，那位同事的 LINE 收到「○○ 把客人「王小明」交給你」。
 * 推播與送達紀錄走真的 `pushToNotifyList`／`recordNotifyDelivery`（只假掉 LINE 與資料庫）——
 * 要釘的是「走既有那一套」：送不到的那一位，「LINE 通知」頁那一列會變黃。
 */

const runtime = vi.hoisted(() => ({ appBaseUrl: 'https://x.test', notifyLinksEnabled: 'true' as unknown }))
vi.stubGlobal('useRuntimeConfig', () => runtime)

vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('./line', () => ({ pushMessage: vi.fn(async () => {}) }))
vi.mock('./ai-settings', () => ({ getAiSettings: vi.fn() }))

import { _resetAssignNotifyThrottle, notifyAssignee } from './assign-notify'
import { getDb } from './firebase'
import { pushMessage } from './line'
import { getAiSettings } from './ai-settings'

const WS = 'ws-assign'
const CUSTOMER = 'U00000000000000000000000000c0ffee'
const STAFF_LINE = 'U0000000000000000000000000057aff1'

function makeDb(users: Record<string, Record<string, unknown>> = { [`${WS}_${CUSTOMER}`]: { displayName: '王小明' } }) {
  const writes: { col: string, id: string, data: any }[] = []
  const db = {
    collection: (col: string) => ({
      doc: (id: string) => ({
        get: async () => ({ exists: col === 'users' && !!users[id], data: () => (col === 'users' ? users[id] : undefined) }),
        set: async (data: any) => { writes.push({ col, id, data }) },
        create: async (data: any) => { writes.push({ col, id, data }) },
      }),
    }),
  }
  return { db, writes }
}

const base = {
  workspaceId: WS,
  assigneeUid: 'uid-amei',
  assigneeLineUserId: STAFF_LINE,
  assignerUid: 'uid-boss',
  assignerName: '小美',
  customerLineUserId: CUSTOMER,
}

function receiving(ids: string[] = [STAFF_LINE]) {
  vi.mocked(getAiSettings).mockResolvedValue({ handoffNotify: { lineUserIds: ids } } as any)
}

const sentTexts = () => vi.mocked(pushMessage).mock.calls.map(c => String((c[1] as any[])[0]?.text ?? ''))

beforeEach(() => {
  vi.clearAllMocks()
  _resetAssignNotifyThrottle()
  runtime.notifyLinksEnabled = 'true'
  const { db } = makeDb()
  vi.mocked(getDb).mockReturnValue(db as any)
  receiving()
})

describe('指派給別人 → 他的 LINE 收到一則', () => {
  it('寫清楚誰交給你、哪位客人，附打開那段對話的短網址', async () => {
    const { db, writes } = makeDb()

    await expect(notifyAssignee({ ...base, db: db as any })).resolves.toBe('sent')

    expect(vi.mocked(pushMessage)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(pushMessage).mock.calls[0]![0]).toBe(STAFF_LINE)
    const lines = sentTexts()[0]!.split('\n')
    expect(lines[0]).toBe('📌 小美 把客人「王小明」交給你')
    expect(lines[1]).toBe('👉 打開這段對話')
    expect(lines[2]).toMatch(/^https:\/\/x\.test\/c\/[A-Za-z0-9]{7}$/)
    // 短網址指到的是這位客人的對話
    const link = writes.find(w => w.col === 'notifyLinks')
    expect(link?.data.path).toBe(`/admin/${WS}/conversations?userId=${CUSTOMER}`)
    // 送達紀錄跟其他通知同一份（「LINE 通知」頁那一列看得到上次送到了）
    const delivery = writes.find(w => w.col === 'lineNotifyDelivery')
    expect(delivery?.data.recipients[STAFF_LINE].okAt).toBeGreaterThan(0)
  })

  it('連結開關關著（NOTIFY_LINKS_ENABLED=false）→ 不放網址，退回「請至後台…」', async () => {
    runtime.notifyLinksEnabled = 'false'

    await notifyAssignee(base)

    expect(sentTexts()[0]).toBe('📌 小美 把客人「王小明」交給你\n請至後台「對話」頁回覆。')
  })

  it('客人的名字拿不到 → 老實講「未知暱稱」，⛔ 不印 33 碼的原始編號', async () => {
    const { db } = makeDb({})
    vi.mocked(getDb).mockReturnValue(db as any)

    await notifyAssignee(base)

    expect(sentTexts()[0]).toContain(`客人「未知暱稱（…${CUSTOMER.slice(-6)}）」`)
  })
})

describe('不傳的情況（都不報錯）', () => {
  it('指給自己 → 不傳（按「我接手」自動指給自己的也是這一種）', async () => {
    await expect(notifyAssignee({ ...base, assignerUid: base.assigneeUid })).resolves.toBe('self')
    expect(vi.mocked(pushMessage)).not.toHaveBeenCalled()
  })

  it('那位同事沒綁 LINE → 不傳', async () => {
    await expect(notifyAssignee({ ...base, assigneeLineUserId: '' })).resolves.toBe('not-bound')
    expect(vi.mocked(pushMessage)).not.toHaveBeenCalled()
  })

  it('綁了但在「LINE 通知」頁把收通知關掉 → 不傳（那頁跟他說的是「這支手機不會再收到通知」）', async () => {
    receiving(['U00000000000000000000000000other1'])

    await expect(notifyAssignee(base)).resolves.toBe('not-receiving')
    expect(vi.mocked(pushMessage)).not.toHaveBeenCalled()
  })

  it('10 分鐘內同一位同事、同一位客人只傳一次（指派來回改不洗版）；換一位客人照傳', async () => {
    await expect(notifyAssignee(base)).resolves.toBe('sent')
    await expect(notifyAssignee(base)).resolves.toBe('throttled')
    await expect(notifyAssignee({ ...base, customerLineUserId: 'U00000000000000000000000000c0ffe2' })).resolves.toBe('sent')
    expect(vi.mocked(pushMessage)).toHaveBeenCalledTimes(2)
  })
})

describe('送不到', () => {
  it('對方封鎖了官方帳號 → 記成送不到（那一列變黃），而且下一次還會再試（不吃節流）', async () => {
    const { db, writes } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)
    vi.mocked(pushMessage).mockRejectedValueOnce(Object.assign(new Error('blocked'), {
      status: 400, body: '{"message":"The user hasn\'t added the LINE Official Account as a friend."}',
    }))

    await expect(notifyAssignee(base)).resolves.toBe('failed')
    const delivery = writes.find(w => w.col === 'lineNotifyDelivery')
    expect(delivery?.data.recipients[STAFF_LINE].failKind).toBe('blocked')

    await expect(notifyAssignee(base)).resolves.toBe('sent')
  })

  it('讀設定失敗 → 回 failed 不丟出去（呼叫端的指派照樣成功）', async () => {
    vi.mocked(getAiSettings).mockRejectedValueOnce(new Error('firestore down'))
    await expect(notifyAssignee(base)).resolves.toBe('failed')
  })
})
