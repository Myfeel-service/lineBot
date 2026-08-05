import { beforeEach, describe, expect, it, vi } from 'vitest'

// Nuxt auto-import（handler.ts 只在組 imagemap 網址時用到，這裡給空值即可）
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
// 圖片存檔會打 LINE content API：測試只在意「起因有沒有被記住」，存檔本身另有測試
vi.mock('./conversation-media', () => ({
  archiveConversationMedia: vi.fn(async () => ({
    ok: true, path: 'conversation-media/ws-nontext/msg-img-1', contentType: 'image/jpeg', bytes: 1024,
  })),
}))
// 讀圖是另一支的職責（media-describe.test.ts 有自己的測試），這裡只驗它的產物有沒有被用上
vi.mock('./media-describe', () => ({ readInboundImage: vi.fn(async () => ({ description: '', question: '' })) }))

import { handleMessageEvent } from './handler'
import { getDb } from './firebase'
import { notifyHandoffToStaff } from './ai-handoff-notify'
import { readInboundImage } from './media-describe'

const WS = 'ws-nontext'
const LINE_UID = 'U0000000000000000000000000000009'
const DOC_ID = `${WS}_${LINE_UID}`

/**
 * 有狀態的假 Firestore：conversations 文件的 set(merge) 會真的累積，
 * 之後的 get() 讀得到——「傳圖蓋時間戳 → 找真人讀回時間戳」跨兩個 webhook 事件，
 * 無狀態的假 db 會讓這條因果永遠測不到。
 */
function makeDb() {
  const conversations = new Map<string, Record<string, unknown>>()
  // 訊息子集合：doc() 不帶 id = 新增（自動 id），帶 id = 補寫既有那一則（圖片描述走這條）
  const messages = new Map<string, Record<string, unknown>>()
  let autoId = 0
  const userDoc = {
    exists: true,
    data: () => ({ workspaceId: WS, lineUserId: LINE_UID, displayName: '測試客人', isBlocked: false }),
  }
  const db = {
    collection: (col: string) => ({
      where: () => ({ get: vi.fn(async () => ({ empty: true, docs: [] })) }),
      doc: (id?: string) => ({
        get: vi.fn(async () => {
          if (col === 'users') return userDoc
          if (col === 'conversations' && conversations.has(String(id))) {
            return { exists: true, data: () => conversations.get(String(id)) }
          }
          return { exists: false, data: () => undefined }
        }),
        set: vi.fn(async (data: any) => {
          if (col === 'conversations') {
            conversations.set(String(id), { ...(conversations.get(String(id)) ?? {}), ...data })
          }
        }),
        update: vi.fn(async () => {}),
        collection: () => ({
          doc: (msgId?: string) => {
            const key = msgId ?? `auto-${++autoId}`
            return {
              id: key,
              set: vi.fn(async (data: any) => {
                messages.set(key, { ...(messages.get(key) ?? {}), ...data })
              }),
            }
          },
        }),
      }),
    }),
  }
  return { db, conversations, messages }
}

function imageEvent(atMs: number): any {
  return {
    type: 'message',
    timestamp: atMs,
    source: { type: 'user', userId: LINE_UID },
    replyToken: 'reply-token-1',
    message: { type: 'image', id: 'msg-img-1' },
  }
}

function textEvent(text: string, atMs: number): any {
  return {
    type: 'message',
    timestamp: atMs,
    source: { type: 'user', userId: LINE_UID },
    replyToken: 'reply-token-2',
    message: { type: 'text', id: 'msg-txt-1', text },
  }
}

/**
 * 客人傳圖 → 機器人回「我只看得懂文字，需要專員請輸入找真人」→ 客人照做。
 * 只看那三個字的話，監控頁會把這種「被擋住」記成「客人自己想找真人」，
 * 客服看到一排「客人要求真人」完全不知道其實是圖片卡住的。
 */
