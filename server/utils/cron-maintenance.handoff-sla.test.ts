/**
 * SLA 逾時提醒的「同輪合併」測試（2026-08-07 通知爆量修正）。
 *
 * 要守住的行為：
 *  - 同一 workspace 同一輪多場逾時 → 只發一則合併通知（不是一場一則）
 *  - 只有一場 → 維持完整格式（帶摘要與客人原話）
 *  - 不同 workspace 各自一則（不會跨租戶合併）
 *  - 沒送出去（勿擾／關閉）→ 不蓋 slaRemindedAt，留給下一輪
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __op: 'ts' }), delete: () => ({ __op: 'del' }) },
  Timestamp: { now: () => ({ __ts: 'now' }), fromMillis: (ms: number) => ({ __ts: ms }) },
}))

// cron-maintenance 匯入的其他工作全部擋掉：這支測試只碰 remindOverdueHandoffs
vi.mock('./ai-knowledge-sources', () => ({
  KNOWLEDGE_SOURCES_COLLECTION: 'knowledgeSources',
  buildSourceClearFailure: () => ({}),
  clearSourceFailure: vi.fn(),
  markSourceOutdated: vi.fn(),
}))
vi.mock('./ai-knowledge-chunks', () => ({ KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks' }))
vi.mock('./ai-knowledge-suggest', () => ({ KNOWLEDGE_SUGGESTIONS_COLLECTION: 'knowledgeSuggestions' }))
vi.mock('./ai-knowledge-autoapply', () => ({ tryAutoApplyMinorChange: vi.fn() }))
vi.mock('./ai-source-extractors', () => ({ extractUrlText: vi.fn() }))
vi.mock('./gsheet-sync', () => ({ syncGoogleSheetSource: vi.fn() }))
vi.mock('./conversation-session', () => ({ handBackSessionToBot: vi.fn() }))
vi.mock('./webhook-dedup', () => ({ WEBHOOK_EVENT_LOCKS_COLLECTION: 'webhookEventLocks' }))
vi.mock('./line', () => ({ pushMessage: vi.fn() }))

const { getAiSettings } = vi.hoisted(() => ({ getAiSettings: vi.fn() }))
vi.mock('./ai-settings', () => ({ getAiSettings }))

const { notifyHandoffToStaff, notifyOverdueHandoffBatch } = vi.hoisted(() => ({
  notifyHandoffToStaff: vi.fn(async (_params: any) => true),
  notifyOverdueHandoffBatch: vi.fn(async (_params: any) => true),
}))
vi.mock('./ai-handoff-notify', () => ({ notifyHandoffToStaff, notifyOverdueHandoffBatch }))

import { remindOverdueHandoffs } from './cron-maintenance'

const NOW = 1_770_000_000_000 // 固定時間，等待分鐘數才算得準

interface SessionSeed {
  id: string
  workspaceId: string
  userId: string
  /** 轉真人是幾分鐘前提出的 */
  requestedMinutesAgo: number
  slaRemindedAt?: unknown
  humanFirstRepliedAt?: unknown
}

function makeDb(
  seeds: SessionSeed[],
  names: Record<string, string> = {},
  contexts: Record<string, unknown> = {},
) {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = []
  const docs = seeds.map(s => ({
    id: s.id,
    data: () => ({
      workspaceId: s.workspaceId,
      userId: s.userId,
      handoffRequestedAt: { toMillis: () => NOW - s.requestedMinutesAgo * 60_000 },
      slaRemindedAt: s.slaRemindedAt,
      humanFirstRepliedAt: s.humanFirstRepliedAt,
    }),
    ref: { update: async (patch: Record<string, unknown>) => { updates.push({ id: s.id, patch }) } },
  }))

  const db = {
    collection(name: string) {
      if (name === 'conversationSessions') {
        return {
          where: () => ({
            limit: () => ({ get: async () => ({ size: docs.length, docs, empty: !docs.length }) }),
          }),
        }
      }
      const store: Record<string, unknown> = name === 'users'
        ? Object.fromEntries(Object.entries(names).map(([k, v]) => [k, { displayName: v }]))
        : Object.fromEntries(Object.entries(contexts).map(([k, v]) => [k, { handoffNotifyContext: v }]))
      return { doc: (id: string) => ({ get: async () => ({ data: () => store[id] }) }) }
    },
  } as any
  return { db, updates }
}

