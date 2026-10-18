/**
 * 出貨時程題不進流程、交給 AI 答（`C-343`）。
 *
 * 2026-10-09 正式站：客人打「訂單編號：M2026…，奇美電淨艙雙入組，請問何時才能出貨？」，
 * 「查詢訂單」流程靠關鍵字「訂單」攔下，再問一次編號、然後轉真人；連假期間客人只收到
 * 「非客服服務時間」。知識庫明明有這台的出貨時程。這支驗 handler 那一段分流：
 *   - 問出貨時程＋看得出商品＋AI 會回客人 → 不啟動流程、交給 AI，答完附「找真人」
 *   - 少任何一個條件 → 照舊啟動流程，而且觸發那句話有交給流程（裡面的編號才撿得到）
 */
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
  productsInConversation: vi.fn(),
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
vi.mock('./conversation-media', () => ({ archiveConversationMedia: vi.fn(async () => ({ ok: false })) }))
vi.mock('./media-describe', () => ({ readInboundImage: vi.fn() }))

import { handleMessageEvent } from './handler'
import { getDb } from './firebase'
import { getAiSettings } from './ai-settings'
import { answerWithAi, productsInConversation } from './ai-answer'
import { loadActiveScripts, startScript } from './ai-scripts'
import { replyMessage } from './line'

const WS = 'ws-ship'
let LINE_UID = ''
let uidSeq = 0

function makeDb() {
  const subCollection = () => ({
    doc: (docId?: string) => ({
      id: docId ?? 'auto',
      get: vi.fn(async () => ({ exists: false, data: () => undefined })),
      set: vi.fn(async () => {}),
    }),
    orderBy: () => ({ limit: () => ({ get: vi.fn(async () => ({ docs: [] })) }) }),
  })
  return {
    collection: (col: string) => ({
      where: () => ({ get: vi.fn(async () => ({ empty: true, docs: [] })) }),
      doc: () => ({
        get: vi.fn(async () => col === 'users'
          ? { exists: true, data: () => ({ workspaceId: WS, lineUserId: LINE_UID, displayName: '測試客人', isBlocked: false }) }
          : { exists: false, data: () => undefined }),
        set: vi.fn(async () => {}),
        update: vi.fn(async () => {}),
        collection: subCollection,
      }),
    }),
  }
}

/** 跟正式站「查詢訂單」同形：關鍵字「訂單」→ 問編號 */
const ORDER_SCRIPT = {
  id: 'script-order', workspaceId: WS, name: '查詢訂單', enabled: true, priority: 50, rootNodeId: 't',
  nodes: [
    { id: 't', type: 'trigger', matchMode: 'semantic', keywords: ['訂單', '查詢', '進度'], examples: [], priority: 50, next: 'c1' },
    { id: 'c1', type: 'collect', question: '您好,請問您的訂單編號是？', fieldName: 'order_id', expireMs: 600000, format: 'alphanumericSymbol', next: 'r1' },
    { id: 'r1', type: 'reply', text: '已收到', thenHandoff: true },
  ],
}

const SHIP_QUESTION = '訂單編號：M20261006142003LDEW，奇美電淨艙雙入組，請問何時才能出貨？'

function textEvent(text: string): any {
  return {
    type: 'message',
    timestamp: Date.now(),
    source: { type: 'user', userId: LINE_UID },
    replyToken: 'reply-token-1',
    message: { type: 'text', id: 'msg-1', text },
  }
}

function setSettings(replyMode: 'auto' | 'draft' = 'auto') {
  vi.mocked(getAiSettings).mockResolvedValue({
    enabled: true,
    replyMode,
    sensitiveTopics: [],
    imageAnswer: { enabled: true },
    confidenceThreshold: 0.75,
    disambiguation: { enabled: false, top1Min: 0.7, top1Max: 0.85, maxSpread: 0.1, maxOptions: 3, cooldownMinutes: 10 },
    handoffNotify: { enabled: false, lineUserIds: [], displayNames: {}, slaRemindMinutes: 10 },
    serviceHours: { enabled: false, start: '09:00', end: '18:00', weekendOff: true, dndReply: '' },
  } as any)
}

