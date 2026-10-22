/**
 * 客服剛按「結束會話」／「交還機器人」，客人 30 分鐘內接著講（`C-382`，老闆 2026-10-22「Ok」）。
 *
 * 以前：按結束時「真人的」記號就清掉，客人接著講的那一句直接被 AI 接走——MYFEEL 按完一小時內
 * 客人又回話 111 次、AI 接了 84 次，除了謝謝多半接不住（「信箱被退件了」→「不客氣！」）。
 *
 * 要釘住的：
 *  - 打字／傳圖 → 放回待真人、客人收一句、客服收通知（原因寫「結束後 N 分鐘」）；AI 一次都不會被叫到
 *  - 只回謝謝／好的、只傳貼圖 → 照舊交給 AI，而且不用掉這 30 分鐘（之後真的問了還是交給真人）
 *  - 超過 30 分鐘、從沒放手過 → 照舊交給 AI
 *  - 按按鈕 → 照舊（自助模組照回、「真人客服」本來就轉真人）
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
  readHumanRelease: vi.fn(async () => null),
  recordConversationEvent: vi.fn(async () => {}),
  returnHumanSessionToPending: vi.fn(async () => false),
  returnReleasedSessionToPending: vi.fn(async () => null),
  shouldSuppressInboundBotAutomationForSession: vi.fn(async () => false),
}))
vi.mock('./ai-answer', () => ({
  answerWithAi: vi.fn(), routeMessage: vi.fn(async () => null), summarizeHandoffContext: vi.fn(async () => ''),
  truncateLabel: (s: string) => s,
}))
// AI 那條路要讀到的設定都要有（「謝謝」、超過 30 分鐘那幾個 case 會真的走到 AI）
vi.mock('./ai-settings', () => ({
  getAiSettings: vi.fn(async () => ({
    enabled: true,
    replyMode: 'auto',
    sensitiveTopics: [],
    imageAnswer: { enabled: false },
    confidenceThreshold: 0.75,
    disambiguation: { enabled: false, top1Min: 0.7, top1Max: 0.85, maxSpread: 0.1, maxOptions: 3, cooldownMinutes: 10 },
    handoffNotify: { enabled: false, lineUserIds: [], displayNames: {}, slaRemindMinutes: 10 },
    serviceHours: { enabled: false, start: '09:00', end: '18:00', weekendOff: true, dndReply: '' },
  })),
}))
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn(async () => {}) }))
vi.mock('./ai-handoff-notify', () => ({ notifyHandoffToStaff: vi.fn(async () => true) }))
vi.mock('./ai-scripts', () => ({
  advanceScript: vi.fn(), loadActiveScripts: vi.fn(async () => []), startScript: vi.fn(),
}))
vi.mock('./conversation-media', () => ({ archiveConversationMedia: vi.fn(async () => ({ ok: false })) }))
vi.mock('./media-describe', () => ({ readInboundImage: vi.fn(async () => ({ description: '', questions: [] })) }))

import { handleMessageEvent, handlePostbackEvent } from './handler'
import { getDb } from './firebase'
import { replyMessage } from './line'
import {
  getSessionStatusCached,
  readHumanRelease,
  returnReleasedSessionToPending,
  shouldSuppressInboundBotAutomationForSession,
} from './conversation-session'
import { notifyHandoffToStaff } from './ai-handoff-notify'
import { answerWithAi, routeMessage } from './ai-answer'

const WS = 'ws-release-follow-up'
const LIVE_MODULE = 'mod-live-agent'
const MSG_AT = 1_700_000_000_000
const MIN = 60_000
const WAITING_ACK = '已收到您的訊息，專員會盡快回覆您'

/** 對話歷史的查詢（AI 那條路會讀前文）：一律回空，串幾段 where／orderBy／limit 都接得住 */
function emptyQuery(): any {
  const q: any = {
    where: () => q,
    orderBy: () => q,
    limit: () => q,
    startAfter: () => q,
    get: async () => ({ empty: true, docs: [], size: 0 }),
  }
  return q
}

