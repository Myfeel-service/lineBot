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

  /** 實際落地的那一下；batch 與單筆寫入共用，兩條路寫出來的東西才會是同一份 */
  const applyWrite = (col: string, id: string, patch: Record<string, any>) => {
    if (col === 'conversations') state.convs[id] = { ...state.convs[id], ...patch }
    if (col === 'conversationEvents') state.events.push(patch)
    if (col === 'conversationSessions') Object.assign(state.sessions[id]!, patch)
  }

  const docFor = (col: string, id: string) => ({
    __col: col,
    __id: id,
    get: vi.fn(async () => {
      const data = col === 'conversationSessions' ? state.sessions[id] : state.convs[id]
      return { exists: !!data, data: () => data }
    }),
    set: vi.fn(async (patch: Record<string, any>) => applyWrite(col, id, patch)),
    update: vi.fn(async (patch: Record<string, any>) => applyWrite(col, id, patch)),
  })

  let autoId = 0
  const db = {
    collection: (col: string) => ({ doc: (id?: string) => docFor(col, id ?? `auto-${++autoId}`) }),
    /**
     * ⛔ 這個假 db 一定要有 batch()：結束會話的三份文件是同一個 batch 寫出去的，
     * 少了它，「一筆都沒寫」也會測成綠的（見記憶 feedback_verify_new_code_actually_runs）。
     */
    batch: () => {
      const queued: { ref: any, patch: Record<string, any> }[] = []
      return {
        set: (ref: any, patch: Record<string, any>) => { queued.push({ ref, patch }) },
        update: (ref: any, patch: Record<string, any>) => { queued.push({ ref, patch }) },
        commit: vi.fn(async () => {
          for (const w of queued) applyWrite(w.ref.__col, w.ref.__id, w.patch)
        }),
      }
    },
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

  /**
   * `D-64`：這兩條守的是「收殮那 2,978 場舊對話」會不會變成約三千次 LLM。
   * AI 讀對話貼標籤撈的是「已結束 ＋ 最後活動時間在游標之後」——收尾如果照常把時間
   * 蓋成現在，躺了幾個月的舊對話會整批被當成「剛剛結束」拿去跑 AI。
   */
  it('⛔ 帶 preserveLastActivityAt 時**不可以**蓋掉最後活動時間（否則舊對話會整批跑去餵 AI）', async () => {
    const { db, state } = makeDb(SESSION_ID)
    vi.mocked(getDb).mockReturnValue(db as any)
    const before = state.sessions[SESSION_ID]!.lastActivityAt

    await closeConversationSession(SESSION_ID, LINE_UID, {
      reason: 'idle_bot_auto',
      preserveLastActivityAt: true,
    })

    expect(state.sessions[SESSION_ID]!.status).toBe('closed')
    expect(state.sessions[SESSION_ID]!.closedAt).toBeDefined()
    // 原本那個物件要原封不動地還在（不是被 serverTimestamp 換掉）
    expect(state.sessions[SESSION_ID]!.lastActivityAt).toBe(before)
  })

  it('沒帶那個選項時照舊蓋成現在（客服按結束、真人那半的收尾都走這條）', async () => {
    const { db, state } = makeDb(SESSION_ID)
    vi.mocked(getDb).mockReturnValue(db as any)
    const before = state.sessions[SESSION_ID]!.lastActivityAt

    await closeConversationSession(SESSION_ID, LINE_UID)

    expect(state.sessions[SESSION_ID]!.lastActivityAt).not.toBe(before)
  })

  /**
   * 這兩條守的是「按下去要等 3 秒」那件事：同一份 session 讀兩次、三份文件分三趟寫，
   * 每一趟都是一次 Firestore 往返，而客服等的就是它們疊起來的時間。
   * 退回去不會讓任何功能壞掉（所以只有這裡咬得住），但按鈕會再變慢。
   */
  it('三份文件是同一個 batch 寫出去的（不是三趟往返）', async () => {
    const { db, state } = makeDb(SESSION_ID)
    const batches: any[] = []
    const realBatch = db.batch
    db.batch = () => { const b = realBatch(); batches.push(b); return b }
    vi.mocked(getDb).mockReturnValue(db as any)

    await closeConversationSession(SESSION_ID, LINE_UID)

    expect(batches).toHaveLength(1)
    expect(batches[0].commit).toHaveBeenCalledTimes(1)
    // 三份都要真的落地：session 狀態、對話指標、時間軸事件
    expect(state.sessions[SESSION_ID]!.status).toBe('closed')
    expect(state.convs[`${WS}_${LINE_UID}`]!.currentSessionId).toBeNull()
    expect(state.events).toHaveLength(1)
  })

  it('呼叫端把剛讀到的 session 帶進來時，不可以再讀一次那份文件', async () => {
    const { db, state } = makeDb(SESSION_ID)
    const sessionGets: any[] = []
    const realCollection = db.collection
    db.collection = (col: string) => {
      const c = realCollection(col)
      return {
        doc: (id?: string) => {
          const d = c.doc(id)
          if (col === 'conversationSessions') sessionGets.push(d.get)
          return d
        },
      }
    }
    vi.mocked(getDb).mockReturnValue(db as any)

    await closeConversationSession(SESSION_ID, LINE_UID, { session: state.sessions[SESSION_ID] })

    expect(sessionGets.every(g => g.mock.calls.length === 0)).toBe(true)
    expect(state.sessions[SESSION_ID]!.status).toBe('closed')
  })

  it('已經結束的會話重複呼叫不做事（冪等）', async () => {
    const { db, state } = makeDb(SESSION_ID)
    vi.mocked(getDb).mockReturnValue(db as any)

    await closeConversationSession(SESSION_ID, LINE_UID)
    await closeConversationSession(SESSION_ID, LINE_UID)

    expect(state.events).toHaveLength(1)
  })
})
