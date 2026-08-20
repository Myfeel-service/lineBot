import { beforeEach, describe, expect, it, vi } from 'vitest'

// Nuxt auto-import（handler.ts 只在組 imagemap 網址時用到，這裡給空值即可）
vi.stubGlobal('useRuntimeConfig', () => ({}))

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__del__' },
  Timestamp: { now: () => ({ toMillis: () => 0 }), fromMillis: (m: number) => ({ toMillis: () => m, __ms: m }) },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('./line', () => ({
  replyMessage: vi.fn(async () => {}),
  pushMessage: vi.fn(async () => {}),
  getUserProfile: vi.fn(async () => ({ displayName: '測試客人', pictureUrl: '' })),
  linkRichMenuIdToUser: vi.fn(),
  showLoadingAnimation: vi.fn(async () => {}),
}))
vi.mock('./line-workspace-credentials', () => ({
  getLineWorkspaceCredentials: vi.fn(async () => ({ channelSecret: 'secret', channelAccessToken: 'token' })),
}))
vi.mock('./line-oa-basic-id', () => ({ resolveLineOaBasicId: vi.fn(async () => '@test') }))
vi.mock('./line-imagemap-image-token', () => ({ createImagemapImageToken: vi.fn(() => 'tok') }))
vi.mock('./line-action-tag-token', () => ({ createUriTagToken: vi.fn(() => 'tok') }))
vi.mock('./tagging', () => ({ addTagsToUser: vi.fn(async () => ({ added: 0 })) }))
vi.mock('./conversation-session', () => ({
  ensureConversationSession: vi.fn(async () => 'sess-1'),
  enterModule: vi.fn(async () => {}),
  getSessionStatusCached: vi.fn(async () => 'open'),
  onHumanOutgoingMessage: vi.fn(async () => {}),
  recordConversationEvent: vi.fn(async () => {}),
  shouldSuppressInboundBotAutomationForSession: vi.fn(async () => false),
}))
vi.mock('./ai-answer', () => ({
  answerWithAi: vi.fn(), routeMessage: vi.fn(), summarizeHandoffContext: vi.fn(),
  truncateLabel: (s: string) => s,
}))
vi.mock('./ai-settings', () => ({ getAiSettings: vi.fn(async () => null) }))
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn() }))
vi.mock('./ai-handoff-notify', () => ({ notifyHandoffToStaff: vi.fn() }))
vi.mock('./ai-scripts', () => ({
  advanceScript: vi.fn(), loadActiveScripts: vi.fn(async () => []), startScript: vi.fn(),
}))

import { saveConversationMessage } from './handler'
import { getDb } from './firebase'

const WS = 'ws-unread'
const LINE_UID = 'U0000000000000000000000000000009'
const DOC_ID = `${WS}_${LINE_UID}`
/** 客人在手機上按送出的那一刻（LINE webhook event.timestamp） */
const LINE_EVENT_MS = 1_700_000_000_000

interface Write { path: string; data: any }

function makeDb() {
  const writes: Write[] = []
  const db = {
    collection: (col: string) => ({
      doc: (id?: string) => ({
        set: vi.fn(async (data: any) => { writes.push({ path: `${col}/${id}`, data }) }),
        collection: (sub: string) => ({
          doc: () => ({
            id: 'msg-1',
            set: vi.fn(async (data: any) => { writes.push({ path: `${col}/${id}/${sub}`, data }) }),
          }),
        }),
      }),
    }),
  }
  return { db, writes }
}

function convWrite(writes: Write[]): any {
  return writes.find(w => w.path === `conversations/${DOC_ID}`)?.data
}
function messageWrite(writes: Write[]): any {
  return writes.find(w => w.path === `conversations/${DOC_ID}/messages`)?.data
}

beforeEach(() => { vi.clearAllMocks() })

/**
 * 未讀紅點問的是「列上這一則有沒有晚於我看過的時間」，差 1 毫秒就算沒看過。
 * 所以同一則訊息在「訊息本身」和「對話文件」上必須是同一個時間——不同的話，
 * 前端點開對話蓋的章（來自時間軸）永遠追不上列上那個，紅點就消不掉。
 * 細節見 handler.ts 的 lastMessageAt 與 AdminPanel.vue 的 maybeRefreshOpenTimeline。
 */