function makeDb(lineUserId: string) {
  let autoId = 0
  const flows: Record<string, any> = {
    [LIVE_MODULE]: {
      workspaceId: WS, name: '真人客服', moduleType: 'live_agent', isActive: true,
      messages: [{ type: 'text', text: '謝謝您！我們的客服人員會很快聯絡您', buttons: [] }],
    },
  }
  return {
    collection: (col: string) => ({
      where: () => ({ get: vi.fn(async () => ({ empty: true, docs: [] })) }),
      doc: (id?: string) => ({
        get: vi.fn(async () => {
          if (col === 'users') {
            return { exists: true, data: () => ({ workspaceId: WS, lineUserId, displayName: '測試客人', isBlocked: false }) }
          }
          if (col === 'flows' && flows[String(id)]) return { exists: true, data: () => flows[String(id)] }
          return { exists: false, data: () => undefined }
        }),
        set: vi.fn(async () => {}),
        update: vi.fn(async () => {}),
        collection: () => ({
          ...emptyQuery(),
          doc: (msgId?: string) => ({ id: msgId ?? `auto-${++autoId}`, set: vi.fn(async () => {}) }),
        }),
      }),
    }),
  }
}

function textEvent(lineUserId: string, text: string, atMs = MSG_AT): any {
  return {
    type: 'message',
    timestamp: atMs,
    source: { type: 'user', userId: lineUserId },
    replyToken: `reply-text-${lineUserId}-${atMs}`,
    message: { type: 'text', id: `msg-${lineUserId}-${atMs}`, text },
  }
}

function mediaEvent(lineUserId: string, type: 'image' | 'sticker'): any {
  return {
    type: 'message',
    timestamp: MSG_AT,
    source: { type: 'user', userId: lineUserId },
    replyToken: `reply-${type}-${lineUserId}`,
    message: type === 'sticker'
      ? { type: 'sticker', id: `st-${lineUserId}`, packageId: '1', stickerId: '1' }
      : { type: 'image', id: `img-${lineUserId}` },
  }
}

function postbackEvent(lineUserId: string, moduleId: string): any {
  return {
    type: 'postback',
    timestamp: MSG_AT,
    source: { type: 'user', userId: lineUserId },
    replyToken: `reply-${moduleId}-${lineUserId}`,
    postback: { data: `triggerModule=${moduleId}` },
  }
}

function sentTexts(): string[] {
  return vi.mocked(replyMessage).mock.calls.flatMap(c =>
    (c[1] as any[]).map(m => String(m?.text ?? '')),
  )
}

/**
 * 客服 `minutesAgo` 分鐘前按了那一顆。這一刻是機器人在處理（按結束的是新開的 open、按交還的是 bot_handling）。
 * 放回待真人那支（假的）照真的規則：30 分鐘內、還沒用掉才放得回去，放回去後狀態變待真人、放手時間用掉。
 */
function released(by: 'close' | 'handback', minutesAgo: number) {
  let status: string = by === 'close' ? 'open' : 'bot_handling'
  let consumed = false
  const atMs = MSG_AT - minutesAgo * MIN
  vi.mocked(readHumanRelease).mockImplementation(async () => (consumed ? null : { atMs, by }))
  vi.mocked(getSessionStatusCached).mockImplementation(async () => status as any)
  vi.mocked(shouldSuppressInboundBotAutomationForSession).mockImplementation(async () => status === 'pending_human')
  vi.mocked(returnReleasedSessionToPending).mockImplementation(async (_s, _u, _w, opts) => {
    if (consumed || (opts.atMs ?? 0) - atMs >= opts.windowMs) return null
    consumed = true
    status = 'pending_human'
    return { by, afterMinutes: Math.floor(((opts.atMs ?? 0) - atMs) / MIN) }
  })
}

function aiWasAsked(): boolean {
  return vi.mocked(routeMessage).mock.calls.length + vi.mocked(answerWithAi).mock.calls.length > 0
}

