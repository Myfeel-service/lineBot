/**
 * 等真人期間「按選單／按鈕」的回饋（`H-19`）。
 *
 * 真實事件（2026-08-24 MYFEEL，正式資料查證）：客人 21:11:19 按「真人客服」，收到勿擾
 * 訊息後，21:11:27～21:12:08 的 41 秒內又按了 34 次（查訂單 30、真人客服 7、商品目錄 1），
 * **一則回覆都沒有**，隔天 10:49 才有客服開口。原因是轉真人之後機器人整場閉嘴，
 * 而按鈕這條路徑連「已收到」都沒接——同一位客人打字有回應、按按鈕像壞掉。
 *
 * ⛔ 這支測試真正要釘住的是第三個 case：安撫語的節流**不能跟轉真人那則共用**。
 *    共用的話，客人正好是在收到轉真人訊息之後才開始按的，34 次照樣全部靜音＝修了等於沒修。
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

import { handleMessageEvent, handlePostbackEvent } from './handler'
import { getDb } from './firebase'
import { replyMessage } from './line'
import { getSessionStatusCached, shouldSuppressInboundBotAutomationForSession } from './conversation-session'
import { getAiSettings } from './ai-settings'

const WS = 'ws-btn-ack'
const LIVE_MODULE = 'mod-live-agent'
const ORDER_MODULE = 'mod-order'

/** 這句話的關鍵字：客人真正需要知道的是「選單不會動」和「可以改用打字的」 */
const BTN_ACK_MENU = '選單暫時不會有回應'
const BTN_ACK_TYPE = '先把問題打在這裡'

function makeDb(lineUserId: string) {
  const conversations = new Map<string, Record<string, unknown>>()
  let autoId = 0
  const flows: Record<string, any> = {
    [LIVE_MODULE]: {
      workspaceId: WS, name: '真人客服', moduleType: 'live_agent', isActive: true,
      messages: [{ type: 'text', text: '謝謝您！我們的客服人員會很快聯絡您', buttons: [] }],
    },
    [ORDER_MODULE]: {
      workspaceId: WS, name: '✥客服 - 訂單問題模組', moduleType: 'bot_flow', isActive: true,
      messages: [{ type: 'text', text: '請提供您的訂單編號', buttons: [] }],
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
          doc: (msgId?: string) => ({ id: msgId ?? `auto-${++autoId}`, set: vi.fn(async () => {}) }),
        }),
      }),
    }),
  }
}

function postbackEvent(lineUserId: string, moduleId: string): any {
  return {
    type: 'postback',
    timestamp: 1700000000000,
    source: { type: 'user', userId: lineUserId },
    replyToken: `reply-${moduleId}`,
    postback: { data: `triggerModule=${moduleId}` },
  }
}

function textEvent(lineUserId: string, text: string, atMs: number): any {
  return {
    type: 'message',
    timestamp: atMs,
    source: { type: 'user', userId: lineUserId },
    replyToken: `reply-text-${atMs}`,
    message: { type: 'text', id: `msg-${atMs}`, text },
  }
}

function sentTexts(): string[] {
  return vi.mocked(replyMessage).mock.calls.flatMap(c =>
    (c[1] as any[]).map(m => String(m?.text ?? '')),
  )
}

/** 已轉真人、還沒有人接手（本次事件的所有自動回覆都被抑制） */
function nowWaitingForHuman() {
  vi.mocked(shouldSuppressInboundBotAutomationForSession).mockResolvedValue(true)
  vi.mocked(getSessionStatusCached).mockResolvedValue('pending_human' as any)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(shouldSuppressInboundBotAutomationForSession).mockResolvedValue(false)
  vi.mocked(getSessionStatusCached).mockResolvedValue('open' as any)
  vi.mocked(getAiSettings).mockResolvedValue({ enabled: true, replyMode: 'auto', sensitiveTopics: [] } as any)
})

