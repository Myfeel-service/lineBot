import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  answerWithAi: vi.fn(),
  routeMessage: vi.fn(async () => null),
  summarizeHandoffContext: vi.fn(async () => ''),
  truncateLabel: (s: string) => s,
}))
vi.mock('./ai-settings', () => ({ getAiSettings: vi.fn() }))
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn(async () => {}) }))
vi.mock('./ai-handoff-notify', () => ({ notifyHandoffToStaff: vi.fn(async () => {}) }))
vi.mock('./ai-scripts', () => ({
  advanceScript: vi.fn(), loadActiveScripts: vi.fn(async () => []), startScript: vi.fn(),
}))
vi.mock('./conversation-media', () => ({
  archiveConversationMedia: vi.fn(async () => ({
    ok: true, path: 'conversation-media/ws-img/msg-img-1', contentType: 'image/jpeg', bytes: 1024,
  })),
}))
vi.mock('./media-describe', () => ({ readInboundImage: vi.fn() }))

import { handleMessageEvent } from './handler'
import { getDb } from './firebase'
import { replyMessage } from './line'
import { getAiSettings } from './ai-settings'
import { answerWithAi } from './ai-answer'
import { readInboundImage } from './media-describe'
import { shouldSuppressInboundBotAutomationForSession } from './conversation-session'

const WS = 'ws-img'
/**
 * 每個 case 換一位客人：引導語有「每人 10 分鐘一次」的節流，而那份節流表是模組層狀態，
 * 會跨測試殘留——共用同一個 uid 的話，第二個 case 之後的引導語會被靜靜吃掉。
 */
let LINE_UID = ''
let DOC_ID = ''
let uidSeq = 0

/** 引導語的關鍵字：只要客人收到這句，就代表 AI 沒有接手回答 */
const ACK_HINT = '只能閱讀文字'

function makeDb() {
  const conversations = new Map<string, Record<string, unknown>>()
  const userDoc = {
    exists: true,
    data: () => ({ workspaceId: WS, lineUserId: LINE_UID, displayName: '測試客人', isBlocked: false }),
  }
  // 訊息子集合要同時支援「新增一則」與「查最近 8 則」（答題流程會讀對話歷史）
  const messagesQuery = { docs: [] as any[] }
  const subCollection = () => ({
    doc: (msgId?: string) => ({ id: msgId ?? 'auto-1', set: vi.fn(async () => {}) }),
    orderBy: () => ({ limit: () => ({ get: vi.fn(async () => messagesQuery) }) }),
  })
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
        collection: subCollection,
      }),
    }),
  }
  return { db, conversations }
}

function imageEvent(): any {
  return {
    type: 'message',
    timestamp: Date.now(),
    source: { type: 'user', userId: LINE_UID },
    replyToken: 'reply-token-1',
    message: { type: 'image', id: 'msg-img-1' },
  }
}

/** 客人收到的所有文字（AI 的答案或引導語都會經過 replyMessage） */
function repliedTexts(): string[] {
  return vi.mocked(replyMessage).mock.calls.flatMap(([, msgs]) =>
    (msgs as any[]).map(m => String(m?.text ?? '')),
  )
}

function setSettings(imageAnswerEnabled: boolean, replyMode: 'auto' | 'draft' = 'auto') {
  vi.mocked(getAiSettings).mockResolvedValue({
    enabled: true,
    replyMode,
    sensitiveTopics: [],
    imageAnswer: { enabled: imageAnswerEnabled },
    confidenceThreshold: 0.75,
    disambiguation: { enabled: false, top1Min: 0.7, top1Max: 0.85, maxSpread: 0.1, maxOptions: 3, cooldownMinutes: 10 },
    handoffNotify: { enabled: false, lineUserIds: [], displayNames: {}, slaRemindMinutes: 10 },
    serviceHours: { enabled: false, start: '09:00', end: '18:00', weekendOff: true, dndReply: '' },
  } as any)
}

beforeEach(() => {
  vi.clearAllMocks()
  LINE_UID = `U${String(++uidSeq).padStart(32, '0')}`
  DOC_ID = `${WS}_${LINE_UID}`
  const { db } = makeDb()
  vi.mocked(getDb).mockReturnValue(db as any)
  vi.mocked(shouldSuppressInboundBotAutomationForSession).mockResolvedValue(false)
})

describe('看圖作答：開關關著時什麼都不變', () => {
  it('沒開 → 客人照舊收到引導語，AI 不會被叫去答題', async () => {
    setSettings(false)
    vi.mocked(readInboundImage).mockResolvedValue({ description: '破掉的杯子', question: '' })

    await handleMessageEvent(imageEvent(), { workspaceId: WS })

    expect(repliedTexts().join()).toContain(ACK_HINT)
    expect(vi.mocked(answerWithAi)).not.toHaveBeenCalled()
  })
})