describe('對話文件的 lastMessageAt 要跟訊息自己的時間同一個值', () => {
  it('客人來訊：兩邊都是 LINE 事件時間，不可以另外蓋一次伺服器時間', async () => {
    const { db, writes } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    await saveConversationMessage(DOC_ID, 'incoming', '請問到貨了嗎', {
      messageType: 'text',
      lineEventTimestampMs: LINE_EVENT_MS,
    }, WS)

    expect(messageWrite(writes).timestamp).toMatchObject({ __ms: LINE_EVENT_MS })
    expect(convWrite(writes).lastMessageAt).toMatchObject({ __ms: LINE_EVENT_MS })
    // 這一條就是紅點消不掉的根因：曾經是 '__ts__'（serverTimestamp），比上面那個晚幾百毫秒
    expect(convWrite(writes).lastMessageAt).not.toBe('__ts__')
  })

  it('客人來訊：兩邊拿到的是同一個值（之後有人改成各蓋各的就會在這裡爆）', async () => {
    const { db, writes } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    await saveConversationMessage(DOC_ID, 'incoming', '再問一次', {
      messageType: 'text',
      lineEventTimestampMs: LINE_EVENT_MS,
    }, WS)

    expect(convWrite(writes).lastMessageAt.toMillis()).toBe(messageWrite(writes).timestamp.toMillis())
  })

  it('沒有 LINE 事件時間（非 webhook 來源）就退回伺服器時間，兩邊仍然同一個', async () => {
    const { db, writes } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    await saveConversationMessage(DOC_ID, 'incoming', '沒有事件時間', { messageType: 'text' }, WS)

    expect(messageWrite(writes).timestamp).toBe('__ts__')
    expect(convWrite(writes).lastMessageAt).toBe('__ts__')
  })

  it('我們送出的訊息照舊用伺服器時間（客人那支手機的時間跟這則無關）', async () => {
    const { db, writes } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    await saveConversationMessage(DOC_ID, 'outgoing', '已經出貨了唷', {
      messageType: 'text',
      lineEventTimestampMs: LINE_EVENT_MS,
    }, WS)

    expect(messageWrite(writes).timestamp).toBe('__ts__')
    expect(convWrite(writes).lastMessageAt).toBe('__ts__')
  })

  /**
   * 客人來訊時另外蓋的「對方最後互動時間」用途不同（24 小時開新會話、推定已讀），
   * 但同樣要跟這一則對得上，不可以在這次修改中被連坐改掉。
   */
  it('lastPeerActivityAt 也跟著同一個時間', async () => {
    const { db, writes } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    await saveConversationMessage(DOC_ID, 'incoming', '在嗎', {
      messageType: 'text',
      lineEventTimestampMs: LINE_EVENT_MS,
    }, WS)

    expect(convWrite(writes).lastPeerActivityAt).toMatchObject({ __ms: LINE_EVENT_MS })
  })
})

/**
 * 2026-08-19 換了紅點口徑：不再問「最後一則是不是客人送的」，改問「客人最後一則是什麼時候、
 * 有沒有人看過」（見 shared/conversation-unread.ts）。紅點比的值改成這個新欄位，
 * 所以它也要跟訊息自己的時間同一個值——理由同 lastMessageAt，差 1 毫秒就算沒看過。
 */
describe('客人最後一則的時間（紅點比的那個值）', () => {
  it('客人來訊：跟訊息自己的時間同一個值，不另外蓋伺服器時間', async () => {
    const { db, writes } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    await saveConversationMessage(DOC_ID, 'incoming', '請問有貨嗎', {
      messageType: 'text',
      lineEventTimestampMs: LINE_EVENT_MS,
    }, WS)

    expect(convWrite(writes).lastInboundMessageAt).toMatchObject({ __ms: LINE_EVENT_MS })
    expect(convWrite(writes).lastInboundMessageAt.toMillis())
      .toBe(messageWrite(writes).timestamp.toMillis())
  })

  it('我們送出的訊息不可以動到它——動了就等於「AI 一回，客人那句就算看過了」', async () => {
    const { db, writes } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    await saveConversationMessage(DOC_ID, 'outgoing', '有的唷', { messageType: 'text' }, WS)

    expect(convWrite(writes)).not.toHaveProperty('lastInboundMessageAt')
  })

  /**
   * 客人按按鈕／切選單是「客人動作紀錄」（traceOnly），刻意不動對話文件上的這幾個欄位——
   * 動了的話客人滑一下圖文選單，整排列就紅起來（見 shared/customer-action.ts）。
   */
  it('客人動作紀錄（按按鈕）不算開口，不動這個欄位', async () => {
    const { db, writes } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    await saveConversationMessage(DOC_ID, 'incoming', '客人按了「查詢訂單」', {
      messageType: 'customer_action',
      lineEventTimestampMs: LINE_EVENT_MS,
      traceOnly: true,
    }, WS)

    expect(convWrite(writes)).not.toHaveProperty('lastInboundMessageAt')
  })
})

/**
 * 2026-08-20 新增：「這位客人是真人的」記號記在**對話**上（不是會話上）。
 * 客人回的下一句要不要留給真人，看的就是這個值（見 conversation-session.ts 的
 * resolveHumanOwnership）——真人常常在沒有進行中會話時講話，那時沒有一場可以蓋。
 * 記號沒有時限，只有真人按「結束會話」／「交還機器人」才清掉。
 */
describe('「這位客人是真人的」記號（客人回話要不要留給真人的依據）', () => {
  it('客服手打／客服預存送出 → 記下來，且與訊息自己的時間同一個值', async () => {
    const { db, writes } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    await saveConversationMessage(DOC_ID, 'outgoing', '廠商說明天會補寄', {
      messageType: 'text',
      sender: 'human',
      senderName: '小敏',
    }, WS)

    expect(convWrite(writes).lastHumanActionAt).toBe('__ts__')
    expect(convWrite(writes).lastHumanActionAt).toBe(messageWrite(writes).timestamp)
  })

  it('AI 回的不算（否則 AI 自己講一句就能把後面的對話全部從自己手上收走）', async () => {
    const { db, writes } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    await saveConversationMessage(DOC_ID, 'outgoing', '您好，請問需要什麼協助？', {
      messageType: 'text',
      sender: 'ai',
      aiGenerated: true,
    }, WS)

    expect(convWrite(writes)).not.toHaveProperty('lastHumanActionAt')
  })

  it('機器人模組／系統通知也不算', async () => {
    const { db, writes } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    await saveConversationMessage(DOC_ID, 'outgoing', '已收到您的資訊', {
      messageType: 'text',
      sender: 'bot',
    }, WS)

    expect(convWrite(writes)).not.toHaveProperty('lastHumanActionAt')
  })

  it('客人來訊不會動到它', async () => {
    const { db, writes } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    await saveConversationMessage(DOC_ID, 'incoming', '好唷', {
      messageType: 'text',
      lineEventTimestampMs: LINE_EVENT_MS,
    }, WS)

    expect(convWrite(writes)).not.toHaveProperty('lastHumanActionAt')
  })
})
