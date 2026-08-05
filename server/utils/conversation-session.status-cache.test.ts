import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__del__', increment: (n: number) => `__inc:${n}__` },
  Timestamp: { fromMillis: (ms: number) => ({ toMillis: () => ms }) },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('uuid', () => ({ v4: () => 'new-session-id' }))

import {
  ensureConversationSession,
  shouldSuppressInboundBotAutomationForSession,
  _invalidateUserSessionCache,
} from './conversation-session'
import { getDb } from './firebase'

const WS = 'ws1'
const LINE_UID = 'U0000000000000000000000000000001'
const SESSION_ID = 'sess-1'

/**
 * 假 Firestore：一份可從外部改動的 session 狀態（模擬「別的行程」——客服按了我接手、
 * cron 自動交還、另一台 Lambda 轉了真人），並記錄 session doc 被讀了幾次。
 */
function makeDb() {
  const state = {
    sessions: {
      [SESSION_ID]: {
        workspaceId: WS,
        userId: LINE_UID,
        status: 'bot_handling',
        lastActivityAt: { toMillis: () => Date.now() },
        hasInbound: true,
      } as Record<string, any>,
    } as Record<string, Record<string, any>>,
    conv: { currentSessionId: SESSION_ID } as Record<string, any>,
    sessionReads: 0,
  }

  const snap = (col: string, id: string) => {
    if (col === 'conversationSessions') {
      state.sessionReads++
      const doc = state.sessions[id]
      return { exists: !!doc, data: () => doc }
    }
    if (col === 'conversations') return { exists: true, data: () => state.conv }
    return { exists: true, data: () => ({}) }
  }

  const docFor = (col: string, id: string) => ({
    __col: col,
    __id: id,
    get: vi.fn(async () => snap(col, id)),
    set: vi.fn(async (patch: Record<string, any>) => {
      if (col === 'conversationSessions') state.sessions[id] = { ...state.sessions[id], ...patch }
      if (col === 'conversations') Object.assign(state.conv, patch)
    }),
    update: vi.fn(async (patch: Record<string, any>) => {
      if (col === 'conversationSessions') Object.assign(state.sessions[id]!, patch)
    }),
  })

  let autoId = 0
  const db = {
    collection: (col: string) => ({
      doc: (id?: string) => docFor(col, id ?? `auto-${++autoId}`),
      where: function () { return this },
      get: async () => ({ docs: [], size: 0 }),
    }),
    runTransaction: vi.fn(async (fn: (tx: any) => Promise<any>) => fn({
      get: async (ref: any) => snap(ref.__col, ref.__id),
      set: (ref: any, patch: Record<string, any>) => {
        if (ref.__col === 'conversationSessions') state.sessions[ref.__id] = patch
        if (ref.__col === 'conversations') Object.assign(state.conv, patch)
      },
      update: (ref: any, patch: Record<string, any>) => {
        if (ref.__col === 'conversationSessions') Object.assign(state.sessions[ref.__id]!, patch)
      },
    })),
    batch: () => ({ update: () => {}, commit: async () => {} }),
  }
  return { db, state }
}

/**
 * 這組測試守的是實測踩到的洞：客人連續講話 → fast path 每次都把快取時間戳 refresh 成
 * 現在 → 舊狀態被無限續命 → 已經轉真人了本行程還以為機器人在處理，AI 繼續插話。
 */
describe('session 狀態快取：別的行程改的狀態要看得到', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-05T01:00:00Z'))
    _invalidateUserSessionCache(LINE_UID)
  })
  afterEach(() => { vi.useRealTimers() })

  it('客人一直講話也不會讓舊狀態無限續命（轉真人後機器人要閉嘴）', async () => {
    const { db, state } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    await ensureConversationSession(LINE_UID, WS)
    expect(await shouldSuppressInboundBotAutomationForSession(SESSION_ID)).toBe(false)

    // 別的行程把這場轉成待真人（客服按「我接手」/ 另一台實例處理了轉接）
    state.sessions[SESSION_ID]!.status = 'pending_human'

    // 客人每 2 秒再講一句（舊實作會一直 refresh 快取 → 永遠讀不到新狀態）
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(2000)
      await ensureConversationSession(LINE_UID, WS)
    }

    expect(await shouldSuppressInboundBotAutomationForSession(SESSION_ID)).toBe(true)
  })

  it('狀態鮮度上限內不重複讀 Firestore（連續兩則訊息只付一次讀取）', async () => {
    const { db, state } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    await ensureConversationSession(LINE_UID, WS)
    const afterFirst = state.sessionReads

    // 1 秒後的第二則：仍在 5 秒鮮度內 → 走快取，不再讀 session doc
    vi.advanceTimersByTime(1000)
    await ensureConversationSession(LINE_UID, WS)
    await shouldSuppressInboundBotAutomationForSession(SESSION_ID)
    expect(state.sessionReads).toBe(afterFirst)

    // 超過鮮度 → 回讀一次
    vi.advanceTimersByTime(6000)
    await shouldSuppressInboundBotAutomationForSession(SESSION_ID)
    expect(state.sessionReads).toBeGreaterThan(afterFirst)
  })

  it('會話被別的行程結束後，客人再來訊要開新的一場（不再寫進已結束的會話）', async () => {
    const { db, state } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    const first = await ensureConversationSession(LINE_UID, WS)
    expect(first).toBe(SESSION_ID)

    // 客服按了「結束會話」
    state.sessions[SESSION_ID]!.status = 'closed'

    vi.advanceTimersByTime(6000)
    const next = await ensureConversationSession(LINE_UID, WS)
    expect(next).toBe('new-session-id')
  })
})
