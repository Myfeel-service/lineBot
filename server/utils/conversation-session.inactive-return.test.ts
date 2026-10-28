import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__del__', increment: (n: number) => `__inc:${n}__` },
  Timestamp: { fromMillis: (ms: number) => ({ toMillis: () => ms }) },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('uuid', () => ({ v4: () => 'new-session-id' }))
vi.mock('./inactive-tag', () => ({ clearInactiveTagOnReturn: vi.fn(async () => false) }))

import { ensureConversationSession, _invalidateUserSessionCache } from './conversation-session'
import { clearInactiveTagOnReturn } from './inactive-tag'
import { getDb } from './firebase'

/**
 * `D-154`：「沒互動」標籤改看「最後一次有動作」（傳訊息或按選單／按鈕＝lastPeerActivityAt）。
 * 客人回來時的摘標判斷也要用同一個欄位——不然天天按選單、兩個月沒打字的客人
 * 一按模組按鈕就去查一次標籤（他根本沒被貼），貼標與摘標兩邊口徑不一。
 */
const WS = 'ws1'
const LINE_UID = 'U00000000000000000000000000d154a'
const CONV_ID = `${WS}_${LINE_UID}`
const DAY = 86_400_000

/** 假 Firestore：沒有進行中的會話 → 一定走交易慢路徑開新的一場 */
function makeDb(conv: Record<string, any>) {
  const docFor = (col: string, id: string) => ({
    __col: col,
    __id: id,
    get: vi.fn(async () => ({ exists: col === 'conversations', data: () => (col === 'conversations' ? conv : undefined) })),
    set: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
  })
  let autoId = 0
  return {
    collection: (col: string) => ({
      doc: (id?: string) => docFor(col, id ?? `auto-${++autoId}`),
      where: function () { return this },
      get: async () => ({ docs: [], size: 0 }),
    }),
    runTransaction: vi.fn(async (fn: (tx: any) => Promise<any>) => fn({
      get: async (ref: any) => ({ exists: ref.__col === 'conversations', data: () => (ref.__col === 'conversations' ? conv : undefined) }),
      set: () => {},
      update: () => {},
    })),
    batch: () => ({ update: () => {}, set: () => {}, commit: async () => {} }),
  }
}

describe('客人回來時的「沒互動」摘標看 lastPeerActivityAt（`D-154`）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-28T03:00:00Z'))
    _invalidateUserSessionCache(LINE_UID)
  })
  afterEach(() => { vi.useRealTimers() })

  it('拿交易裡讀到的舊 lastPeerActivityAt 去判斷，⛔ 不是只算傳訊息的 lastInboundMessageAt', async () => {
    const now = Date.now()
    const db = makeDb({
      workspaceId: WS,
      lastInboundMessageAt: { toMillis: () => now - 70 * DAY },
      lastPeerActivityAt: { toMillis: () => now - 2 * DAY },
    })
    vi.mocked(getDb).mockReturnValue(db as any)
    await ensureConversationSession(LINE_UID, WS, { inboundAtMs: now })
    expect(clearInactiveTagOnReturn).toHaveBeenCalledTimes(1)
    expect(vi.mocked(clearInactiveTagOnReturn).mock.calls[0]!.slice(1, 4)).toEqual([WS, CONV_ID, now - 2 * DAY])
  })

  it('加好友觸發的（客人還沒動作）不摘', async () => {
    const now = Date.now()
    const db = makeDb({ workspaceId: WS, lastPeerActivityAt: { toMillis: () => now - 90 * DAY } })
    vi.mocked(getDb).mockReturnValue(db as any)
    await ensureConversationSession(LINE_UID, WS, { origin: 'follow' })
    expect(clearInactiveTagOnReturn).not.toHaveBeenCalled()
  })
})
