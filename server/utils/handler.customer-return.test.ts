/**
 * 真人處理中、客服一陣子沒回，客人又來（`C-381`，老闆 2026-10-22「1. Ok」）。
 *
 * 以前這一刻是全靜音：AI 不回（真人還沒放手）、「已收到」只給待真人、LINE 通知只管待真人，
 * 客人再按「真人客服」也只記一行。MYFEEL 近 60 天 63 次，17 次一直沒人回。
 *
 * 要釘住的：
 *  - 打字／傳圖／再按「真人客服」→ 放回待真人、客人收一句、客服收通知（原因＝客人又來了）
 *  - 只回「好的謝謝」、只傳貼圖 → 照舊安靜（不叫人）
 *  - 客服剛回過話（放不回去）→ 照舊安靜
 *  - 下班時間 → 客人收到的是下班那句，不是「專員會盡快回覆」
 *  - ⛔ 不交回 AI：AI 一次都不會被叫到
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
  returnHumanSessionToPending: vi.fn(async () => false),
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
  returnHumanSessionToPending,
  shouldSuppressInboundBotAutomationForSession,
} from './conversation-session'
import { getAiSettings } from './ai-settings'
import { notifyHandoffToStaff } from './ai-handoff-notify'
import { answerWithAi, routeMessage } from './ai-answer'

const WS = 'ws-customer-return'
const LIVE_MODULE = 'mod-live-agent'
const WAITING_ACK = '已收到您的訊息，專員會盡快回覆您'
const BTN_ACK = '已經幫您安排專員'
const DND_REPLY = '目前非客服服務時間'

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
          doc: (msgId?: string) => ({ id: msgId ?? `auto-${++autoId}`, set: vi.fn(async () => {}) }),
        }),
      }),
    }),
  }
}

function textEvent(lineUserId: string, text: string): any {
  return {
    type: 'message',
    timestamp: 1_700_000_000_000,
    source: { type: 'user', userId: lineUserId },
    replyToken: `reply-text-${lineUserId}`,
    message: { type: 'text', id: `msg-${lineUserId}`, text },
  }
}

function mediaEvent(lineUserId: string, type: 'image' | 'sticker'): any {
  return {
    type: 'message',
    timestamp: 1_700_000_000_000,
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
    timestamp: 1_700_000_000_000,
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
 * 這位客人「真人處理中」：機器人閉嘴。放回待真人那支（假的）會把狀態改成待真人，
 * 跟真的一樣——之後送「已收到」那兩支看的就是這個狀態。
 * @param staffIdle false＝客服剛回過話，放不回去
 */
