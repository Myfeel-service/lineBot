import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 2026-08-07 正式站災情重演：
 * 「查詢訂單」規則（包含任一關鍵字：查詢/訂單/進度/出貨/貨運、防重複觸發關閉、動作＝送一段文字）
 * 問客人要訂單編號；客人照著填「1. 訂單編號：M2026…」，那句話裡的「訂單」又打中同一條規則，
 * 於是同一段話連送三次。而 message 型動作既不轉真人也不通知任何人——客人把單號姓名電話信箱
 * 全給了，客服端一則通知都沒有，會話還掛在「機器人處理中」。
 *
 * 這裡驗的是：同一條規則連著命中第二次 → 不複讀、改走轉真人並通知值班客服。
 */

vi.stubGlobal('useRuntimeConfig', () => ({}))

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__del__' },
  Timestamp: { now: () => ({ toMillis: () => 0 }), fromMillis: (m: number) => ({ toMillis: () => m }) },
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
  answerWithAi: vi.fn(), routeMessage: vi.fn(async () => null), summarizeHandoffContext: vi.fn(async () => ''),
  truncateLabel: (s: string) => s,
}))
vi.mock('./ai-settings', () => ({
  getAiSettings: vi.fn(async () => ({ enabled: true, replyMode: 'auto', sensitiveTopics: [] })),
}))
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn(async () => {}) }))
vi.mock('./ai-handoff-notify', () => ({ notifyHandoffToStaff: vi.fn(async () => {}) }))
vi.mock('./ai-scripts', () => ({
  advanceScript: vi.fn(), loadActiveScripts: vi.fn(async () => []), startScript: vi.fn(),
}))
vi.mock('./conversation-media', () => ({ archiveConversationMedia: vi.fn(async () => ({ ok: false })) }))
vi.mock('./media-describe', () => ({ readInboundImage: vi.fn(async () => ({ description: '', question: '' })) }))

import { handleMessageEvent } from './handler'
import { getDb } from './firebase'
import { replyMessage } from './line'
import { notifyHandoffToStaff } from './ai-handoff-notify'

const LINE_UID = 'U0000000000000000000000000000031'
const ORDER_TEMPLATE = '您好，請提供您的訂單資訊，以便我們盡快為您查詢：\n1. 訂單編號：\n2. 姓名：\n3. 聯絡電話：\n4. 電子信箱：'

/** 每個測試自己一個 workspace：handler 內的規則／使用者快取是模組層的，共用會互相污染 */
let wsSeq = 0
function nextWs() { return `ws-arr-${++wsSeq}-${Date.now()}` }

/**
 * 有狀態的假 Firestore：users 文件的 set(merge) 要真的累積，
 * 「上一則自動回覆是哪條規則」跨兩個 webhook 事件才讀得回來。
 */
function makeDb(ws: string, rules: Array<Record<string, unknown>>) {
  const users = new Map<string, Record<string, unknown>>()
  const conversations = new Map<string, Record<string, unknown>>()
  users.set(`${ws}_${LINE_UID}`, { workspaceId: ws, lineUserId: LINE_UID, displayName: '測試客人', isBlocked: false })
  let autoId = 0

  const db = {
    collection: (col: string) => ({
      where: () => ({
        get: vi.fn(async () => (col === 'autoReplies'
          ? { empty: rules.length === 0, docs: rules.map(r => ({ id: String(r.id), data: () => r })) }
          : { empty: true, docs: [] })),
      }),
      doc: (id?: string) => ({
        get: vi.fn(async () => {
          const store = col === 'users' ? users : col === 'conversations' ? conversations : null
          if (store?.has(String(id))) return { exists: true, data: () => store.get(String(id)) }
          return { exists: false, data: () => undefined }
        }),
        set: vi.fn(async (data: any) => {
          const store = col === 'users' ? users : col === 'conversations' ? conversations : null
          store?.set(String(id), { ...(store.get(String(id)) ?? {}), ...data })
        }),
        update: vi.fn(async () => {}),
        collection: () => ({
          doc: (msgId?: string) => ({ id: msgId ?? `auto-${++autoId}`, set: vi.fn(async () => {}) }),
          orderBy: () => ({ limit: () => ({ get: vi.fn(async () => ({ docs: [] })) }) }),
        }),
      }),
    }),
    runTransaction: vi.fn(async (fn: any) => fn({
      get: async (ref: any) => ref.get(),
      set: vi.fn(), update: vi.fn(),
    })),
  }
  return { db, users, conversations }
}

function orderRule(ws: string) {
  return {
    id: 'rule-order',
    workspaceId: ws,
    name: '查詢訂單',
    keyword: '查詢,訂單,進度,出貨,貨運',
    matchType: 'containsAny',
    isActive: true,
    action: { type: 'message', moduleId: '', text: ORDER_TEMPLATE, uri: '' },
    cooldown: { enabled: false, durationMs: 60_000 },
  }
}

