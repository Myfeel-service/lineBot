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

import { handlePostbackEvent } from './handler'
import { getDb } from './firebase'
import { CUSTOMER_ACTION_MESSAGE_TYPE } from '~~/shared/customer-action'

const LINE_UID = 'U0000000000000000000000000000009'

interface Write { path: string; data: any }

/**
 * 假 Firestore。`flows` 依 flowsById 回傳模組，其餘沿用 session-accounting 那份的形狀。
 * 每個 case 用不同的 moduleId／workspaceId：handler 內部對 flow 與規則都有 in-memory 快取。
 */
function makeDb(opts: { flowsById?: Record<string, any> } = {}) {
  const writes: Write[] = []
  const userDoc = {
    exists: true,
    data: () => ({ workspaceId: 'ws', lineUserId: LINE_UID, displayName: '測試客人', isBlocked: false }),
  }

  const db = {
    collection: (col: string) => ({
      where: () => ({ get: vi.fn(async () => ({ empty: true, docs: [] })) }),
      doc: (id?: string) => ({
        get: vi.fn(async () => {
          if (col === 'users') return userDoc
          if (col === 'flows' && id && opts.flowsById?.[id]) {
            return { exists: true, data: () => opts.flowsById![id] }
          }
          return { exists: false, data: () => undefined }
        }),
        set: vi.fn(async (data: any) => { writes.push({ path: `${col}/${id}`, data }) }),
        update: vi.fn(async (data: any) => { writes.push({ path: `${col}/${id}`, data }) }),
        collection: (sub: string) => ({
          doc: () => ({
            set: vi.fn(async (data: any) => { writes.push({ path: `${col}/${id}/${sub}`, data }) }),
          }),
        }),
      }),
    }),
  }
  return { db, writes }
}

function postbackEvent(data: string): any {
  return {
    type: 'postback',
    timestamp: 1700000000000,
    source: { type: 'user', userId: LINE_UID },
    replyToken: 'reply-token',
    postback: { data },
  }
}

function actionWrites(writes: Write[]): Write[] {
  return writes.filter(w => w.path.endsWith('/messages') && w.data?.messageType === CUSTOMER_ACTION_MESSAGE_TYPE)
}

beforeEach(() => { vi.clearAllMocks() })

/**
 * postback 不會存成訊息，所以「客人按了什麼」在對話上本來完全沒有痕跡——
 * 客服看到的是我們自己先開口講了一段話。這幾個 case 就是在盯住那一行紀錄還在。
 */
describe('客人按了按鈕 → 對話裡要留一行紀錄', () => {
  it('按到模組：記模組名稱（LINE 的 postback 不帶按鈕文字，模組名是我們拿得到最接近的東西）', async () => {
    const { db, writes } = makeDb({
      flowsById: { 'mod-live': { name: '真人客服', isActive: true, messages: [], moduleType: 'bot_flow' } },
    })
    vi.mocked(getDb).mockReturnValue(db as any)

    await handlePostbackEvent(postbackEvent('triggerModule=mod-live'), { workspaceId: 'ws-ca1' })

    const actions = actionWrites(writes)
    expect(actions).toHaveLength(1)
    expect(actions[0]!.data.text).toBe('客人點了「真人客服」')
    expect(actions[0]!.data.payload).toMatchObject({ actionType: 'button_module', moduleId: 'mod-live' })
  })

  it('那一行的時間用 LINE 事件時間：否則會排到自己的回覆後面（客人先按、我們才回）', async () => {
    const { db, writes } = makeDb({
      flowsById: { 'mod-ts': { name: '常見問題', isActive: true, messages: [], moduleType: 'bot_flow' } },
    })
    vi.mocked(getDb).mockReturnValue(db as any)

    await handlePostbackEvent(postbackEvent('triggerModule=mod-ts'), { workspaceId: 'ws-ca2' })

    expect(actionWrites(writes)[0]!.data.timestamp).toMatchObject({ __ms: 1700000000000 })
  })

  it('按了但沒有任何回覆送出（模組被刪／停用）也要記，否則只剩一筆空的待處理', async () => {
    const { db, writes } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    await handlePostbackEvent(postbackEvent('triggerModule=mod-dead'), { workspaceId: 'ws-ca3' })

    const actions = actionWrites(writes)
    expect(actions).toHaveLength(1)
    // 帶 moduleId＝後台改得到的那種壞法，話要講不一樣（沒有規則命中是另一句）
    expect(actions[0]!.data.text).toBe('客人點了按鈕，但指向的內容已失效（沒有回覆送出）')
    expect(actions[0]!.data.payload).toMatchObject({ actionType: 'button_dead', moduleId: 'mod-dead' })
  })

  it('連規則都沒命中：講「沒有對應的回覆內容」（跟模組失效不是同一種壞法，修法不同）', async () => {
    const { db, writes } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    await handlePostbackEvent(postbackEvent('legacy_data_with_no_rule'), { workspaceId: 'ws-ca3b' })

    const actions = actionWrites(writes)
    expect(actions).toHaveLength(1)
    expect(actions[0]!.data.text).toBe('客人點了按鈕，但沒有對應的回覆內容（沒有回覆送出）')
  })

  it('按鈕代客人送出文字：要看得出是「按的」不是「打的」', async () => {
    const { db, writes } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    await handlePostbackEvent(
      postbackEvent(`triggerMessage=${encodeURIComponent(JSON.stringify({ text: '我要退貨', tagIds: [] }))}`),
      { workspaceId: 'ws-ca4' },
    )

    const actions = actionWrites(writes)
    expect(actions).toHaveLength(1)
    expect(actions[0]!.data.text).toBe('客人點了按鈕送出「我要退貨」')
  })

  /**
   * 這一條是整個功能的安全帶：紀錄只能寫進訊息子集合。
   * 蓋到 lastMessage 會讓列表第二行變成「客人：客人點了…」、
   * 蓋到 lastMessageAt 會把對話推成未讀、還可能讓客人點一下就開一場新會話。
   */
  it('紀錄不可蓋掉對話文件的 lastMessage／lastMessageAt（列表摘要與未讀都靠它）', async () => {
    const { db, writes } = makeDb({
      flowsById: { 'mod-keep': { name: '查訂單', isActive: true, messages: [], moduleType: 'bot_flow' } },
    })
    vi.mocked(getDb).mockReturnValue(db as any)

    await handlePostbackEvent(postbackEvent('triggerModule=mod-keep'), { workspaceId: 'ws-ca5' })

    // 對話文件上「只有」保證父文件存在的那兩個欄位，其餘一律不碰
    const convWrites = writes.filter(w => w.path.startsWith('conversations/') && !w.path.endsWith('/messages'))
    const traceConvWrites = convWrites.filter(w => Object.keys(w.data).every(k => k === 'workspaceId' || k === 'userId'))
    expect(traceConvWrites.length).toBeGreaterThan(0)
    for (const w of traceConvWrites) {
      expect(w.data).not.toHaveProperty('lastMessage')
      expect(w.data).not.toHaveProperty('lastMessageAt')
      expect(w.data).not.toHaveProperty('lastPeerActivityAt')
    }
  })

  it('純切換圖文選單分頁不記：那是每次逛都會按好幾下的操作，會淹掉真正的對話', async () => {
    const { db, writes } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    await handlePostbackEvent(postbackEvent('switchMenu=menu-1'), { workspaceId: 'ws-ca6' })

    expect(actionWrites(writes)).toHaveLength(0)
  })
})