describe('傳圖後找真人：轉真人原因要記得起因是圖片', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('傳圖後 10 分鐘內喊「找真人」→ 原因 non_text_content、原句記成 [圖片]', async () => {
    const { db, conversations } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    const now = Date.now()
    await handleMessageEvent(imageEvent(now - 60_000), { workspaceId: WS })
    await handleMessageEvent(textEvent('找真人', now), { workspaceId: WS })

    const conv = conversations.get(DOC_ID) as any
    expect(conv.aiMeta.lastDecision).toBe('handoff')
    expect(conv.aiMeta.lastHandoffReason).toBe('non_text_content')
    expect(conv.aiMeta.lastQuery).toBe('[圖片]')
  })

  it('值班客服的通知也要寫圖片，不是「找真人」三個字', async () => {
    const { db } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    const now = Date.now()
    await handleMessageEvent(imageEvent(now - 60_000), { workspaceId: WS })
    await handleMessageEvent(textEvent('找真人', now), { workspaceId: WS })

    expect(vi.mocked(notifyHandoffToStaff)).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'non_text_content', customerMessage: '[圖片]' }),
    )
  })

  it('沒傳過圖就喊「找真人」→ 維持 user_request（別把主動找真人也算成傳圖）', async () => {
    const { db, conversations } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    await handleMessageEvent(textEvent('找真人', Date.now()), { workspaceId: WS })

    const conv = conversations.get(DOC_ID) as any
    expect(conv.aiMeta.lastHandoffReason).toBe('user_request')
    expect(conv.aiMeta.lastQuery).toBe('找真人')
  })

  it('圖是很久以前傳的（超過 10 分鐘）→ 這次找真人是新的意圖，記 user_request', async () => {
    const { db, conversations } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    const now = Date.now()
    await handleMessageEvent(imageEvent(now - 30 * 60_000), { workspaceId: WS })
    await handleMessageEvent(textEvent('找真人', now), { workspaceId: WS })

    const conv = conversations.get(DOC_ID) as any
    expect(conv.aiMeta.lastHandoffReason).toBe('user_request')
  })

  it('AI 讀出圖片內容時，轉真人案例要寫「[圖片] 破掉的馬克杯」而不是光一個 [圖片]', async () => {
    const { db, conversations, messages } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)
    vi.mocked(readInboundImage).mockResolvedValue({ description: '破掉的白色馬克杯', question: '' })

    const now = Date.now()
    await handleMessageEvent(imageEvent(now - 60_000), { workspaceId: WS })
    await handleMessageEvent(textEvent('找真人', now), { workspaceId: WS })

    const conv = conversations.get(DOC_ID) as any
    expect(conv.aiMeta.lastQuery).toBe('[圖片] 破掉的白色馬克杯')
    // 描述也要貼回那一則訊息，客服在對話裡才看得到圖片下方的說明
    expect([...messages.values()].some(m => m.mediaDescription === '破掉的白色馬克杯')).toBe(true)
  })

  it('這張圖讀不出來時，不能沿用上一張圖的說明（張冠李戴比沒有說明更糟）', async () => {
    const { db, conversations } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    const now = Date.now()
    vi.mocked(readInboundImage).mockResolvedValue({ description: '破掉的白色馬克杯', question: '' })
    await handleMessageEvent(imageEvent(now - 120_000), { workspaceId: WS })
    // 第二張圖：Gemini 逾時 → 描述空字串
    vi.mocked(readInboundImage).mockResolvedValue({ description: '', question: '' })
    await handleMessageEvent(imageEvent(now - 60_000), { workspaceId: WS })
    await handleMessageEvent(textEvent('找真人', now), { workspaceId: WS })

    const conv = conversations.get(DOC_ID) as any
    expect(conv.aiMeta.lastQuery).toBe('[圖片]')
  })

  it('傳圖後改用文字問、AI 已經答過 → 這句找真人是嫌回答不好，不該算在圖片頭上', async () => {
    const { db, conversations } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    const now = Date.now()
    await handleMessageEvent(imageEvent(now - 5 * 60_000), { workspaceId: WS })
    // 中間 AI 答過一題（aiMeta 比圖新）
    conversations.set(DOC_ID, {
      ...(conversations.get(DOC_ID) ?? {}),
      aiMeta: { lastDecision: 'answered', updatedAt: { toMillis: () => now - 60_000 } },
    })
    await handleMessageEvent(textEvent('找真人', now), { workspaceId: WS })

    const conv = conversations.get(DOC_ID) as any
    expect(conv.aiMeta.lastHandoffReason).toBe('user_request')
  })

  it('貼圖不算：貼圖不會觸發引導語，之後的找真人就是客人自己要找人', async () => {
    const { db, conversations } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    const now = Date.now()
    const sticker = { ...imageEvent(now - 60_000), message: { type: 'sticker', id: 'stk-1' } }
    await handleMessageEvent(sticker, { workspaceId: WS })
    await handleMessageEvent(textEvent('找真人', now), { workspaceId: WS })

    const conv = conversations.get(DOC_ID) as any
    expect(conv.aiMeta.lastHandoffReason).toBe('user_request')
  })
})
