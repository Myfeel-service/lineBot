/**
 * 結束會話（手動按鈕與排程收殮共用同一支）。
 *
 * 守住三件事：
 *  - 主鍵用**這場會話自己的** workspaceId 組（先前一律用預設工作區，非預設工作區的
 *    `currentSessionId: null` 會寫進一份不存在的 `default_U…` 文件）
 *  - 只有「這場確實是對話目前指著的那一場」才清指標，否則會把進行中那場的指標一起抹掉，
 *    客人講到一半的對話被切成兩段
 *  - 系統自動收尾要留得下標記與事件原因，時間軸才講得出不是客服按的
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__del__', increment: (n: number) => `__inc:${n}__` },
  Timestamp: { fromMillis: (ms: number) => ({ toMillis: () => ms }) },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('uuid', () => ({ v4: () => 'new-session-id' }))
vi.mock('./ai-settings', () => ({ getAiSettings: vi.fn() }))

import { closeConversationSession } from './conversation-session'
import { getDb } from './firebase'

const WS = 'ws1'
const LINE_UID = 'U0000000000000000000000000000001'
const SESSION_ID = 'sess-1'

function makeDb(currentSessionId: string | null) {
  const state = {
    sessions: {
      [SESSION_ID]: {
        workspaceId: WS,
        userId: LINE_UID,
        status: 'human_handling',
        lastActivityAt: { toMillis: () => Date.now() },
      } as Record<string, any>,
    } as Record<string, Record<string, any>>,
    convs: {} as Record<string, Record<string, any>>,
    events: [] as Record<string, any>[],
  }
  state.convs[`${WS}_${LINE_UID}`] = { currentSessionId }

  const docFor = (col: string, id: string) => ({
    get: vi.fn(async () => {
      const data = col === 'conversationSessions' ? state.sessions[id] : state.convs[id]
      return { exists: !!data, data: () => data }
    }),
    set: vi.fn(async (patch: Record<string, any>) => {
      if (col === 'conversations') state.convs[id] = { ...state.convs[id], ...patch }
      if (col === 'conversationEvents') state.events.push(patch)
    }),
    update: vi.fn(async (patch: Record<string, any>) => {
      if (col === 'conversationSessions') Object.assign(state.sessions[id]!, patch)
    }),
  })

  let autoId = 0
  const db = {
    collection: (col: string) => ({ doc: (id?: string) => docFor(col, id ?? `auto-${++autoId}`) }),
  }
  return { db, state }
}

describe('結束會話', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('非預設工作區也要清到正確那份對話文件（不是 default_U…）', async () => {
    const { db, state } = makeDb(SESSION_ID)
    vi.mocked(getDb).mockReturnValue(db as any)

    await closeConversationSession(SESSION_ID, LINE_UID)

    expect(state.convs[`${WS}_${LINE_UID}`]!.currentSessionId).toBeNull()
    expect(state.convs[`default_${LINE_UID}`]).toBeUndefined()
    expect(state.sessions[SESSION_ID]!.status).toBe('closed')
  })

  it('關掉的不是目前那場時，不可以把進行中那場的指標抹掉', async () => {
    const { db, state } = makeDb('another-live-session')
    vi.mocked(getDb).mockReturnValue(db as any)

    await closeConversationSession(SESSION_ID, LINE_UID)

    expect(state.sessions[SESSION_ID]!.status).toBe('closed')
    expect(state.convs[`${WS}_${LINE_UID}`]!.currentSessionId).toBe('another-live-session')
  })

  it('系統自動收尾要留下可回查的標記，事件也要帶原因', async () => {
    const { db, state } = makeDb(SESSION_ID)
    vi.mocked(getDb).mockReturnValue(db as any)

    await closeConversationSession(SESSION_ID, LINE_UID, { reason: 'idle_auto' })

    expect(state.sessions[SESSION_ID]!.staleClosedReason).toBe('idle_auto')
    expect(state.events.at(-1)).toMatchObject({
      eventType: 'conversation_closed',
      reason: 'idle_auto',
      workspaceId: WS,
    })
  })

  it('客服手動結束不帶原因（時間軸照舊寫「會話已結束」）', async () => {
    const { db, state } = makeDb(SESSION_ID)
    vi.mocked(getDb).mockReturnValue(db as any)

    await closeConversationSession(SESSION_ID, LINE_UID)

    expect(state.sessions[SESSION_ID]!.staleClosedReason).toBeUndefined()
    expect(state.events.at(-1)!.reason).toBeUndefined()
  })

  it('已經結束的會話重複呼叫不做事（冪等）', async () => {
    const { db, state } = makeDb(SESSION_ID)
    vi.mocked(getDb).mockReturnValue(db as any)

    await closeConversationSession(SESSION_ID, LINE_UID)
    await closeConversationSession(SESSION_ID, LINE_UID)

    expect(state.events).toHaveLength(1)
  })
})