function settings(overrides: Record<string, unknown> = {}) {
  return {
    handoffNotify: { enabled: true, lineUserIds: ['Sa'], mode: 'missed_only', slaRemindMinutes: 30, digestHour: 9 },
    serviceHours: { enabled: false, start: '09:00', end: '18:00', weekendOff: true, dndReply: '' },
    ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  getAiSettings.mockReset()
  getAiSettings.mockResolvedValue(settings())
  notifyHandoffToStaff.mockClear()
  notifyOverdueHandoffBatch.mockClear()
  notifyOverdueHandoffBatch.mockResolvedValue(true)
  notifyHandoffToStaff.mockResolvedValue(true)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('remindOverdueHandoffs 同輪合併', () => {
  it('同一 workspace 三場逾時 → 一則合併通知，三場都蓋章', async () => {
    const { db, updates } = makeDb(
      [
        { id: 's1', workspaceId: 'WS', userId: 'U1', requestedMinutesAgo: 45 },
        { id: 's2', workspaceId: 'WS', userId: 'U2', requestedMinutesAgo: 660 },
        { id: 's3', workspaceId: 'WS', userId: 'U3', requestedMinutesAgo: 32 },
      ],
      { WS_U1: '小美', WS_U2: '王小明' }, // U3 沒暱稱 → 走「未知暱稱」
    )
    const tally = await remindOverdueHandoffs(db)

    expect(notifyOverdueHandoffBatch).toHaveBeenCalledTimes(1)
    expect(notifyHandoffToStaff).not.toHaveBeenCalled()
    const call = notifyOverdueHandoffBatch.mock.calls[0]![0] as any
    expect(call.workspaceId).toBe('WS')
    expect(call.slaReminderMinutes).toBe(30)
    expect(call.items).toHaveLength(3)
    expect(call.items.map((i: any) => i.customerName)).toEqual(['小美', '王小明', '未知暱稱（…U3）'])
    // 等待毫秒由 handoffRequestedAt 算出，排序交給通知端
    expect(call.items[1].waitedMs).toBe(660 * 60_000)

    expect(updates.map(u => u.id).sort()).toEqual(['s1', 's2', 's3'])
    expect(tally).toMatchObject({ reminded: 3, messages: 1 })
  })

  it('只有一場逾時 → 維持完整格式，帶轉真人當下存的摘要與客人原話', async () => {
    const { db, updates } = makeDb(
      [{ id: 's1', workspaceId: 'WS', userId: 'U1', requestedMinutesAgo: 45 }],
      { WS_U1: '小美' },
      {
        WS_U1: {
          summary: '客人問退貨流程',
          message: '我要退貨',
          reason: 'user_request',
          at: { toMillis: () => NOW - 45 * 60_000 },
        },
      },
    )
    const tally = await remindOverdueHandoffs(db)

    expect(notifyOverdueHandoffBatch).not.toHaveBeenCalled()
    expect(notifyHandoffToStaff).toHaveBeenCalledTimes(1)
    expect(notifyHandoffToStaff.mock.calls[0]![0]).toMatchObject({
      workspaceId: 'WS',
      customerName: '小美',
      customerMessage: '我要退貨',
      summary: '客人問退貨流程',
      reason: 'user_request',
      slaReminderMinutes: 30,
    })
    expect(updates).toHaveLength(1)
    expect(tally).toMatchObject({ reminded: 1, messages: 1 })
  })

  it('不同 workspace 不合併：各自一則', async () => {
    const { db } = makeDb([
      { id: 'a1', workspaceId: 'WS-A', userId: 'U1', requestedMinutesAgo: 45 },
      { id: 'a2', workspaceId: 'WS-A', userId: 'U2', requestedMinutesAgo: 50 },
      { id: 'b1', workspaceId: 'WS-B', userId: 'U3', requestedMinutesAgo: 60 },
      { id: 'b2', workspaceId: 'WS-B', userId: 'U4', requestedMinutesAgo: 70 },
    ])
    const tally = await remindOverdueHandoffs(db)

    expect(notifyOverdueHandoffBatch).toHaveBeenCalledTimes(2)
    const wsIds = notifyOverdueHandoffBatch.mock.calls.map(c => (c[0] as any).workspaceId).sort()
    expect(wsIds).toEqual(['WS-A', 'WS-B'])
    expect(tally).toMatchObject({ reminded: 4, messages: 2 })
  })

  it('還沒到 SLA 的不列入合併（也不蓋章）', async () => {
    const { db, updates } = makeDb([
      { id: 's1', workspaceId: 'WS', userId: 'U1', requestedMinutesAgo: 45 },
      { id: 's2', workspaceId: 'WS', userId: 'U2', requestedMinutesAgo: 50 },
      { id: 'fresh', workspaceId: 'WS', userId: 'U3', requestedMinutesAgo: 5 },
    ])
    const tally = await remindOverdueHandoffs(db)

    const call = notifyOverdueHandoffBatch.mock.calls[0]![0] as any
    expect(call.items.map((i: any) => i.customerLineUserId)).toEqual(['U1', 'U2'])
    expect(updates.map(u => u.id)).not.toContain('fresh')
    expect(tally).toMatchObject({ reminded: 2, messages: 1, skipped: 1 })
  })

  it('已提醒過／真人已首接的場次直接跳過', async () => {
    const { db, updates } = makeDb([
      { id: 'done', workspaceId: 'WS', userId: 'U1', requestedMinutesAgo: 45, slaRemindedAt: { __ts: 1 } },
      { id: 'answered', workspaceId: 'WS', userId: 'U2', requestedMinutesAgo: 50, humanFirstRepliedAt: { __ts: 1 } },
    ])
    const tally = await remindOverdueHandoffs(db)

    expect(notifyOverdueHandoffBatch).not.toHaveBeenCalled()
    expect(notifyHandoffToStaff).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
    expect(tally).toMatchObject({ reminded: 0, messages: 0, skipped: 2 })
  })

  it('勿擾時段：整個 workspace 跳過且不蓋章（否則這場的提醒永遠補不回來）', async () => {
    getAiSettings.mockResolvedValue(settings({
      // start === end → 一天 24 小時都算勿擾
      serviceHours: { enabled: true, start: '00:00', end: '00:00', weekendOff: false, dndReply: '' },
    }))
    const { db, updates } = makeDb([
      { id: 's1', workspaceId: 'WS', userId: 'U1', requestedMinutesAgo: 45 },
      { id: 's2', workspaceId: 'WS', userId: 'U2', requestedMinutesAgo: 50 },
    ])
    const tally = await remindOverdueHandoffs(db)

    expect(notifyOverdueHandoffBatch).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
    expect(tally).toMatchObject({ reminded: 0, messages: 0, skipped: 2 })
  })

  it('通知端回 false（被節流吞掉）→ 不蓋章，下一輪再試', async () => {
    notifyOverdueHandoffBatch.mockResolvedValueOnce(false)
    const { db, updates } = makeDb([
      { id: 's1', workspaceId: 'WS', userId: 'U1', requestedMinutesAgo: 45 },
      { id: 's2', workspaceId: 'WS', userId: 'U2', requestedMinutesAgo: 50 },
    ])
    const tally = await remindOverdueHandoffs(db)

    expect(updates).toHaveLength(0)
    expect(tally).toMatchObject({ reminded: 0, messages: 0 })
  })

  it('SLA 關閉（slaRemindMinutes=0）→ 不發也不蓋章', async () => {
    getAiSettings.mockResolvedValue(settings({
      handoffNotify: { enabled: true, lineUserIds: ['Sa'], mode: 'always', slaRemindMinutes: 0, digestHour: 9 },
    }))
    const { db, updates } = makeDb([
      { id: 's1', workspaceId: 'WS', userId: 'U1', requestedMinutesAgo: 45 },
      { id: 's2', workspaceId: 'WS', userId: 'U2', requestedMinutesAgo: 50 },
    ])
    await remindOverdueHandoffs(db)

    expect(notifyOverdueHandoffBatch).not.toHaveBeenCalled()
    expect(notifyHandoffToStaff).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
  })
})