function humanHandling(staffIdle = true) {
  let status = 'human_handling'
  vi.mocked(shouldSuppressInboundBotAutomationForSession).mockResolvedValue(true)
  vi.mocked(getSessionStatusCached).mockImplementation(async () => status as any)
  vi.mocked(returnHumanSessionToPending).mockImplementation(async () => {
    if (!staffIdle || status !== 'human_handling') return false
    status = 'pending_human'
    return true
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(shouldSuppressInboundBotAutomationForSession).mockResolvedValue(false)
  vi.mocked(getSessionStatusCached).mockResolvedValue('open' as any)
  vi.mocked(returnHumanSessionToPending).mockResolvedValue(false)
  vi.mocked(getAiSettings).mockResolvedValue({ enabled: true, replyMode: 'auto', sensitiveTopics: [] } as any)
})

describe('真人處理中、客服一陣子沒回，客人又來', () => {
  it('打字 → 放回待真人、客人收一句已收到、客服收通知（原因＝客人又來了）；AI 不出聲', async () => {
    const uid = 'U0000000000000000000000000000301'
    vi.mocked(getDb).mockReturnValue(makeDb(uid) as any)
    humanHandling()

    await handleMessageEvent(textEvent(uid, '請問廠商有回覆了嗎'), { workspaceId: WS })

    expect(returnHumanSessionToPending).toHaveBeenCalledTimes(1)
    expect(vi.mocked(returnHumanSessionToPending).mock.calls[0]![3]).toMatchObject({ minStaffIdleMs: 30 * 60_000 })
    expect(sentTexts()).toEqual([expect.stringContaining(WAITING_ACK)])
    expect(notifyHandoffToStaff).toHaveBeenCalledTimes(1)
    expect(vi.mocked(notifyHandoffToStaff).mock.calls[0]![0]).toMatchObject({
      workspaceId: WS,
      customerLineUserId: uid,
      customerName: '測試客人',
      customerMessage: '請問廠商有回覆了嗎',
      reason: 'customer_returned',
    })
    expect(answerWithAi).not.toHaveBeenCalled()
    expect(routeMessage).not.toHaveBeenCalled()
  })

  it('又按一次「真人客服」→ 一樣叫人，客人收到按鈕那句（不重送模組、只回一則）', async () => {
    const uid = 'U0000000000000000000000000000302'
    vi.mocked(getDb).mockReturnValue(makeDb(uid) as any)
    humanHandling()

    await handlePostbackEvent(postbackEvent(uid, LIVE_MODULE), { workspaceId: WS })

    expect(returnHumanSessionToPending).toHaveBeenCalledTimes(1)
    const texts = sentTexts()
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain(BTN_ACK)
    expect(vi.mocked(notifyHandoffToStaff).mock.calls[0]![0]).toMatchObject({
      customerMessage: '（客人按了「真人客服」）',
      reason: 'customer_returned',
    })
  })

  it('傳圖 → 一樣叫人（客服那邊寫 [圖片]）', async () => {
    const uid = 'U0000000000000000000000000000303'
    vi.mocked(getDb).mockReturnValue(makeDb(uid) as any)
    humanHandling()

    await handleMessageEvent(mediaEvent(uid, 'image'), { workspaceId: WS })

    expect(returnHumanSessionToPending).toHaveBeenCalledTimes(1)
    expect(sentTexts()).toEqual([expect.stringContaining(WAITING_ACK)])
    expect(vi.mocked(notifyHandoffToStaff).mock.calls[0]![0]).toMatchObject({
      customerMessage: '[圖片]',
      reason: 'customer_returned',
    })
  })

  it.each([
    ['好的謝謝', '01'], ['了解，感謝！', '02'], ['謝謝您～～～', '03'], ['好', '04'], ['👍', '05'],
  ])('只回客套（%s）→ 照舊安靜：不放回、不回話、不叫人', async (text, n) => {
    // 每個 case 換一位客人：安撫語節流是 module 級的 Map
    const uid = `U00000000000000000000000000004${n}`
    vi.mocked(getDb).mockReturnValue(makeDb(uid) as any)
    humanHandling()

    await handleMessageEvent(textEvent(uid, text), { workspaceId: WS })

    expect(returnHumanSessionToPending).not.toHaveBeenCalled()
    expect(sentTexts()).toHaveLength(0)
    expect(notifyHandoffToStaff).not.toHaveBeenCalled()
  })

  it('只傳貼圖 → 不叫人（`D-4`：只傳貼圖不算開口）', async () => {
    const uid = 'U0000000000000000000000000000305'
    vi.mocked(getDb).mockReturnValue(makeDb(uid) as any)
    humanHandling()

    await handleMessageEvent(mediaEvent(uid, 'sticker'), { workspaceId: WS })

    expect(returnHumanSessionToPending).not.toHaveBeenCalled()
    expect(notifyHandoffToStaff).not.toHaveBeenCalled()
  })

  it('客服剛回過話（放不回去）→ 跟以前一樣安靜：不回話、不叫人', async () => {
    const uid = 'U0000000000000000000000000000306'
    vi.mocked(getDb).mockReturnValue(makeDb(uid) as any)
    humanHandling(false)

    await handleMessageEvent(textEvent(uid, '那運費呢'), { workspaceId: WS })

    expect(returnHumanSessionToPending).toHaveBeenCalledTimes(1)
    expect(sentTexts()).toHaveLength(0)
    expect(notifyHandoffToStaff).not.toHaveBeenCalled()
  })

  it('本來就在待真人 → 不走這條（照舊只給等待中的那句）', async () => {
    const uid = 'U0000000000000000000000000000307'
    vi.mocked(getDb).mockReturnValue(makeDb(uid) as any)
    vi.mocked(shouldSuppressInboundBotAutomationForSession).mockResolvedValue(true)
    vi.mocked(getSessionStatusCached).mockResolvedValue('pending_human' as any)

    await handleMessageEvent(textEvent(uid, '有人在嗎'), { workspaceId: WS })

    expect(returnHumanSessionToPending).not.toHaveBeenCalled()
    expect(notifyHandoffToStaff).not.toHaveBeenCalled()
    expect(sentTexts()).toEqual([expect.stringContaining(WAITING_ACK)])
  })

  it('機器人在處理的客人 → 完全不碰這條', async () => {
    const uid = 'U0000000000000000000000000000308'
    vi.mocked(getDb).mockReturnValue(makeDb(uid) as any)

    await handleMessageEvent(mediaEvent(uid, 'image'), { workspaceId: WS })

    expect(returnHumanSessionToPending).not.toHaveBeenCalled()
  })

  it('下班時間 → 客人收到的是下班那句（不是「專員會盡快回覆」），而且只有一則', async () => {
    const uid = 'U0000000000000000000000000000309'
    vi.mocked(getDb).mockReturnValue(makeDb(uid) as any)
    humanHandling()
    vi.mocked(getAiSettings).mockResolvedValue({
      enabled: true, replyMode: 'auto', sensitiveTopics: [],
      // start === end → 一天 24 小時都算勿擾
      serviceHours: { enabled: true, start: '00:00', end: '00:00', weekendOff: false, dndReply: '' },
    } as any)

    await handleMessageEvent(textEvent(uid, '請問廠商有回覆了嗎'), { workspaceId: WS })

    const texts = sentTexts()
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain(DND_REPLY)
    expect(texts[0]).not.toContain(WAITING_ACK)
    // 通知照樣交給通知函式（勿擾時段由它自己決定不傳、之後逾時提醒補）
    expect(notifyHandoffToStaff).toHaveBeenCalledTimes(1)
  })
})
