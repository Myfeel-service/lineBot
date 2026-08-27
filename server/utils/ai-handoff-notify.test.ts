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

import { notifyHandoffToStaff, notifyOverdueHandoffBatch, maybeNotifyQuotaExhausted, maybeWarnQuotaThreshold } from './ai-handoff-notify'

function settingsWith(mode: 'always' | 'missed_only') {
  return {
    handoffNotify: { enabled: true, lineUserIds: ['Sa', 'Sb'], mode, slaRemindMinutes: 30, digestHour: 9 },
    serviceHours: { enabled: false, start: '09:00', end: '18:00', weekendOff: true, dndReply: '' },
  }
}

beforeEach(() => {
  pushMessage.mockClear()
  // mockClear 只清呼叫紀錄不清實作:測「推播全滅」的案例用 mockRejectedValue 換過實作,
  // 這裡要還原,否則洩漏到後面的測試
  pushMessage.mockImplementation(async (...args: any[]) => ({ args }))
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

describe('notifyOverdueHandoffBatch 逾時提醒合併', () => {
  function item(id: string, name: string, waitedMs: number, reason: any = null) {
    return { customerLineUserId: id, customerName: name, waitedMs, reason }
  }

  it('多位客人合併成一則:每位一行帶等待時間與原因,等最久的排最前面', async () => {
    getAiSettings.mockResolvedValue(settingsWith('missed_only'))
    const sent = await notifyOverdueHandoffBatch({
      workspaceId: 'WS',
      slaReminderMinutes: 30,
      items: [
        item('U-b1', '小美', 45 * 60_000, 'low_confidence'),
        item('U-b2', '王小明', 11 * 3600_000, 'user_request'),
        item('U-b3', '未知暱稱（…a3f2b1）', 32 * 60_000),
      ],
    })
    expect(sent).toBe(true)
    // 3 位客人、2 個收件人 → 2 則（不是 6 則）
    expect(pushMessage).toHaveBeenCalledTimes(2)
    const text = (pushMessage.mock.calls[0]![1] as any)[0].text as string
    expect(text).toContain('🙋 3 位客人在等真人客服（都已超過 30 分鐘沒人接手）')
    // 等最久的王小明在第一行；小時／分鐘用白話寫
    const lines = text.split('\n')
    expect(lines[1]).toBe('・王小明 — 等 11 小時・客人要求真人')
    expect(lines[2]).toBe('・小美 — 等 45 分鐘・信心不足')
    // 沒有存檔原因的那位不留空的「・」尾巴
    expect(lines[3]).toBe('・未知暱稱（…a3f2b1） — 等 32 分鐘')
    expect(text).not.toContain('另有')
  })

  it('超過 10 位只列前 10 位,其餘給筆數', async () => {
    getAiSettings.mockResolvedValue(settingsWith('missed_only'))
    const items = Array.from({ length: 13 }, (_, i) =>
      item(`U-many-${i}`, `客人${i}`, (60 + i) * 60_000, 'user_request'))
    await notifyOverdueHandoffBatch({ workspaceId: 'WS', slaReminderMinutes: 30, items })
    const text = (pushMessage.mock.calls[0]![1] as any)[0].text as string
    expect(text).toContain('🙋 13 位客人在等真人客服')
    expect(text).toContain('・另有 3 位客人在等（完整名單請看後台）')
    // 等最久的是 index 12
    expect(text.split('\n')[1]).toContain('客人12')
    expect(text).not.toContain('客人0 —')
  })

  it('勿擾時段內不推播,回 false 讓呼叫端別蓋 slaRemindedAt', async () => {
    getAiSettings.mockResolvedValue({
      handoffNotify: { enabled: true, lineUserIds: ['Sa'], mode: 'missed_only', slaRemindMinutes: 30, digestHour: 9 },
      // start === end → 服務時段長度為 0 → 一天 24 小時都算勿擾（測試不能靠跑的當下幾點）
      serviceHours: { enabled: true, start: '00:00', end: '00:00', weekendOff: false, dndReply: '' },
    })
    const sent = await notifyOverdueHandoffBatch({
      workspaceId: 'WS', slaReminderMinutes: 30,
      items: [item('U-dnd1', '甲', 60 * 60_000), item('U-dnd2', '乙', 70 * 60_000)],
    })
    expect(sent).toBe(false)
    expect(pushMessage).not.toHaveBeenCalled()
  })

  it('通知關閉或名單為空時不發', async () => {
    getAiSettings.mockResolvedValue({
      handoffNotify: { enabled: true, lineUserIds: [], mode: 'always', slaRemindMinutes: 30, digestHour: 9 },
      serviceHours: { enabled: false, start: '09:00', end: '18:00', weekendOff: true, dndReply: '' },
    })
    expect(await notifyOverdueHandoffBatch({
      workspaceId: 'WS', slaReminderMinutes: 30,
      items: [item('U-off1', '甲', 60 * 60_000), item('U-off2', '乙', 70 * 60_000)],
    })).toBe(false)
    expect(pushMessage).not.toHaveBeenCalled()
  })

  it('合併過的客人會記進節流:接下來的即時通知不重複吵', async () => {
    getAiSettings.mockResolvedValue(settingsWith('always'))
    await notifyOverdueHandoffBatch({
      workspaceId: 'WS', slaReminderMinutes: 30,
      items: [item('U-thr1', '甲', 60 * 60_000), item('U-thr2', '乙', 70 * 60_000)],
    })
    expect(pushMessage).toHaveBeenCalledTimes(2)
    pushMessage.mockClear()
    const again = await notifyHandoffToStaff({
      workspaceId: 'WS', customerLineUserId: 'U-thr1', customerName: '甲',
      customerMessage: '還沒有人回我', reason: 'user_request',
    })
    expect(again).toBe(false)
    expect(pushMessage).not.toHaveBeenCalled()
  })
})

describe('maybeNotifyQuotaExhausted', () => {
  function makeAlertsDb(existing: Record<string, unknown> | undefined) {
    const set = vi.fn(async (..._args: any[]) => ({}))
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

  it('首次用完:記「嘗試過」→推播→送達才記「這期已發」,handoff 策略講「全部轉真人」', async () => {
    getAiSettings.mockResolvedValue(settingsWith('always'))
    const { db, set } = makeAlertsDb(undefined)
    await maybeNotifyQuotaExhausted({
      workspaceId: 'WS', periodKey: 'p_2026-08-01', usageText: '本期 AI 回覆則數 1000/1000',
      action: 'handoff', db,
    })
    // 兩筆寫入:推播前的「嘗試過」＋至少送達一人後的「這期已發」(C-89)
    expect(set).toHaveBeenCalledTimes(2)
    expect(set.mock.calls[0]![0]).toHaveProperty('exhaustedAttemptKey', 'p_2026-08-01')
    expect(set.mock.calls[1]![0]).toHaveProperty('exhaustedPeriodKey', 'p_2026-08-01')
    expect(pushMessage).toHaveBeenCalledTimes(2)
    const text = (pushMessage.mock.calls[0]![1] as any)[0].text as string
    expect(text).toContain('🚫 AI 額度已用完')
    expect(text).toContain('全部轉給真人客服')
  })

  // C-89:原本「先寫標記再推播」,推播全滅只留 log → 每期一次的警報這期永遠沉默
  it('推播全滅:不記「這期已發」,退避窗過後會重試', async () => {
    getAiSettings.mockResolvedValue(settingsWith('always'))
    pushMessage.mockRejectedValue(new Error('名單全部不是好友'))
    const { db, set } = makeAlertsDb(undefined)
    await maybeNotifyQuotaExhausted({
      workspaceId: 'WS', periodKey: 'p_2026-08-01', usageText: '本期 AI 回覆則數 1000/1000',
      action: 'handoff', db,
    })
    expect(set).toHaveBeenCalledTimes(1) // 只有「嘗試過」
    expect(set.mock.calls[0]![0]).not.toHaveProperty('exhaustedPeriodKey')

    // 退避窗內(剛失敗過)→ 不重打 LINE API
    pushMessage.mockClear()
    const recent = makeAlertsDb({ exhaustedAttemptKey: 'p_2026-08-01', exhaustedAttemptAtMs: Date.now() - 60_000 })
    await maybeNotifyQuotaExhausted({
      workspaceId: 'WS', periodKey: 'p_2026-08-01', usageText: '本期 AI 回覆則數 1000/1000',
      action: 'handoff', db: recent.db,
    })
    expect(pushMessage).not.toHaveBeenCalled()

    // 退避窗過了 → 再試一次
    pushMessage.mockClear()
    pushMessage.mockResolvedValue({} as any)
    const stale = makeAlertsDb({ exhaustedAttemptKey: 'p_2026-08-01', exhaustedAttemptAtMs: Date.now() - 7 * 3600_000 })
    await maybeNotifyQuotaExhausted({
      workspaceId: 'WS', periodKey: 'p_2026-08-01', usageText: '本期 AI 回覆則數 1000/1000',
      action: 'handoff', db: stale.db,
    })
    expect(pushMessage).toHaveBeenCalledTimes(2)
    expect(stale.set.mock.calls[1]![0]).toHaveProperty('exhaustedPeriodKey', 'p_2026-08-01')
  })
})

describe('maybeWarnQuotaThreshold(80% 預警)', () => {
  function makeAlertsDb(existing: Record<string, unknown> | undefined) {
    const set = vi.fn(async (..._args: any[]) => ({}))
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

  it('低於 80% 直接返回,連設定都不讀(熱路徑零額外讀取)', async () => {
    await maybeWarnQuotaThreshold({ workspaceId: 'WS', ratio: 0.5, periodKey: 'p_2026-08-01', usageText: 'x', db: makeAlertsDb(undefined).db })
    expect(getAiSettings).not.toHaveBeenCalled()
    expect(pushMessage).not.toHaveBeenCalled()
  })

  it('首次跨 80%:記「嘗試過」→推播→送達才記「這期已警告」', async () => {
    getAiSettings.mockResolvedValue(settingsWith('always'))
    const { db, set } = makeAlertsDb(undefined)
    await maybeWarnQuotaThreshold({ workspaceId: 'WS', ratio: 0.81, periodKey: 'p_2026-08-01', usageText: '本期 AI 回覆則數 812/1000', db })
    expect(set).toHaveBeenCalledTimes(2)
    expect(set.mock.calls[0]![0]).toHaveProperty('warnAttemptKey', 'p_2026-08-01')
    expect(set.mock.calls[1]![0]).toHaveProperty('periodKey', 'p_2026-08-01')
    expect(pushMessage).toHaveBeenCalledTimes(2)
    expect((pushMessage.mock.calls[0]![1] as any)[0].text).toContain('⚠️ AI 用量預警')
  })

  it('同期已警告過 → 不再推', async () => {
    getAiSettings.mockResolvedValue(settingsWith('always'))
    const { db, set } = makeAlertsDb({ periodKey: 'p_2026-08-01' })
    await maybeWarnQuotaThreshold({ workspaceId: 'WS', ratio: 0.9, periodKey: 'p_2026-08-01', usageText: 'x', db })
    expect(set).not.toHaveBeenCalled()
    expect(pushMessage).not.toHaveBeenCalled()
  })

  it('推播全滅 → 不記「這期已警告」(C-89:記了這期就永遠沉默)', async () => {
    getAiSettings.mockResolvedValue(settingsWith('always'))
    pushMessage.mockRejectedValue(new Error('blocked'))
    const { db, set } = makeAlertsDb(undefined)
    await maybeWarnQuotaThreshold({ workspaceId: 'WS', ratio: 0.85, periodKey: 'p_2026-08-01', usageText: 'x', db })
    expect(set).toHaveBeenCalledTimes(1)
    expect(set.mock.calls[0]![0]).not.toHaveProperty('periodKey')
  })
})
