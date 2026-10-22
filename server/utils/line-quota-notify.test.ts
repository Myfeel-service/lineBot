/**
 * LINE 訊息用到八成傳一則、用完寄信（`D-146`③，`C-384`）。
 *
 * 這支會**真的傳 LINE、真的寄信給客戶**，釘住的都是「發錯就會被關掉或漏掉」的行為：
 *   ① 八成那則一個月一次、只在白天傳；用完了不傳 LINE（一定送不出去），改寄信
 *   ② 🔴 一個人都沒送到／信沒寄出去，不可以記「這個月講過了」——6 小時後再試
 *   ③ 🔴 問不到 LINE 不是用完了：不傳不寄
 *   ④ 每個帳號一小時只問 LINE 一次；換月重新來
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => '__ts__' } }))
const { readLineMessageQuota } = vi.hoisted(() => ({ readLineMessageQuota: vi.fn() }))
vi.mock('./line', () => ({ readLineMessageQuota }))
const { getAiSettings } = vi.hoisted(() => ({ getAiSettings: vi.fn() }))
vi.mock('./ai-settings', () => ({ getAiSettings }))
const { pushToNotifyList } = vi.hoisted(() => ({ pushToNotifyList: vi.fn() }))
vi.mock('./line-notify-delivery', () => ({ pushToNotifyList }))
const { sendEmail } = vi.hoisted(() => ({ sendEmail: vi.fn() }))
vi.mock('./email', () => ({ sendEmail }))
const { resolveBillingRecipient } = vi.hoisted(() => ({ resolveBillingRecipient: vi.fn() }))
vi.mock('./billing-emails', () => ({ brandName: () => 'MiniMe', resolveBillingRecipient }))

import { notifyLineQuotaLevels } from './line-quota-notify'

/** 台灣時間 */
const at = (s: string) => Date.parse(`${s}+08:00`)
const HOUR = 3600_000

let store: Map<string, Record<string, unknown>>
function merge(a: Record<string, unknown>, b: Record<string, unknown>) {
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object')
      merge(a[k] as Record<string, unknown>, v as Record<string, unknown>)
    else a[k] = v
  }
}
function fakeDb(workspaceIds: string[]) {
  return {
    collection: (name: string) => {
      if (name === 'workspaces') {
        const q: any = { select: () => q, limit: () => q, get: async () => ({ docs: workspaceIds.map(id => ({ id })) }) }
        return q
      }
      return {
        doc: (id: string) => {
          const key = `${name}/${id}`
          return {
            get: async () => ({ data: () => (store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : undefined) }),
            set: async (patch: Record<string, unknown>) => {
              const cur = store.get(key) ?? {}
              merge(cur, JSON.parse(JSON.stringify(patch)))
              store.set(key, cur)
            },
          }
        },
      }
    },
  } as any
}

const near = { kind: 'ok', quota: { limit: 3000, used: 2480, remaining: 520 } }
const over = { kind: 'ok', quota: { limit: 3000, used: 3000, remaining: 0 } }
const fine = { kind: 'ok', quota: { limit: 3000, used: 100, remaining: 2900 } }
/** 名單上兩位，都沒取消任何一種（＝都收「出大事」） */
const crit = { handoffNotify: { enabled: true, lineUserIds: ['Ua', 'Ub'], optOut: {} } }

beforeEach(() => {
  store = new Map()
  readLineMessageQuota.mockReset()
  getAiSettings.mockReset().mockResolvedValue(crit)
  pushToNotifyList.mockReset().mockResolvedValue([{ status: 'fulfilled', value: {} }])
  sendEmail.mockReset().mockResolvedValue({ ok: true })
  resolveBillingRecipient.mockReset().mockResolvedValue({ email: 'owner@example.com', workspaceName: 'MYFEEL 官方帳號' })
})

