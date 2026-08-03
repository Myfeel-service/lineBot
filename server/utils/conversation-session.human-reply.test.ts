import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__del__' },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('uuid', () => ({ v4: () => 'new-session-id' }))

import { onHumanOutgoingMessage } from './conversation-session'
import { getDb } from './firebase'

const WS = 'ws1'
const LINE_UID = 'U0000000000000000000000000000001'

/**
 * 假 Firestore：conversations 指向一場 session，session 內容由參數決定。
 * onHumanOutgoingMessage 的判斷與寫入現在同交易，所以要撐起 runTransaction。
 */
function makeDb(session: Record<string, any> | null, currentSessionId: string | undefined = 'sess-1') {
  const patches: Record<string, any>[] = []
  const events: string[] = []

  const snapFor = (col: string) => {
    if (col === 'conversations') return { exists: true, data: () => ({ currentSessionId }) }
    if (col === 'conversationSessions') return { exists: session !== null, data: () => session ?? undefined }
    return { exists: true, data: () => ({}) }
  }

  const db = {
    collection: (col: string) => ({
      doc: (_id?: string) => ({
        __col: col,
        get: vi.fn(async () => snapFor(col)),
        set: vi.fn(async (data: any) => { if (col === 'conversationEvents') events.push(data.eventType) }),
        update: vi.fn(async () => {}),
      }),
    }),
    runTransaction: vi.fn(async (fn: (tx: any) => Promise<any>) => fn({
      get: async (ref: any) => snapFor(ref.__col),
      update: (ref: any, patch: Record<string, any>) => {
        if (ref.__col === 'conversationSessions') patches.push(patch)
      },
    })),
  }
  return { db, patches, events }
}

describe('onHumanOutgoingMessage:真人首接 vs 轉真人的判斷', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('之前沒人接過 → 記真人首接,不記轉真人', async () => {
    const { db, patches, events } = makeDb({
      status: 'open', initialHandler: 'unhandled', hasHandoff: false,
    })
    vi.mocked(getDb).mockReturnValue(db as any)

    await onHumanOutgoingMessage(LINE_UID, WS)

    expect(patches[0]!.initialHandler).toBe('human')
    expect(patches[0]!.status).toBe('human_handling')
    expect(patches[0]).not.toHaveProperty('hasHandoff')
    expect(events).toContain('human_first_reply')
    expect(events).not.toContain('handoff_request')
  })

  it('機器人已先接過 → 記轉真人,不改首接', async () => {
    const { db, patches, events } = makeDb({
      status: 'bot_handling', initialHandler: 'bot', hasHandoff: false,
    })
    vi.mocked(getDb).mockReturnValue(db as any)

    await onHumanOutgoingMessage(LINE_UID, WS)

    expect(patches[0]).not.toHaveProperty('initialHandler')
    expect(patches[0]!.hasHandoff).toBe(true)
    expect(events).toContain('handoff_request')
  })

  it('已在真人處理中 → 只更新真人最後回覆時間(不重複記事件)', async () => {
    const { db, patches, events } = makeDb({
      status: 'human_handling', initialHandler: 'bot', hasHandoff: true,
      humanFirstRepliedAt: '__ts__',
    })
    vi.mocked(getDb).mockReturnValue(db as any)

    await onHumanOutgoingMessage(LINE_UID, WS)

    expect(patches[0]!.humanLastRepliedAt).toBeDefined()
    expect(patches[0]).not.toHaveProperty('status')
    expect(events).toHaveLength(0)
  })

  it('已結束的會話 → 什麼都不做', async () => {
    const { db, patches } = makeDb({ status: 'closed', initialHandler: 'bot' })
    vi.mocked(getDb).mockReturnValue(db as any)

    await onHumanOutgoingMessage(LINE_UID, WS)

    expect(patches).toHaveLength(0)
  })

  it('沒有進行中的會話 → 不進交易', async () => {
    // 傳空字串而非 undefined：undefined 會觸發預設參數，反而變成有 session
    const { db } = makeDb(null, '')
    vi.mocked(getDb).mockReturnValue(db as any)

    await onHumanOutgoingMessage(LINE_UID, WS)

    expect(db.runTransaction).not.toHaveBeenCalled()
  })

  it('判斷與寫入在同一個交易裡(兩位客服同時回話才不會誤分類)', async () => {
    const { db } = makeDb({ status: 'open', initialHandler: 'unhandled', hasHandoff: false })
    vi.mocked(getDb).mockReturnValue(db as any)

    await onHumanOutgoingMessage(LINE_UID, WS)

    expect(db.runTransaction).toHaveBeenCalledTimes(1)
  })
})
