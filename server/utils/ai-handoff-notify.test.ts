/**
 * 轉真人通知的模式分叉測試（2026-08-06 通知改版）：
 *  - always：當下推播（原行為）
 *  - missed_only：當下不推、把摘要存進 conversations doc；超時提醒帶完整內容
 *  - 額度 100% 用完通知：每期一次
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __op: 'ts' }) },
}))

const { pushMessage } = vi.hoisted(() => ({ pushMessage: vi.fn(async (...args: any[]) => ({ args })) }))
vi.mock('./line', () => ({ pushMessage }))

const { getAiSettings } = vi.hoisted(() => ({ getAiSettings: vi.fn() }))
vi.mock('./ai-settings', () => ({ getAiSettings }))

const { getDb, convSet } = vi.hoisted(() => {
  const convSet = vi.fn(async (...args: any[]) => ({ args }))
  return {
    convSet,
    getDb: vi.fn(() => ({
      collection: (name: string) => ({
        doc: (id: string) => ({
          set: (patch: unknown, opts: unknown) => convSet(name, id, patch, opts),
        }),
      }),
    })),
  }
})
vi.mock('./firebase', () => ({ getDb }))

import { notifyHandoffToStaff, maybeNotifyQuotaExhausted } from './ai-handoff-notify'

function settingsWith(mode: 'always' | 'missed_only') {
  return {
    handoffNotify: { enabled: true, lineUserIds: ['Sa', 'Sb'], mode, slaRemindMinutes: 30, digestHour: 9 },
    serviceHours: { enabled: false, start: '09:00', end: '18:00', weekendOff: true, dndReply: '' },
  }
}

beforeEach(() => {
  pushMessage.mockClear()
  convSet.mockClear()
  getAiSettings.mockReset()
})

// 節流 map 是模組層級的,每個測試用不同客人 id 避免互相吃掉

describe('notifyHandoffToStaff 模式分叉', () => {
  it('always:轉真人當下推播給名單上每個人,不寫 context', async () => {
    getAiSettings.mockResolvedValue(settingsWith('always'))
    await notifyHandoffToStaff({
      workspaceId: 'WS', customerLineUserId: 'U-always', customerName: '小明',
      customerMessage: '我要退貨', reason: 'user_request', summary: '客人想退貨',
    })
    expect(pushMessage).toHaveBeenCalledTimes(2)
    const text = (pushMessage.mock.calls[0]![1] as any)[0].text as string
    expect(text).toContain('🙋 真人客服請求')
    expect(text).toContain('小明')
    expect(text).toContain('客人想退貨')
    expect(convSet).not.toHaveBeenCalled()
  })

  it('missed_only:當下不推播,把摘要/訊息/原因存進 conversations doc', async () => {
    getAiSettings.mockResolvedValue(settingsWith('missed_only'))
    await notifyHandoffToStaff({
      workspaceId: 'WS', customerLineUserId: 'U-missed', customerName: '小華',
      customerMessage: '訂單卡住了', reason: 'low_confidence', summary: '訂單問題',
    })
    expect(pushMessage).not.toHaveBeenCalled()
    expect(convSet).toHaveBeenCalledTimes(1)
    const [collection, docId, patch] = convSet.mock.calls[0]! as any[]
    expect(collection).toBe('conversations')
    expect(docId).toBe('WS_U-missed')
    expect(patch.handoffNotifyContext).toMatchObject({
      summary: '訂單問題', message: '訂單卡住了', reason: 'low_confidence',
    })
  })

  it('超時提醒帶存檔內容時,發成完整的請求通知(missed_only 的唯一一則)', async () => {
    getAiSettings.mockResolvedValue(settingsWith('missed_only'))
    await notifyHandoffToStaff({
      workspaceId: 'WS', customerLineUserId: 'U-sla-rich', customerName: '小美',
      customerMessage: '出貨了嗎', reason: 'order_status', summary: '客人查物流',
      slaReminderMinutes: 30,
    })
    expect(pushMessage).toHaveBeenCalledTimes(2)
    const text = (pushMessage.mock.calls[0]![1] as any)[0].text as string
    expect(text).toContain('已等超過 30 分鐘沒人接手')
    expect(text).toContain('客人查物流')
    expect(text).toContain('出貨了嗎')
    expect(text).toContain('要查客人的訂單')
  })

  it('超時提醒沒有存檔內容時,維持短版再提醒(always 模式的第二則)', async () => {
    getAiSettings.mockResolvedValue(settingsWith('always'))
    await notifyHandoffToStaff({
      workspaceId: 'WS', customerLineUserId: 'U-sla-plain', customerName: '小強',
      customerMessage: '', reason: null, slaReminderMinutes: 30,
    })
    expect(pushMessage).toHaveBeenCalledTimes(2)
    const text = (pushMessage.mock.calls[0]![1] as any)[0].text as string
    expect(text).toContain('⏰ 提醒：真人客服請求尚未回應')
    expect(text).toContain('已等待超過 30 分鐘')
  })
})

describe('maybeNotifyQuotaExhausted', () => {
  function makeAlertsDb(existing: Record<string, unknown> | undefined) {
    const set = vi.fn(async () => ({}))
    const db = {
      collection: (_: string) => ({
        doc: (_id: string) => ({
          get: async () => ({ data: () => existing }),
          set,
        }),
      }),
    } as any
    return { db, set }
  }

  it('每期只發一次:同 periodKey 已標記就不再推', async () => {
    getAiSettings.mockResolvedValue(settingsWith('always'))
    const { db, set } = makeAlertsDb({ exhaustedPeriodKey: 'p_2026-08-01' })
    await maybeNotifyQuotaExhausted({
      workspaceId: 'WS', periodKey: 'p_2026-08-01', usageText: '本期 AI 回覆則數 1000/1000',
      action: 'handoff', db,
    })
    expect(set).not.toHaveBeenCalled()
    expect(pushMessage).not.toHaveBeenCalled()
  })

  it('首次用完:寫標記並推播,handoff 策略講「全部轉真人」', async () => {
    getAiSettings.mockResolvedValue(settingsWith('always'))
    const { db, set } = makeAlertsDb(undefined)
    await maybeNotifyQuotaExhausted({
      workspaceId: 'WS', periodKey: 'p_2026-08-01', usageText: '本期 AI 回覆則數 1000/1000',
      action: 'handoff', db,
    })
    expect(set).toHaveBeenCalledTimes(1)
    expect(pushMessage).toHaveBeenCalledTimes(2)
    const text = (pushMessage.mock.calls[0]![1] as any)[0].text as string
    expect(text).toContain('🚫 AI 額度已用完')
    expect(text).toContain('全部轉給真人客服')
  })
})