function textEvent(text: string, atMs: number, token: string): any {
  return {
    type: 'message',
    timestamp: atMs,
    source: { type: 'user', userId: LINE_UID },
    replyToken: token,
    message: { type: 'text', id: `msg-${token}`, text },
  }
}

/** 這次 replyMessage 送出去的第一則文字 */
function sentTexts(call: number): string {
  const msgs = vi.mocked(replyMessage).mock.calls[call]?.[1] as any[] | undefined
  return (msgs ?? []).map(m => String(m?.text ?? '')).join('\n')
}

describe('自動回覆連續複讀防呆', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('客人把規則要的資料填回來、又打中同一條規則 → 不再複讀，改轉真人並通知客服', async () => {
    const ws = nextWs()
    const { db } = makeDb(ws, [orderRule(ws)])
    vi.mocked(getDb).mockReturnValue(db as any)

    const now = Date.now()
    // 第一則：命中規則，照常送出那張要填的表單
    await handleMessageEvent(textEvent('你好 想請問這筆訂單 預計是今天會出貨嗎～？ M20260802120750K2MC', now, 'tk-1'), { workspaceId: ws })
    expect(sentTexts(0)).toContain('請提供您的訂單資訊')
    expect(vi.mocked(notifyHandoffToStaff)).not.toHaveBeenCalled()

    // 第二則：客人照著填回來，「訂單編號」又打中同一條規則
    await handleMessageEvent(
      textEvent('1. 訂單編號：M20260802120750K2MC\n2. 姓名：陳彥汝\n3. 聯絡電話：0975336994\n4. 電子信箱：cc369473@gmail.com', now + 60_000, 'tk-2'),
      { workspaceId: ws },
    )

    // 不可以再送一次那張表單，客人要收到的是「已為您安排專員」（不是安靜地什麼都沒有）
    expect(sentTexts(1)).not.toContain('請提供您的訂單資訊')
    expect(sentTexts(1)).toContain('已為您安排專員')
    // 而且客服要真的被通知（原本這條路徑一則通知都沒有）
    expect(vi.mocked(notifyHandoffToStaff)).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'auto_reply_repeat' }),
    )
  })

  it('中間換成別條規則 → 不算連續，兩條都照常回覆', async () => {
    const ws = nextWs()
    const other = {
      id: 'rule-hours', workspaceId: ws, name: '營業時間', keyword: '營業時間',
      matchType: 'containsAny', isActive: true,
      action: { type: 'message', moduleId: '', text: '我們的營業時間是週一到週五 10:00–18:00', uri: '' },
      cooldown: { enabled: false, durationMs: 60_000 },
    }
    const { db } = makeDb(ws, [orderRule(ws), other])
    vi.mocked(getDb).mockReturnValue(db as any)

    const now = Date.now()
    await handleMessageEvent(textEvent('我的訂單出貨了嗎', now, 'tk-1'), { workspaceId: ws })
    await handleMessageEvent(textEvent('請問營業時間', now + 1000, 'tk-2'), { workspaceId: ws })
    await handleMessageEvent(textEvent('那我的訂單呢', now + 2000, 'tk-3'), { workspaceId: ws })

    expect(sentTexts(0)).toContain('請提供您的訂單資訊')
    expect(sentTexts(1)).toContain('營業時間是週一到週五')
    expect(sentTexts(2)).toContain('請提供您的訂單資訊')
    expect(vi.mocked(notifyHandoffToStaff)).not.toHaveBeenCalled()
  })

  it('「輸入任何內容」規則不受影響：它的本意就是每一則都回同一句', async () => {
    const ws = nextWs()
    const anyTextRule = {
      id: 'rule-any', workspaceId: ws, name: '任何內容', keyword: '',
      matchType: 'anyText', isActive: true,
      action: { type: 'message', moduleId: '', text: '客服稍後回覆您', uri: '' },
      cooldown: { enabled: false, durationMs: 60_000 },
    }
    const { db } = makeDb(ws, [anyTextRule])
    vi.mocked(getDb).mockReturnValue(db as any)

    const now = Date.now()
    await handleMessageEvent(textEvent('在嗎', now, 'tk-1'), { workspaceId: ws })
    await handleMessageEvent(textEvent('哈囉', now + 1000, 'tk-2'), { workspaceId: ws })

    expect(sentTexts(0)).toContain('客服稍後回覆您')
    expect(sentTexts(1)).toContain('客服稍後回覆您')
    expect(vi.mocked(notifyHandoffToStaff)).not.toHaveBeenCalled()
  })
})