describe('用到八成：LINE 傳一則', () => {
  it('白天、有人勾「出大事」→ 傳一則給他們，講已送幾則與後果；不寄信', async () => {
    readLineMessageQuota.mockResolvedValue(near)
    const r = await notifyLineQuotaLevels(fakeDb(['ws1']), at('2026-10-22T10:00:00'))
    expect(r).toEqual({ checked: 1, warned: 1, emailed: 0 })
    const [wid, to, msgs] = pushToNotifyList.mock.calls[0]!
    expect(wid).toBe('ws1')
    expect(to).toEqual(['Ua', 'Ub'])
    expect(msgs[0].text).toContain('⚠️ LINE 訊息快用完了')
    expect(msgs[0].text).toContain('2,480／3,000')
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('同一個月只傳一次（兩小時後再查，照樣八成也不再傳）', async () => {
    readLineMessageQuota.mockResolvedValue(near)
    const db = fakeDb(['ws1'])
    await notifyLineQuotaLevels(db, at('2026-10-22T10:00:00'))
    await notifyLineQuotaLevels(db, at('2026-10-22T12:00:00'))
    expect(pushToNotifyList).toHaveBeenCalledTimes(1)
  })

  it('換月重新來：下個月又到八成會再傳', async () => {
    readLineMessageQuota.mockResolvedValue(near)
    const db = fakeDb(['ws1'])
    await notifyLineQuotaLevels(db, at('2026-10-22T10:00:00'))
    await notifyLineQuotaLevels(db, at('2026-11-20T10:00:00'))
    expect(pushToNotifyList).toHaveBeenCalledTimes(2)
  })

  it('半夜不傳，早上 9 點以後才傳', async () => {
    readLineMessageQuota.mockResolvedValue(near)
    const db = fakeDb(['ws1'])
    await notifyLineQuotaLevels(db, at('2026-10-22T23:00:00'))
    expect(pushToNotifyList).not.toHaveBeenCalled()
    await notifyLineQuotaLevels(db, at('2026-10-23T09:05:00'))
    expect(pushToNotifyList).toHaveBeenCalledTimes(1)
  })

  it('🔴 一個人都沒送到 → 不記「講過了」：6 小時內不重打、過了再試', async () => {
    readLineMessageQuota.mockResolvedValue(near)
    pushToNotifyList.mockResolvedValue([{ status: 'rejected', reason: new Error('blocked') }])
    const db = fakeDb(['ws1'])
    expect((await notifyLineQuotaLevels(db, at('2026-10-22T10:00:00'))).warned).toBe(0)
    await notifyLineQuotaLevels(db, at('2026-10-22T12:00:00'))
    expect(pushToNotifyList).toHaveBeenCalledTimes(1)
    pushToNotifyList.mockResolvedValue([{ status: 'fulfilled', value: {} }])
    expect((await notifyLineQuotaLevels(db, at('2026-10-22T16:30:00'))).warned).toBe(1)
    expect(pushToNotifyList).toHaveBeenCalledTimes(2)
  })

  it('沒有人勾「出大事」→ 不傳', async () => {
    readLineMessageQuota.mockResolvedValue(near)
    getAiSettings.mockResolvedValue({ handoffNotify: { enabled: true, lineUserIds: ['Ua'], optOut: { Ua: ['crit'] } } })
    await notifyLineQuotaLevels(fakeDb(['ws1']), at('2026-10-22T10:00:00'))
    expect(pushToNotifyList).not.toHaveBeenCalled()
  })
})

describe('用完了：寄信（LINE 那時已經傳不出去）', () => {
  it('寄給帳號負責人，講送不出去的三件事與 AI 不受影響；⛔ 不傳 LINE', async () => {
    readLineMessageQuota.mockResolvedValue(over)
    const r = await notifyLineQuotaLevels(fakeDb(['ws1']), at('2026-10-22T10:00:00'))
    expect(r).toEqual({ checked: 1, warned: 0, emailed: 1 })
    expect(pushToNotifyList).not.toHaveBeenCalled()
    const mail = sendEmail.mock.calls[0]![0]
    expect(mail.to).toBe('owner@example.com')
    expect(mail.subject).toContain('LINE 這個月的訊息用完了')
    expect(mail.text).toContain('推播、你在後台回客人的訊息、傳給你的 LINE 通知')
    expect(mail.text).toContain('AI 回客人')
  })

  it('半夜也寄（信不會吵醒人，用完了等不了）；同一個月只寄一次', async () => {
    readLineMessageQuota.mockResolvedValue(over)
    const db = fakeDb(['ws1'])
    await notifyLineQuotaLevels(db, at('2026-10-22T02:00:00'))
    await notifyLineQuotaLevels(db, at('2026-10-22T09:00:00'))
    expect(sendEmail).toHaveBeenCalledTimes(1)
  })

  it('🔴 沒設寄信（略過）→ 不記「寄過了」，6 小時後再試', async () => {
    readLineMessageQuota.mockResolvedValue(over)
    sendEmail.mockResolvedValue({ ok: false, skipped: true })
    const db = fakeDb(['ws1'])
    await notifyLineQuotaLevels(db, at('2026-10-22T10:00:00'))
    await notifyLineQuotaLevels(db, at('2026-10-22T12:00:00'))
    expect(sendEmail).toHaveBeenCalledTimes(1)
    sendEmail.mockResolvedValue({ ok: true })
    expect((await notifyLineQuotaLevels(db, at('2026-10-22T17:00:00'))).emailed).toBe(1)
  })

  it('查不到可以寄的信箱 → 不寄', async () => {
    readLineMessageQuota.mockResolvedValue(over)
    resolveBillingRecipient.mockResolvedValue({ email: null, workspaceName: 'x' })
    await notifyLineQuotaLevels(fakeDb(['ws1']), at('2026-10-22T10:00:00'))
    expect(sendEmail).not.toHaveBeenCalled()
  })
})

describe('不該發的時候', () => {
  it('🔴 問不到 LINE、沒接 LINE、平常 → 不傳不寄', async () => {
    for (const read of [{ kind: 'error', detail: 'x' }, { kind: 'unconfigured' }, fine]) {
      readLineMessageQuota.mockResolvedValue(read)
      await notifyLineQuotaLevels(fakeDb(['ws1']), at('2026-10-22T10:00:00'))
      store = new Map()
    }
    expect(pushToNotifyList).not.toHaveBeenCalled()
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('每個帳號一小時只問 LINE 一次', async () => {
    readLineMessageQuota.mockResolvedValue(fine)
    const db = fakeDb(['ws1', 'ws2'])
    await notifyLineQuotaLevels(db, at('2026-10-22T10:00:00'))
    await notifyLineQuotaLevels(db, at('2026-10-22T10:30:00'))
    expect(readLineMessageQuota).toHaveBeenCalledTimes(2)
    await notifyLineQuotaLevels(db, at('2026-10-22T10:00:00') + HOUR)
    expect(readLineMessageQuota).toHaveBeenCalledTimes(4)
  })
})
