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
vi.mock('./conversation-session', () => ({ handBackSessionToBot: vi.fn(), closeConversationSession: vi.fn() }))
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
  /** 客人回來、被放回待真人是幾分鐘前（`C-381`） */
  returnedMinutesAgo?: number
  /** 真人最後一次回覆是幾分鐘前 */
  humanLastRepliedMinutesAgo?: number
  /** 客服剛按了哪一顆、客人接著講才回到待真人的（`C-382`） */
  returnedAfterRelease?: 'close' | 'handback'
  /**
   * 模擬「另一個排程執行者在這一輪中間搶先蓋了章」：
   * 查詢快照看不到章（跟現場一樣），交易內讀到的即時資料有章。
   */
  stampedByOtherExecutor?: boolean
}

/** FieldValue.delete() 要真的把欄位刪掉，否則測不出「拆章」 */
function applyPatch(data: Record<string, unknown>, patch: Record<string, unknown>) {
  for (const [k, v] of Object.entries(patch)) {
    if ((v as any)?.__op === 'del') delete data[k]
    else data[k] = v
  }
}

function makeDb(
  seeds: SessionSeed[],
  names: Record<string, string> = {},
  contexts: Record<string, unknown> = {},
) {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = []

  const docs = seeds.map((s) => {
    const base = {
      workspaceId: s.workspaceId,
      userId: s.userId,
      handoffRequestedAt: { toMillis: () => NOW - s.requestedMinutesAgo * 60_000 },
      slaRemindedAt: s.slaRemindedAt,
      humanFirstRepliedAt: s.humanFirstRepliedAt,
      ...(s.returnedMinutesAgo != null
        ? { customerReturnedAt: { toMillis: () => NOW - s.returnedMinutesAgo! * 60_000 } }
        : {}),
      ...(s.humanLastRepliedMinutesAgo != null
        ? { humanLastRepliedAt: { toMillis: () => NOW - s.humanLastRepliedMinutesAgo! * 60_000 } }
        : {}),
      ...(s.returnedAfterRelease ? { returnedAfterRelease: s.returnedAfterRelease } : {}),
    }
    // live = 交易讀到的即時資料；snapshot = 掃描那一刻的快照（兩者刻意可以不同）
    const live: Record<string, unknown> = { ...base }
    if (s.stampedByOtherExecutor) live.slaRemindedAt = { __ts: 'other-executor' }
    const ref = {
      id: s.id,
      __live: live,
      update: async (patch: Record<string, unknown>) => {
        updates.push({ id: s.id, patch })
        applyPatch(live, patch)
      },
    }
    return { id: s.id, data: () => ({ ...base }), ref }
  })

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
    async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      return fn({
        get: async (ref: any) => ({ exists: true, data: () => ref.__live }),
        update: (ref: any, patch: Record<string, unknown>) => {
          updates.push({ id: ref.id, patch })
          applyPatch(ref.__live, patch)
        },
      })
    },
  } as any

  /** 最終真的留著章的場次（認領後又拆掉的不算） */
  const stampedIds = () => docs.filter(d => d.ref.__live.slaRemindedAt).map(d => d.id).sort()
  return { db, updates, stampedIds }
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
    const { db, stampedIds } = makeDb(
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

    expect(stampedIds()).toEqual(['s1', 's2', 's3'])
    expect(tally).toMatchObject({ reminded: 3, messages: 1 })
  })

  it('只有一場逾時 → 維持完整格式，帶轉真人當下存的摘要與客人原話', async () => {
    const { db, stampedIds } = makeDb(
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
    expect(stampedIds()).toEqual(['s1'])
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
    const { db, stampedIds } = makeDb([
      { id: 's1', workspaceId: 'WS', userId: 'U1', requestedMinutesAgo: 45 },
      { id: 's2', workspaceId: 'WS', userId: 'U2', requestedMinutesAgo: 50 },
      { id: 'fresh', workspaceId: 'WS', userId: 'U3', requestedMinutesAgo: 5 },
    ])
    const tally = await remindOverdueHandoffs(db)

    const call = notifyOverdueHandoffBatch.mock.calls[0]![0] as any
    expect(call.items.map((i: any) => i.customerLineUserId)).toEqual(['U1', 'U2'])
    expect(stampedIds()).toEqual(['s1', 's2'])
    expect(tally).toMatchObject({ reminded: 2, messages: 1, skipped: 1 })
  })

  it('已提醒過／真人已首接的場次直接跳過', async () => {
    const { db, stampedIds } = makeDb([
      { id: 'done', workspaceId: 'WS', userId: 'U1', requestedMinutesAgo: 45, slaRemindedAt: { __ts: 1 } },
      { id: 'answered', workspaceId: 'WS', userId: 'U2', requestedMinutesAgo: 50, humanFirstRepliedAt: { __ts: 1 } },
    ])
    const tally = await remindOverdueHandoffs(db)

    expect(notifyOverdueHandoffBatch).not.toHaveBeenCalled()
    expect(notifyHandoffToStaff).not.toHaveBeenCalled()
    expect(stampedIds()).toEqual(['done'])
    expect(tally).toMatchObject({ reminded: 0, messages: 0, skipped: 2 })
  })

  it('勿擾時段：整個 workspace 跳過且不蓋章（否則這場的提醒永遠補不回來）', async () => {
    getAiSettings.mockResolvedValue(settings({
      // start === end → 一天 24 小時都算勿擾
      serviceHours: { enabled: true, start: '00:00', end: '00:00', weekendOff: false, dndReply: '' },
    }))
    const { db, stampedIds } = makeDb([
      { id: 's1', workspaceId: 'WS', userId: 'U1', requestedMinutesAgo: 45 },
      { id: 's2', workspaceId: 'WS', userId: 'U2', requestedMinutesAgo: 50 },
    ])
    const tally = await remindOverdueHandoffs(db)

    expect(notifyOverdueHandoffBatch).not.toHaveBeenCalled()
    expect(stampedIds()).toEqual([])
    expect(tally).toMatchObject({ reminded: 0, messages: 0, skipped: 2 })
  })

  it('通知端回 false（被節流吞掉）→ 認領的章要拆掉，下一輪再試', async () => {
    notifyOverdueHandoffBatch.mockResolvedValueOnce(false)
    const { db, stampedIds } = makeDb([
      { id: 's1', workspaceId: 'WS', userId: 'U1', requestedMinutesAgo: 45 },
      { id: 's2', workspaceId: 'WS', userId: 'U2', requestedMinutesAgo: 50 },
    ])
    const tally = await remindOverdueHandoffs(db)

    expect(stampedIds()).toEqual([])
    expect(tally).toMatchObject({ reminded: 0, messages: 0 })
  })

  it('通知端丟例外 → 一樣拆章，不會讓提醒憑空消失', async () => {
    notifyOverdueHandoffBatch.mockRejectedValueOnce(new Error('LINE 掛了'))
    const { db, stampedIds } = makeDb([
      { id: 's1', workspaceId: 'WS', userId: 'U1', requestedMinutesAgo: 45 },
      { id: 's2', workspaceId: 'WS', userId: 'U2', requestedMinutesAgo: 50 },
    ])
    const tally = await remindOverdueHandoffs(db)

    expect(stampedIds()).toEqual([])
    expect(tally).toMatchObject({ reminded: 0, messages: 0 })
  })

  it('SLA 關閉（slaRemindMinutes=0）→ 不發也不蓋章', async () => {
    getAiSettings.mockResolvedValue(settings({
      handoffNotify: { enabled: true, lineUserIds: ['Sa'], mode: 'always', slaRemindMinutes: 0, digestHour: 9 },
    }))
    const { db, stampedIds } = makeDb([
      { id: 's1', workspaceId: 'WS', userId: 'U1', requestedMinutesAgo: 45 },
      { id: 's2', workspaceId: 'WS', userId: 'U2', requestedMinutesAgo: 50 },
    ])
    await remindOverdueHandoffs(db)

    expect(notifyOverdueHandoffBatch).not.toHaveBeenCalled()
    expect(notifyHandoffToStaff).not.toHaveBeenCalled()
    expect(stampedIds()).toEqual([])
  })

  // ── 重複通知的回歸測試（2026-08-07 現場：本機 dev 的排程與 Cloud Scheduler 同時跑）──

  it('另一個執行者已搶先蓋章 → 這一輪完全不發（客服不會收到兩則一樣的）', async () => {
    const { db, stampedIds } = makeDb([
      // 掃描快照看不到章、交易內讀到有章：正是兩個排程同時跑的那一瞬間
      { id: 's1', workspaceId: 'WS', userId: 'U1', requestedMinutesAgo: 45, stampedByOtherExecutor: true },
      { id: 's2', workspaceId: 'WS', userId: 'U2', requestedMinutesAgo: 50, stampedByOtherExecutor: true },
    ])
    const tally = await remindOverdueHandoffs(db)

    expect(notifyOverdueHandoffBatch).not.toHaveBeenCalled()
    expect(notifyHandoffToStaff).not.toHaveBeenCalled()
    expect(stampedIds()).toEqual(['s1', 's2']) // 章是對手蓋的，不是我們
    expect(tally).toMatchObject({ reminded: 0, messages: 0, skipped: 2 })
  })

  it('只有部分場次被搶走 → 剩下的照發，被搶走的不重複發', async () => {
    const { db } = makeDb([
      { id: 'taken', workspaceId: 'WS', userId: 'U1', requestedMinutesAgo: 45, stampedByOtherExecutor: true },
      { id: 'mine1', workspaceId: 'WS', userId: 'U2', requestedMinutesAgo: 50 },
      { id: 'mine2', workspaceId: 'WS', userId: 'U3', requestedMinutesAgo: 60 },
    ])
    const tally = await remindOverdueHandoffs(db)

    const call = notifyOverdueHandoffBatch.mock.calls[0]![0] as any
    expect(call.items.map((i: any) => i.customerLineUserId).sort()).toEqual(['U2', 'U3'])
    expect(tally).toMatchObject({ reminded: 2, messages: 1, skipped: 1 })
  })

  // ── `C-381`：真人處理中客人又來、被放回待真人的場 ──────────────────────────
  // 這種場真人早就回過話（有 humanFirstRepliedAt），原本的規則一看到就跳過＝永遠不會再提醒。

  it('客人回來被放回待真人、超過 SLA 沒人回 → 提醒一次，原因講得出是「客人又來了」', async () => {
    const { db, stampedIds } = makeDb(
      [{
        id: 'ret', workspaceId: 'WS', userId: 'U1',
        requestedMinutesAgo: 5 * 24 * 60, // 五天前轉的真人
        humanFirstRepliedAt: { __ts: 1 },
        humanLastRepliedMinutesAgo: 3 * 24 * 60,
        returnedMinutesAgo: 45,
      }],
      { WS_U1: '小美' },
    )
    const tally = await remindOverdueHandoffs(db)

    expect(notifyHandoffToStaff).toHaveBeenCalledTimes(1)
    expect(notifyHandoffToStaff.mock.calls[0]![0]).toMatchObject({
      customerName: '小美', reason: 'customer_returned', slaReminderMinutes: 30,
    })
    expect(stampedIds()).toEqual(['ret'])
    expect(tally).toMatchObject({ reminded: 1, messages: 1 })

    // 同一輪再跑一次：章已經蓋了，不會再發第二次
    notifyHandoffToStaff.mockClear()
    await remindOverdueHandoffs(db)
    expect(notifyHandoffToStaff).not.toHaveBeenCalled()
  })

  it('等待時間從客人回來那一刻算，不是五天前轉真人那一刻（合併清單的「等了多久」）', async () => {
    const { db } = makeDb([
      {
        id: 'ret', workspaceId: 'WS', userId: 'U1',
        requestedMinutesAgo: 5 * 24 * 60,
        humanFirstRepliedAt: { __ts: 1 },
        humanLastRepliedMinutesAgo: 3 * 24 * 60,
        returnedMinutesAgo: 45,
      },
      { id: 'new', workspaceId: 'WS', userId: 'U2', requestedMinutesAgo: 40 },
    ])
    await remindOverdueHandoffs(db)

    const call = notifyOverdueHandoffBatch.mock.calls[0]![0] as any
    const ret = call.items.find((i: any) => i.customerLineUserId === 'U1')
    expect(ret.waitedMs).toBe(45 * 60_000)
    expect(ret.reason).toBe('customer_returned')
  })

  it('客服剛按結束、客人接著講才回到待真人的（`C-382`）→ 一樣提醒，原因講「剛結束不久」不是「接手後還沒結束」', async () => {
    const { db, stampedIds } = makeDb([{
      id: 'tail', workspaceId: 'WS', userId: 'U1',
      requestedMinutesAgo: 0,
      returnedMinutesAgo: 40, // 尾巴那一場：沒有轉真人時間、沒有首接，只有客人回來的時間
      returnedAfterRelease: 'close',
    }])
    await remindOverdueHandoffs(db)

    expect(notifyHandoffToStaff.mock.calls[0]![0]).toMatchObject({ reason: 'customer_returned_after_release' })
    expect(stampedIds()).toEqual(['tail'])
  })

  it('客人回來還沒到 SLA → 先不催、不蓋章', async () => {
    const { db, stampedIds } = makeDb([{
      id: 'ret', workspaceId: 'WS', userId: 'U1',
      requestedMinutesAgo: 5 * 24 * 60,
      humanFirstRepliedAt: { __ts: 1 },
      humanLastRepliedMinutesAgo: 3 * 24 * 60,
      returnedMinutesAgo: 10,
    }])
    await remindOverdueHandoffs(db)

    expect(notifyHandoffToStaff).not.toHaveBeenCalled()
    expect(notifyOverdueHandoffBatch).not.toHaveBeenCalled()
    expect(stampedIds()).toEqual([])
  })

  it('客人回來之後客服已經回了（回來的時間早於真人最後回覆）→ 不催', async () => {
    const { db, stampedIds } = makeDb([{
      id: 'ret', workspaceId: 'WS', userId: 'U1',
      requestedMinutesAgo: 5 * 24 * 60,
      humanFirstRepliedAt: { __ts: 1 },
      humanLastRepliedMinutesAgo: 5,
      returnedMinutesAgo: 45,
    }])
    const tally = await remindOverdueHandoffs(db)

    expect(notifyHandoffToStaff).not.toHaveBeenCalled()
    expect(stampedIds()).toEqual([])
    expect(tally).toMatchObject({ reminded: 0, skipped: 1 })
  })

  it('交易期間真人剛接手 → 不再催（快照還是 pending）', async () => {
    const { db, stampedIds } = makeDb([
      { id: 's1', workspaceId: 'WS', userId: 'U1', requestedMinutesAgo: 45 },
    ])
    // 快照沒有 humanFirstRepliedAt，交易讀到的即時資料有 → 認領要失敗
    const snap = await db.collection('conversationSessions').where().limit(1).get()
    snap.docs[0].ref.__live.humanFirstRepliedAt = { __ts: 'just-now' }

    const tally = await remindOverdueHandoffs(db)
    expect(notifyHandoffToStaff).not.toHaveBeenCalled()
    expect(stampedIds()).toEqual([])
    expect(tally).toMatchObject({ reminded: 0, messages: 0, skipped: 1 })
  })
})
