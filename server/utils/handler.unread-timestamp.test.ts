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
