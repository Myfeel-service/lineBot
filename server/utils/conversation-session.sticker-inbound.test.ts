import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__del__', increment: (n: number) => `__inc:${n}__` },
  Timestamp: { fromMillis: (ms: number) => ({ toMillis: () => ms }) },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('uuid', () => ({ v4: () => 'new-session-id' }))

import { ensureConversationSession, _invalidateUserSessionCache } from './conversation-session'
import { isOpenQueueSession } from './conversation-queue'
import { isPreInboundSession } from '~~/shared/types/conversation-stats'
import { getDb } from './firebase'

/**
 * `D-4`（老闆 2026-10-20 拍板）：客人**只傳貼圖**的場不進待處理、不算沒人回。
 * 近 30 天 MYFEEL 10 場只傳貼圖，9 場被記成「沒人回」，最久在待處理掛 41 小時——
 * 貼圖刻意不自動回（多半是「👍」「謝謝」），以前卻跟打字一樣補記 hasInbound，於是浮上佇列。
 *
 * 這組走真的 ensureConversationSession（快路徑＋交易慢路徑），假的只有 Firestore：
 * 要釘的是「貼圖不補記 hasInbound」以及「客人之後講話就照常」兩件事都在**兩條路**上成立。
 */
const WS = 'ws1'
const LINE_UID = 'U0000000000000000000000000000d04'
const CONV_ID = `${WS}_${LINE_UID}`

/** 假 Firestore：serverTimestamp 的佔位字串換成「現在」，交易裡讀得到時間（否則會被當成 24 小時沒動靜而換場） */
function makeDb(seed: { session?: Record<string, any>; conv?: Record<string, any> } = {}) {
  const realize = (patch: Record<string, any>) => {
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(patch)) {
      if (v === '__ts__') {
        const at = Date.now()
        out[k] = { toMillis: () => at }
      }
      else out[k] = v
    }
    return out
  }
  const state = {
    sessions: {} as Record<string, Record<string, any>>,
    conv: { ...(seed.conv ?? {}) } as Record<string, any>,
  }
  if (seed.session) {
    state.sessions['sess-old'] = { workspaceId: WS, userId: LINE_UID, lastActivityAt: { toMillis: () => Date.now() }, ...seed.session }
    state.conv.currentSessionId = 'sess-old'
  }

  const snap = (col: string, id: string) => {
    if (col === 'conversationSessions') {
      const doc = state.sessions[id]
      return { exists: !!doc, data: () => doc }
    }
    if (col === 'conversations') return { exists: true, data: () => state.conv }
    return { exists: false, data: () => undefined }
  }
  const docFor = (col: string, id: string) => ({
    __col: col,
    __id: id,
    get: vi.fn(async () => snap(col, id)),
    set: vi.fn(async (patch: Record<string, any>) => {
      if (col === 'conversations') Object.assign(state.conv, realize(patch))
    }),
    update: vi.fn(async (patch: Record<string, any>) => {
      if (col === 'conversationSessions' && state.sessions[id]) Object.assign(state.sessions[id]!, realize(patch))
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
        if (ref.__col === 'conversationSessions') state.sessions[ref.__id] = realize(patch)
        if (ref.__col === 'conversations') Object.assign(state.conv, realize(patch))
      },
      update: (ref: any, patch: Record<string, any>) => {
        if (ref.__col === 'conversationSessions') Object.assign(state.sessions[ref.__id]!, realize(patch))
      },
    })),
    batch: () => ({ update: () => {}, set: () => {}, commit: async () => {} }),
  }
  return { db, state }
}

const sticker = () => ensureConversationSession(LINE_UID, WS, { inboundAtMs: Date.now(), sticker: true })
const text = () => ensureConversationSession(LINE_UID, WS, { inboundAtMs: Date.now() })