describe('等真人期間按選單，客人不能一片空白', () => {
  it('按下去要收到一句話：排隊中＋選單不會動＋可以改用打字的', async () => {
    // ⛔ 每個 case 換一位客人：節流是 module 級的 Map（key = workspaceId:lineUserId），
    //    共用同一位會被前一個 case 蓋掉章，測出假的綠燈。
    const uid = 'U0000000000000000000000000000201'
    vi.mocked(getDb).mockReturnValue(makeDb(uid) as any)
    nowWaitingForHuman()

    await handlePostbackEvent(postbackEvent(uid, ORDER_MODULE), { workspaceId: WS })

    const texts = sentTexts()
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('已經幫您安排專員')
    expect(texts[0]).toContain(BTN_ACK_MENU)
    expect(texts[0]).toContain(BTN_ACK_TYPE)
    // 模組本身的內容仍然不送（機器人閉嘴這條原則沒被這次改動放寬，見 `D-30`）
    expect(texts.join('')).not.toContain('請提供您的訂單編號')
  })

  it('連按 34 次只發一則（實測就是 41 秒內 34 次，每次都回等於洗版）', async () => {
    const uid = 'U0000000000000000000000000000202'
    vi.mocked(getDb).mockReturnValue(makeDb(uid) as any)
    nowWaitingForHuman()

    for (let i = 0; i < 34; i++) {
      await handlePostbackEvent(postbackEvent(uid, ORDER_MODULE), { workspaceId: WS })
    }

    expect(sentTexts()).toHaveLength(1)
  })

  it('⛔ 剛收到轉真人那則之後按選單，照樣要回——節流不可以跟轉真人共用', async () => {
    // 這就是 8/24 的實際順序：先按「真人客服」收到一則，5 秒後開始按「訂單問題」。
    // 共用節流的話這個 case 會是 0 則，客人的體感和沒修一模一樣。
    const uid = 'U0000000000000000000000000000203'
    vi.mocked(getDb).mockReturnValue(makeDb(uid) as any)

    // ① 機器人服務中，按「真人客服」→ 送出轉真人那則（內部會蓋上「已安撫過」的章）
    await handlePostbackEvent(postbackEvent(uid, LIVE_MODULE), { workspaceId: WS })
    expect(sentTexts()).toContain('謝謝您！我們的客服人員會很快聯絡您')

    // ② 現在開始等真人，客人改按「訂單問題」
    nowWaitingForHuman()
    await handlePostbackEvent(postbackEvent(uid, ORDER_MODULE), { workspaceId: WS })

    expect(sentTexts().some(t => t.includes(BTN_ACK_MENU))).toBe(true)
  })

  it('真人正在對話中就不出聲：同事看得到「客人點了什麼」那一行，機器人插話像搶答', async () => {
    const uid = 'U0000000000000000000000000000204'
    vi.mocked(getDb).mockReturnValue(makeDb(uid) as any)
    vi.mocked(shouldSuppressInboundBotAutomationForSession).mockResolvedValue(true)
    vi.mocked(getSessionStatusCached).mockResolvedValue('human_handling' as any)

    await handlePostbackEvent(postbackEvent(uid, ORDER_MODULE), { workspaceId: WS })

    expect(sentTexts()).toHaveLength(0)
  })

  it('機器人服務中完全不受影響：照送模組內容，不多這一句', async () => {
    const uid = 'U0000000000000000000000000000205'
    vi.mocked(getDb).mockReturnValue(makeDb(uid) as any)

    await handlePostbackEvent(postbackEvent(uid, ORDER_MODULE), { workspaceId: WS })

    const texts = sentTexts()
    expect(texts).toContain('請提供您的訂單編號')
    expect(texts.some(t => t.includes(BTN_ACK_MENU))).toBe(false)
  })
})

