import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__del__' },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('uuid', () => ({ v4: () => 'new-session-id' }))

import { enterModule } from './conversation-session'
import { getDb } from './firebase'

const WS = 'ws1'
const LINE_UID = 'U0000000000000000000000000000001'
const SESSION_ID = 'sess-1'

/**
 * 假 Firestore：回傳指定的 session 內容，並收集交易裡 update() 的 patch。
 * enterModule 現在是讀寫同交易，所以要撐起 runTransaction / tx.get / tx.update。
 */
function makeDb(session: Record<string, any> | null, opts: { currentSessionId?: string } = {}) {
  const patches: Record<string, any>[] = []

  const docFor = (col: string) => ({
    __col: col,
    get: vi.fn(async () => snapFor(col)),
    set: vi.fn(async () => {}),
    update: vi.fn(async (patch: Record<string, any>) => {
      if (col === 'conversationSessions') patches.push(patch)
    }),
  })

  const snapFor = (col: string) => {
    if (col === 'conversationSessions') {
      return { exists: session !== null, data: () => session ?? undefined }
    }
    if (col === 'conversations') {
      return { exists: true, data: () => ({ currentSessionId: opts.currentSessionId }) }
    }
    return { exists: true, data: () => ({}) }
  }

  const db = {
    collection: (col: string) => ({ doc: (_id?: string) => docFor(col) }),
    runTransaction: vi.fn(async (fn: (tx: any) => Promise<any>) => fn({
      get: async (ref: any) => snapFor(ref.__col),
      update: (ref: any, patch: Record<string, any>) => {
        if (ref.__col === 'conversationSessions') patches.push(patch)
      },
    })),
  }
  return { db, patches }
}

function openUnhandledSession(extra: Record<string, any> = {}) {
  return {
    workspaceId: WS,
    userId: LINE_UID,
    status: 'open',
    initialHandler: 'unhandled',
    currentHandler: 'unhandled',
    initialModuleType: null,
    hasHandoff: false,
    ...extra,
  }
}

describe('enterModule:統計(initialHandler)與佇列(status)是兩件事', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('系統通知：移出待處理佇列,但不記首接(統計不放水)', async () => {
    const { db, patches } = makeDb(openUnhandledSession())
    vi.mocked(getDb).mockReturnValue(db as any)

    await enterModule(SESSION_ID, LINE_UID, 'system_notice', undefined, WS)

    const patch = patches[0]!
    // 佇列：離開 open → 客服不會再看到一筆其實已經回過的待處理
    expect(patch.status).toBe('bot_handling')
    // 統計：initialHandler / currentHandler 都不能被寫進去
    expect(patch).not.toHaveProperty('initialHandler')
    expect(patch).not.toHaveProperty('currentHandler')
    expect(patch).not.toHaveProperty('initialModuleType')
  })

  it('機器人流程：既移出佇列,也記機器人首接', async () => {
    const { db, patches } = makeDb(openUnhandledSession())
    vi.mocked(getDb).mockReturnValue(db as any)

    await enterModule(SESSION_ID, LINE_UID, 'bot_flow', 'mod-1', WS)

    const patch = patches[0]!
    expect(patch.status).toBe('bot_handling')
    expect(patch.initialHandler).toBe('bot')
  })

  it('AI：記 AI 首接', async () => {
    const { db, patches } = makeDb(openUnhandledSession())
    vi.mocked(getDb).mockReturnValue(db as any)

    await enterModule(SESSION_ID, LINE_UID, 'ai', undefined, WS)

    expect(patches[0]!.status).toBe('bot_handling')
    expect(patches[0]!.initialHandler).toBe('ai')
  })

  it('系統通知不會把已轉真人的會話搶回機器人', async () => {
    const { db, patches } = makeDb(openUnhandledSession({ status: 'pending_human' }))
    vi.mocked(getDb).mockReturnValue(db as any)

    await enterModule(SESSION_ID, LINE_UID, 'system_notice', undefined, WS)

    expect(patches[0]).not.toHaveProperty('status')
  })

  it('系統通知不會蓋掉先前已記的機器人首接', async () => {
    const { db, patches } = makeDb(openUnhandledSession({
      status: 'bot_handling',
      initialHandler: 'bot',
      initialModuleType: 'bot_flow',
    }))
    vi.mocked(getDb).mockReturnValue(db as any)

    await enterModule(SESSION_ID, LINE_UID, 'system_notice', undefined, WS)

    expect(patches[0]).not.toHaveProperty('initialHandler')
    expect(patches[0]).not.toHaveProperty('status')
  })

  it('真人客服：轉「待真人」並記真人首接', async () => {
    const { db, patches } = makeDb(openUnhandledSession())
    vi.mocked(getDb).mockReturnValue(db as any)

    await enterModule(SESSION_ID, LINE_UID, 'live_agent', 'sys_live_agent', WS)

    expect(patches[0]!.status).toBe('pending_human')
    expect(patches[0]!.initialHandler).toBe('human')
    expect(patches[0]!.hasHandoff).toBe(true)
  })
})