describe('只傳貼圖的場：不進待處理、不算沒人回（`D-4`）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-20T03:00:00Z'))
    _invalidateUserSessionCache(LINE_UID)
  })
  afterEach(() => { vi.useRealTimers() })

  it('貼圖開的新場：記成 sticker、沒有開口過 → 不在待處理、不進統計', async () => {
    const { db, state } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    const sid = await sticker()

    const doc = state.sessions[sid]!
    expect(doc.origin).toBe('sticker')
    expect(doc.hasInbound).toBe(false)
    expect(doc.status).toBe('open')
    expect(isOpenQueueSession(doc)).toBe(false)
    expect(isPreInboundSession(doc)).toBe(true)
  })

  it('貼圖之後馬上打字（快路徑）→ 同一場、從這一刻起照常進待處理', async () => {
    const { db, state } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    const first = await sticker()
    vi.advanceTimersByTime(1000)
    const second = await text()

    expect(second).toBe(first)
    expect(state.sessions[first]!.hasInbound).toBe(true)
    expect(isOpenQueueSession(state.sessions[first])).toBe(true)
  })

  it('貼圖之後隔一陣子才打字（快取過期、走交易）→ 一樣照常', async () => {
    const { db, state } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    const first = await sticker()
    vi.advanceTimersByTime(40_000) // 超過 sessionId 快取的 30 秒
    const second = await text()

    expect(second).toBe(first)
    expect(state.sessions[first]!.hasInbound).toBe(true)
  })

  it('連傳好幾張貼圖（快路徑與交易兩條都走過）→ 還是不算開口', async () => {
    const { db, state } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    const sid = await sticker()
    vi.advanceTimersByTime(1000)
    await sticker() // 快路徑
    vi.advanceTimersByTime(40_000)
    await sticker() // 交易

    expect(state.sessions[sid]!.hasInbound).toBe(false)
    expect(isOpenQueueSession(state.sessions[sid])).toBe(false)
  })

  it('⛔ 快取不可以被貼圖記成「開口過」：貼圖→快取過期前不再讀，下一則打字仍要補記', async () => {
    // 修之前快取寫的是 `hasInbound: !opts.origin`（貼圖＝true），之後的打字在快路徑上就不補寫了。
    const { db, state } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    const sid = await sticker()
    vi.advanceTimersByTime(500)
    await sticker()
    vi.advanceTimersByTime(500)
    await text()

    expect(state.sessions[sid]!.hasInbound).toBe(true)
  })

  it('客人先講過話、後來才傳貼圖 → 照樣留在待處理（貼圖不能把講過的話抹掉）', async () => {
    const { db, state } = makeDb({ session: { status: 'open', origin: 'message', hasInbound: true } })
    vi.mocked(getDb).mockReturnValue(db as any)

    const sid = await sticker()

    expect(sid).toBe('sess-old')
    expect(state.sessions['sess-old']!.hasInbound).toBe(true)
    expect(isOpenQueueSession(state.sessions['sess-old'])).toBe(true)
  })

  it('加好友還沒開口的場，客人傳了貼圖 → 仍然不算開口', async () => {
    const { db, state } = makeDb({ session: { status: 'bot_handling', origin: 'follow', hasInbound: false } })
    vi.mocked(getDb).mockReturnValue(db as any)

    await sticker()

    expect(state.sessions['sess-old']!.hasInbound).toBe(false)
    expect(isPreInboundSession(state.sessions['sess-old'])).toBe(true)
  })

  it('⛔ 真人還沒放手的客人傳貼圖：新的一場照樣算真人的（貼圖也不能讓 AI 接走後面的話）', async () => {
    const { db, state } = makeDb({ conv: { lastHumanActionAt: { toMillis: () => Date.now() - 3600_000 } } })
    vi.mocked(getDb).mockReturnValue(db as any)

    const sid = await sticker()

    expect(state.sessions[sid]!.status).toBe('human_handling')
    expect(state.sessions[sid]!.hasInbound).toBe(false)
  })
})
