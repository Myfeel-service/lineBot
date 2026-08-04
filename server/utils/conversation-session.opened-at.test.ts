import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__del__', increment: (n: number) => `__inc:${n}__` },
  Timestamp: { fromMillis: (ms: number) => ({ __ms: ms }) },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('uuid', () => ({ v4: () => 'new-session-id' }))

import { ensureConversationSession } from './conversation-session'
import { getDb } from './firebase'

const WS = 'ws1'

/**
 * 假 Firestore：只要撐起「沒有既有會話 → 開新的」這條路（含交易內的 set 收集）。
 * 每個測試用不同的 lineUserId，避開 ensureConversationSession 的 in-memory 快取。
 */
function makeDb() {
  const sets: Array<{ col: string; data: any }> = []

  const chainableQuery: any = {
    where: vi.fn(() => chainableQuery),
    get: vi.fn(async () => ({ docs: [] })),
  }

  const docFor = (col: string) => ({
    __col: col,
    get: vi.fn(async () => ({ exists: false, data: () => undefined })),
    set: vi.fn(async (data: any) => { sets.push({ col, data }) }),
    update: vi.fn(async () => {}),
  })

  const db = {
    collection: vi.fn((col: string) => ({
      doc: vi.fn(() => docFor(col)),
      where: chainableQuery.where,
    })),
    runTransaction: vi.fn(async (cb: any) => cb({
      get: vi.fn(async () => ({ exists: false, data: () => undefined })),
      set: vi.fn((ref: any, data: any) => { sets.push({ col: ref.__col, data }) }),
      update: vi.fn(),
    })),
  }
  return { db, sets }
}

function newSessionPatch(sets: Array<{ col: string; data: any }>) {
  return sets.find(s => s.col === 'conversationSessions')?.data
}

describe('新會話的 openedAt 用「客人來訊的時間」', () => {
  beforeEach(() => { vi.clearAllMocks() })

  /**
   * 這是「時間軸看不到客人第一句」的根因修正：
   * 客人訊息存的是 LINE 的時間，比我們處理到的時間早幾百毫秒；
   * openedAt 用伺服器時間的話，`timestamp >= openedAt` 的窗口會把那句話切掉。
   */
  it('帶 inboundAtMs → openedAt 就是那句訊息的時間', async () => {
    const { db, sets } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)
    const inboundAtMs = Date.now() - 800

    await ensureConversationSession('U0000000000000000000000000000101', WS, { inboundAtMs })

    expect(newSessionPatch(sets)?.openedAt).toEqual({ __ms: inboundAtMs })
  })

  it('沒帶 inboundAtMs（例如加好友）→ 退回伺服器時間', async () => {
    const { db, sets } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    await ensureConversationSession('U0000000000000000000000000000102', WS, { origin: 'follow' })

    expect(newSessionPatch(sets)?.openedAt).toBe('__ts__')
  })

  it('時間戳離現在太遠（redelivery／髒 payload）→ 不採用，退回伺服器時間', async () => {
    const { db, sets } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    // 6 分鐘前：採用的話這場會話的窗口會往前吃到上一場的訊息
    await ensureConversationSession('U0000000000000000000000000000103', WS, {
      inboundAtMs: Date.now() - 6 * 60_000,
    })

    expect(newSessionPatch(sets)?.openedAt).toBe('__ts__')
  })

  it('24h 到期換場：舊會話的結束時間收在新會話開始前一毫秒（兩場窗口不重疊）', async () => {
    const inboundAtMs = Date.now() - 500
    const patches: Record<string, any>[] = []
    const chainableQuery: any = { where: vi.fn(() => chainableQuery), get: vi.fn(async () => ({ docs: [] })) }
    const db: any = {
      collection: vi.fn((col: string) => ({
        doc: vi.fn(() => ({
          __col: col,
          get: vi.fn(async () => ({ exists: false, data: () => undefined })),
          set: vi.fn(async () => {}),
          update: vi.fn(async () => {}),
        })),
        where: chainableQuery.where,
      })),
      runTransaction: vi.fn(async (cb: any) => cb({
        // 既有會話：最後活動在 25 小時前 → 觸發換場
        get: vi.fn(async (ref: any) => ref.__col === 'conversations'
          ? { exists: true, data: () => ({ currentSessionId: 'old-session' }) }
          : {
              exists: true,
              data: () => ({ status: 'open', lastActivityAt: { toMillis: () => Date.now() - 25 * 3600_000 } }),
            }),
        set: vi.fn(),
        update: vi.fn((_ref: any, patch: Record<string, any>) => { patches.push(patch) }),
      })),
    }
    vi.mocked(getDb).mockReturnValue(db as any)

    await ensureConversationSession('U0000000000000000000000000000105', WS, { inboundAtMs })

    const closePatch = patches.find(p => p.status === 'closed')
    expect(closePatch?.closedAt).toEqual({ __ms: inboundAtMs - 1 })
  })

  it('時間戳在未來 → 不採用（否則窗口起點比訊息還晚，一樣看不到）', async () => {
    const { db, sets } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    await ensureConversationSession('U0000000000000000000000000000104', WS, {
      inboundAtMs: Date.now() + 30_000,
    })

    expect(newSessionPatch(sets)?.openedAt).toBe('__ts__')
  })
})