/**
 * 對話頁「我接手（暫停自動回覆）」走的就是 enterModule(live_agent)
 * （server/api/conversations/sessions/[sessionId]/takeover.post.ts）。
 * 這組測試盯的是「接手 ≠ 回覆過客人」：首接時間不能被按鈕點擊時間灌水。
 */
describe('enterModule(live_agent)：客服主動接手', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('機器人接過了才接手 → 記轉真人,不覆蓋機器人首接', async () => {
    const { db, patches } = makeDb(openUnhandledSession({
      status: 'bot_handling',
      initialHandler: 'bot',
      initialModuleType: 'bot_flow',
    }))
    vi.mocked(getDb).mockReturnValue(db as any)

    await enterModule(SESSION_ID, LINE_UID, 'live_agent', undefined, WS)

    const patch = patches[0]!
    expect(patch.status).toBe('pending_human')
    expect(patch.currentHandler).toBe('human')
    expect(patch.hasHandoff).toBe(true)
    // 首接只有一次,已經是機器人首接就不能被接手動作改掉
    expect(patch).not.toHaveProperty('initialHandler')
  })

  it('接手不等於回覆過客人 → 不寫 humanFirstRepliedAt(否則回應速度會被灌水)', async () => {
    const { db, patches } = makeDb(openUnhandledSession({ status: 'bot_handling', initialHandler: 'ai' }))
    vi.mocked(getDb).mockReturnValue(db as any)

    await enterModule(SESSION_ID, LINE_UID, 'live_agent', undefined, WS)

    expect(patches[0]).not.toHaveProperty('humanFirstRepliedAt')
    expect(patches[0]).not.toHaveProperty('humanLastRepliedAt')
  })

  it('已在真人處理中再接手 → 不把狀態退回待真人', async () => {
    const { db, patches } = makeDb(openUnhandledSession({
      status: 'human_handling',
      initialHandler: 'human',
      initialModuleType: 'live_agent',
      hasHandoff: true,
    }))
    vi.mocked(getDb).mockReturnValue(db as any)

    await enterModule(SESSION_ID, LINE_UID, 'live_agent', undefined, WS)

    expect(patches[0]).not.toHaveProperty('status')
    expect(patches[0]).not.toHaveProperty('hasHandoff')
  })
})

describe('enterModule:記帳不能因為拿不到 sessionId 就整段消失', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('sessionId 為 null → 從 conversations 補撈 currentSessionId 後照樣記帳', async () => {
    // 情境：建立會話那一步失敗回傳 null，但訊息已經送給客人了
    const { db, patches } = makeDb(openUnhandledSession(), { currentSessionId: 'recovered-1' })
    vi.mocked(getDb).mockReturnValue(db as any)

    await enterModule(null, LINE_UID, 'bot_flow', undefined, WS)

    expect(patches).toHaveLength(1)
    expect(patches[0]!.initialHandler).toBe('bot')
  })

  it('sessionId 為 null 且真的撈不到 → 安靜跳過,不要拋錯炸掉回覆流程', async () => {
    const { db, patches } = makeDb(openUnhandledSession(), { currentSessionId: undefined })
    vi.mocked(getDb).mockReturnValue(db as any)

    await expect(enterModule(null, LINE_UID, 'bot_flow', undefined, WS)).resolves.toBeUndefined()
    expect(patches).toHaveLength(0)
  })

  it('session 文件不存在 → 不寫入也不拋錯', async () => {
    const { db, patches } = makeDb(null)
    vi.mocked(getDb).mockReturnValue(db as any)

    await expect(enterModule(SESSION_ID, LINE_UID, 'bot_flow', undefined, WS)).resolves.toBeUndefined()
    expect(patches).toHaveLength(0)
  })

  it('讀與寫在同一個交易裡(同秒兩則訊息才不會互相蓋掉)', async () => {
    const { db } = makeDb(openUnhandledSession())
    vi.mocked(getDb).mockReturnValue(db as any)

    await enterModule(SESSION_ID, LINE_UID, 'bot_flow', undefined, WS)

    expect(db.runTransaction).toHaveBeenCalledTimes(1)
  })
})