beforeEach(() => {
  vi.clearAllMocks()
  // 走到 AI 的那幾個 case：AI 照常答一句（這支測試只在乎「有沒有問 AI」，不在乎答什麼）
  vi.mocked(answerWithAi).mockResolvedValue({
    decision: 'answered', answer: '不客氣！', confidence: 0.9, sources: [], handoffReason: null, answerKind: 'social',
  } as any)
  vi.mocked(readHumanRelease).mockResolvedValue(null)
  vi.mocked(getSessionStatusCached).mockResolvedValue('open' as any)
  vi.mocked(shouldSuppressInboundBotAutomationForSession).mockResolvedValue(false)
  vi.mocked(returnReleasedSessionToPending).mockResolvedValue(null)
})

describe('客服剛按結束／交還，客人 30 分鐘內接著講', () => {
  it('按「結束」3 分鐘後打字 → 放回待真人、收一句已收到、客服收通知（結束後 3 分鐘）；AI 不碰', async () => {
    const uid = 'U0000000000000000000000000000501'
    vi.mocked(getDb).mockReturnValue(makeDb(uid) as any)
    released('close', 3)

    await handleMessageEvent(textEvent(uid, '問題是當初訂的時候就沒有留信箱耶？'), { workspaceId: WS })

    expect(returnReleasedSessionToPending).toHaveBeenCalledTimes(1)
    expect(vi.mocked(returnReleasedSessionToPending).mock.calls[0]![3]).toMatchObject({ atMs: MSG_AT, windowMs: 30 * MIN })
    expect(sentTexts()).toEqual([expect.stringContaining(WAITING_ACK)])
    expect(vi.mocked(notifyHandoffToStaff).mock.calls[0]![0]).toMatchObject({
      customerLineUserId: uid,
      customerName: '測試客人',
      customerMessage: '問題是當初訂的時候就沒有留信箱耶？',
      reason: 'customer_returned_after_release',
      reasonLabel: '客人又來了（結束後 3 分鐘）',
    })
    expect(aiWasAsked()).toBe(false)
  })

  it('按「交還機器人」不到 1 分鐘後打字 → 一樣交給真人（通知講交還機器人後）', async () => {
    const uid = 'U0000000000000000000000000000502'
    vi.mocked(getDb).mockReturnValue(makeDb(uid) as any)
    released('handback', 0.5)

    await handleMessageEvent(textEvent(uid, '所以電腦還不能用是嗎'), { workspaceId: WS })

    expect(returnReleasedSessionToPending).toHaveBeenCalledTimes(1)
    expect(vi.mocked(notifyHandoffToStaff).mock.calls[0]![0]).toMatchObject({
      reasonLabel: '客人又來了（交還機器人後不到 1 分鐘）',
    })
    expect(aiWasAsked()).toBe(false)
  })

  it('傳圖 → 一樣交給真人（客服那邊寫 [圖片]）', async () => {
    const uid = 'U0000000000000000000000000000503'
    vi.mocked(getDb).mockReturnValue(makeDb(uid) as any)
    released('close', 5)

    await handleMessageEvent(mediaEvent(uid, 'image'), { workspaceId: WS })

    expect(returnReleasedSessionToPending).toHaveBeenCalledTimes(1)
    expect(sentTexts()).toEqual([expect.stringContaining(WAITING_ACK)])
    expect(vi.mocked(notifyHandoffToStaff).mock.calls[0]![0]).toMatchObject({ customerMessage: '[圖片]' })
  })

  it('先說「謝謝」→ 照舊交給 AI、不叫人；之後真的問了（還在 30 分鐘內）→ 交給真人', async () => {
    const uid = 'U0000000000000000000000000000504'
    vi.mocked(getDb).mockReturnValue(makeDb(uid) as any)
    released('close', 2)

    await handleMessageEvent(textEvent(uid, '好的謝謝'), { workspaceId: WS })
    expect(returnReleasedSessionToPending).not.toHaveBeenCalled()
    expect(notifyHandoffToStaff).not.toHaveBeenCalled()
    expect(aiWasAsked()).toBe(true)

    vi.mocked(routeMessage).mockClear()
    vi.mocked(answerWithAi).mockClear()
    await handleMessageEvent(textEvent(uid, '那發票怎麼寄給我', MSG_AT + MIN), { workspaceId: WS })
    expect(returnReleasedSessionToPending).toHaveBeenCalledTimes(1)
    expect(notifyHandoffToStaff).toHaveBeenCalledTimes(1)
    expect(aiWasAsked()).toBe(false)
  })

  it('只傳貼圖 → 不叫人、也不讀放手時間', async () => {
    const uid = 'U0000000000000000000000000000505'
    vi.mocked(getDb).mockReturnValue(makeDb(uid) as any)
    released('close', 2)

    await handleMessageEvent(mediaEvent(uid, 'sticker'), { workspaceId: WS })

    expect(readHumanRelease).not.toHaveBeenCalled()
    expect(returnReleasedSessionToPending).not.toHaveBeenCalled()
  })

  it('超過 30 分鐘 → 照舊交給 AI（連放回去那支都不用叫）', async () => {
    const uid = 'U0000000000000000000000000000506'
    vi.mocked(getDb).mockReturnValue(makeDb(uid) as any)
    released('close', 31)

    await handleMessageEvent(textEvent(uid, '請問還有貨嗎'), { workspaceId: WS })

    expect(returnReleasedSessionToPending).not.toHaveBeenCalled()
    expect(notifyHandoffToStaff).not.toHaveBeenCalled()
    expect(aiWasAsked()).toBe(true)
  })

  it('客服從沒放手過（或排程放的，沒有放手時間）→ 照舊交給 AI', async () => {
    const uid = 'U0000000000000000000000000000507'
    vi.mocked(getDb).mockReturnValue(makeDb(uid) as any)

    await handleMessageEvent(textEvent(uid, '請問還有貨嗎'), { workspaceId: WS })

    expect(readHumanRelease).toHaveBeenCalledTimes(1)
    expect(returnReleasedSessionToPending).not.toHaveBeenCalled()
    expect(aiWasAsked()).toBe(true)
  })

  it('讀放手時間失敗 → 當成沒放手，客人這一則照常交給 AI（不可以整則沒人處理）', async () => {
    const uid = 'U0000000000000000000000000000508'
    vi.mocked(getDb).mockReturnValue(makeDb(uid) as any)
    vi.mocked(readHumanRelease).mockRejectedValue(new Error('firestore 掛了'))

    await handleMessageEvent(textEvent(uid, '請問還有貨嗎'), { workspaceId: WS })

    expect(returnReleasedSessionToPending).not.toHaveBeenCalled()
    expect(aiWasAsked()).toBe(true)
  })

  it('同一刻進來兩則 → 只有一則叫人（放手時間用過就沒了）', async () => {
    const uid = 'U0000000000000000000000000000509'
    vi.mocked(getDb).mockReturnValue(makeDb(uid) as any)
    released('close', 1)

    await Promise.all([
      handleMessageEvent(textEvent(uid, '那發票呢'), { workspaceId: WS }),
      handleMessageEvent(textEvent(uid, '還有運費', MSG_AT + 1), { workspaceId: WS }),
    ])

    expect(notifyHandoffToStaff).toHaveBeenCalledTimes(1)
  })

  it('按「真人客服」→ 照舊轉真人那條（不走這裡）', async () => {
    const uid = 'U0000000000000000000000000000510'
    vi.mocked(getDb).mockReturnValue(makeDb(uid) as any)
    released('close', 1)

    await handlePostbackEvent(postbackEvent(uid, LIVE_MODULE), { workspaceId: WS })

    expect(returnReleasedSessionToPending).not.toHaveBeenCalled()
    expect(sentTexts().join('')).toContain('客服人員會很快聯絡您')
  })
})