/** 送給客人的所有訊息（攤平） */
function sentMessages(): any[] {
  return vi.mocked(replyMessage).mock.calls.flatMap(c => c[1] as any[])
}

beforeEach(() => {
  vi.clearAllMocks()
  LINE_UID = `U${String(++uidSeq).padStart(32, '0')}`
  vi.mocked(getDb).mockReturnValue(makeDb() as any)
  setSettings()
  vi.mocked(loadActiveScripts).mockResolvedValue([ORDER_SCRIPT] as any)
  vi.mocked(startScript).mockResolvedValue({ replyText: '您好,請問您的訂單編號是？', thenHandoff: false, finished: false })
  vi.mocked(productsInConversation).mockResolvedValue({ products: new Set(['chimei 靜電集塵空氣清淨機 ap-08spfg (電淨艙)']), from: 'query' })
  vi.mocked(answerWithAi).mockResolvedValue({
    decision: 'answered',
    answer: '依原廠公告，奇美電淨艙將於 10 月底依訂單順序陸續出貨喔！',
    confidence: 0.85,
    sources: [{ chunkId: 'ship_ap08' }],
    handoffReason: null,
    answerKind: 'kb',
    offerFindHuman: true,
  } as any)
})

describe('出貨時程題：認得出商品就不進「查詢訂單」流程', () => {
  it('問何時出貨＋點名商品 → 不啟動流程，AI 答出貨時程、附「找真人」按鈕', async () => {
    await handleMessageEvent(textEvent(SHIP_QUESTION), { workspaceId: WS })

    expect(vi.mocked(startScript)).not.toHaveBeenCalled()
    expect(vi.mocked(answerWithAi)).toHaveBeenCalledTimes(1)
    const answer = sentMessages().find(m => String(m.text).includes('10 月底'))
    expect(answer).toBeTruthy()
    expect(answer.quickReply.items).toEqual([
      { type: 'action', action: { type: 'message', label: '🙋 找真人', text: '找真人' } },
    ])
  })

  it('看不出是哪個商品 → 照舊進流程，而且觸發那句話有交給流程（裡面的編號才撿得到）', async () => {
    vi.mocked(productsInConversation).mockResolvedValue(null)

    await handleMessageEvent(textEvent(SHIP_QUESTION), { workspaceId: WS })

    expect(vi.mocked(answerWithAi)).not.toHaveBeenCalled()
    expect(vi.mocked(startScript)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(startScript).mock.calls[0]?.[4]).toBe(SHIP_QUESTION)
  })

  it('草稿模式（AI 不對客人講話）→ 照舊進流程，不能繞過去變成沒人回', async () => {
    setSettings('draft')

    await handleMessageEvent(textEvent(SHIP_QUESTION), { workspaceId: WS })

    expect(vi.mocked(startScript)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(productsInConversation)).not.toHaveBeenCalled()
  })

  it('不是在問出貨時程（要取消）→ 照舊進流程，連商品都不用查', async () => {
    await handleMessageEvent(textEvent('奇美電淨艙的訂單我想取消'), { workspaceId: WS })

    expect(vi.mocked(startScript)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(productsInConversation)).not.toHaveBeenCalled()
  })

  it('查商品那一步壞掉 → 當作沒判斷，照舊進流程（不能讓整則訊息沒人回）', async () => {
    vi.mocked(productsInConversation).mockRejectedValue(new Error('firestore down'))

    await handleMessageEvent(textEvent(SHIP_QUESTION), { workspaceId: WS })

    expect(vi.mocked(startScript)).toHaveBeenCalledTimes(1)
  })

  it('一般 AI 回答不會多出「找真人」按鈕（只有出貨時程題才附）', async () => {
    vi.mocked(loadActiveScripts).mockResolvedValue([])
    vi.mocked(answerWithAi).mockResolvedValue({
      decision: 'answered', answer: '保固是一年。', confidence: 0.9,
      sources: [{ chunkId: 'w' }], handoffReason: null, answerKind: 'kb',
    } as any)

    await handleMessageEvent(textEvent('電淨艙保固多久'), { workspaceId: WS })

    const answer = sentMessages().find(m => m.text === '保固是一年。')
    expect(answer).toBeTruthy()
    expect(answer.quickReply).toBeUndefined()
  })
})