describe('勿擾訊息要講清楚服務時間', () => {
  it('客人收到的那則後面帶「服務時間：週一至週五 10:00–19:00」', async () => {
    const uid = 'U0000000000000000000000000000206'
    vi.mocked(getDb).mockReturnValue(makeDb(uid) as any)
    vi.mocked(getAiSettings).mockResolvedValue({
      enabled: true, replyMode: 'auto', sensitiveTopics: [],
      serviceHours: {
        // 起訖同一分鐘會被判成「整天勿擾」但講不出時段；這裡要的是真的有時段又正在勿擾，
        // 所以用「週末整天休息」搭配固定的週六來製造，不受測試執行時間影響。
        enabled: true, start: '10:00', end: '19:00', weekendOff: true,
        dndReply: '您好,目前非客服服務時間,我們會在服務時間盡快回覆您 🙏',
      },
    } as any)
    vi.setSystemTime(new Date('2026-07-18T02:00:00Z')) // 台灣週六 10:00＝時段內但整天休息

    await handlePostbackEvent(postbackEvent(uid, LIVE_MODULE), { workspaceId: WS })

    const dnd = sentTexts().find(t => t.includes('目前非客服服務時間'))
    expect(dnd).toBeDefined()
    expect(dnd).toContain('服務時間：週一至週五 10:00–19:00')
    vi.useRealTimers()
  })

  it('店家自己已經寫了時間就不重複補（否則同一句話出現兩次時間）', async () => {
    const uid = 'U0000000000000000000000000000207'
    vi.mocked(getDb).mockReturnValue(makeDb(uid) as any)
    vi.mocked(getAiSettings).mockResolvedValue({
      enabled: true, replyMode: 'auto', sensitiveTopics: [],
      serviceHours: {
        enabled: true, start: '10:00', end: '19:00', weekendOff: true,
        dndReply: '您好,我們的服務時間是 10:00 到 19:00,會盡快回覆您 🙏',
      },
    } as any)
    vi.setSystemTime(new Date('2026-07-18T02:00:00Z'))

    await handlePostbackEvent(postbackEvent(uid, LIVE_MODULE), { workspaceId: WS })

    const dnd = sentTexts().find(t => t.includes('我們的服務時間是'))
    expect(dnd).toBeDefined()
    expect(dnd).not.toContain('服務時間：週一至週五')
    vi.useRealTimers()
  })
})

/**
 * 這一句話**自己叫客人去打字**（「您可以先把問題打在這裡」）。
 * 所以「按了按鈕→照做打字→又收到一則同義的安撫語」不是偶發，是必然——
 * 而那正是 markWaitingAckSent 當初被加出來要防的事（實測災情：兩句同義訊息隔一分鐘，
 * 客人以為前一次沒生效又按一次轉接，真人其實兩小時後才回）。
 */
describe('按鈕回饋與文字安撫語不可以連放兩則', () => {
  it('⛔ 按了按鈕收到回饋之後，客人照著打字不可以又收到「已收到您的訊息」', async () => {
    const uid = 'U0000000000000000000000000000208'
    vi.mocked(getDb).mockReturnValue(makeDb(uid) as any)
    nowWaitingForHuman()

    await handlePostbackEvent(postbackEvent(uid, ORDER_MODULE), { workspaceId: WS })
    expect(sentTexts().some(t => t.includes(BTN_ACK_TYPE))).toBe(true)

    await handleMessageEvent(textEvent(uid, '我想問訂單', Date.now()), { workspaceId: WS })

    expect(sentTexts().filter(t => t.includes('已收到您的訊息'))).toHaveLength(0)
  })

  it('反過來不擋：先打過字的人再按選單，仍要收到「選單不會動」（那是新資訊）', async () => {
    const uid = 'U0000000000000000000000000000209'
    vi.mocked(getDb).mockReturnValue(makeDb(uid) as any)
    nowWaitingForHuman()

    await handleMessageEvent(textEvent(uid, '請問好了嗎', Date.now()), { workspaceId: WS })
    expect(sentTexts().filter(t => t.includes('已收到您的訊息'))).toHaveLength(1)

    await handlePostbackEvent(postbackEvent(uid, ORDER_MODULE), { workspaceId: WS })

    expect(sentTexts().some(t => t.includes(BTN_ACK_MENU))).toBe(true)
  })
})