describe('看圖作答：開了之後', () => {
  it('讀得出客人想問什麼 → 用 AI 的答案回覆，而且不再發「我只看得懂文字」', async () => {
    const { db, conversations } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)
    setSettings(true)
    vi.mocked(readInboundImage).mockResolvedValue({
      description: '破掉的白色馬克杯', question: '杯子破掉可以換貨嗎',
    })
    vi.mocked(answerWithAi).mockResolvedValue({
      decision: 'answered', answer: '收到，破損可在七天內換貨，我們會幫您安排。',
      confidence: 0.9, sources: [], handoffReason: null, answerKind: 'kb',
    } as any)

    await handleMessageEvent(imageEvent(), { workspaceId: WS })

    const texts = repliedTexts().join()
    expect(texts).toContain('七天內換貨')
    // 一則進來的訊息只有一個 replyToken：引導語一旦先發出去，答案就發不了了
    expect(texts).not.toContain(ACK_HINT)
    expect(vi.mocked(replyMessage)).toHaveBeenCalledTimes(1)

    // 監控頁要看得到是哪一句被拿去問的（圖片本身沒有文字可記）
    const conv = conversations.get(DOC_ID) as any
    expect(conv.aiMeta.lastQuery).toBe('杯子破掉可以換貨嗎')
    expect(conv.aiMeta.lastDecision).toBe('answered')
  })

  it('拿去查知識庫的是「問句」不是「描述」——描述是名詞句，會撈到商品介紹卡', async () => {
    setSettings(true)
    vi.mocked(readInboundImage).mockResolvedValue({
      description: '破掉的白色馬克杯', question: '杯子破掉可以換貨嗎',
    })
    vi.mocked(answerWithAi).mockResolvedValue({
      decision: 'answered', answer: '可以換貨', confidence: 0.9, sources: [], handoffReason: null, answerKind: 'kb',
    } as any)

    await handleMessageEvent(imageEvent(), { workspaceId: WS })

    expect((vi.mocked(answerWithAi).mock.calls[0]![0] as any).query).toBe('杯子破掉可以換貨嗎')
  })

  it('看不出想問什麼（自拍/風景）→ 退回引導語，不硬掰問題去問 AI', async () => {
    setSettings(true)
    vi.mocked(readInboundImage).mockResolvedValue({ description: '在海邊的自拍照', question: '' })

    await handleMessageEvent(imageEvent(), { workspaceId: WS })

    expect(repliedTexts().join()).toContain(ACK_HINT)
    expect(vi.mocked(answerWithAi)).not.toHaveBeenCalled()
  })

  it('讀圖整個失敗（Gemini 掛了）→ 一樣退回引導語，客人不會被已讀不回', async () => {
    setSettings(true)
    vi.mocked(readInboundImage).mockResolvedValue({ description: '', question: '' })

    await handleMessageEvent(imageEvent(), { workspaceId: WS })

    expect(repliedTexts().join()).toContain(ACK_HINT)
  })

  it('真人正在處理這通對話 → 機器人完全閉嘴（插話比不回更糟）', async () => {
    setSettings(true)
    vi.mocked(shouldSuppressInboundBotAutomationForSession).mockResolvedValue(true)
    vi.mocked(readInboundImage).mockResolvedValue({
      description: '破掉的杯子', question: '杯子破掉可以換貨嗎',
    })

    await handleMessageEvent(imageEvent(), { workspaceId: WS })

    expect(vi.mocked(answerWithAi)).not.toHaveBeenCalled()
    expect(repliedTexts().join()).not.toContain(ACK_HINT)
  })

  it('AI 答不出來 → 走既有的轉真人流程，不會自己掰一個答案', async () => {
    setSettings(true)
    vi.mocked(readInboundImage).mockResolvedValue({
      description: '看不出品牌的零件', question: '這個零件叫什麼',
    })
    vi.mocked(answerWithAi).mockResolvedValue({
      decision: 'handoff', answer: '', confidence: 0.2, sources: [], handoffReason: 'no_grounding',
    } as any)

    await handleMessageEvent(imageEvent(), { workspaceId: WS })

    // 轉真人的回覆內容由 sys_live_agent 流程決定，這裡只確認沒有變成「我只看得懂文字」
    expect(repliedTexts().join()).not.toContain(ACK_HINT)
  })

  it('草稿模式：AI 照樣讀圖產草稿，但一個字都不對客人說', async () => {
    setSettings(true, 'draft')
    vi.mocked(readInboundImage).mockResolvedValue({
      description: '破掉的杯子', question: '杯子破掉可以換貨嗎',
    })
    vi.mocked(answerWithAi).mockResolvedValue({
      decision: 'answered', answer: '可以換貨', confidence: 0.9, sources: [], handoffReason: null, answerKind: 'kb',
    } as any)

    await handleMessageEvent(imageEvent(), { workspaceId: WS })

    expect(vi.mocked(answerWithAi)).toHaveBeenCalled()
    expect(vi.mocked(replyMessage)).not.toHaveBeenCalled()
  })
})
