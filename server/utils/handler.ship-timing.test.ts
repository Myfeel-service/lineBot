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

/** 對話裡已經有的訊息（新的在前，跟 orderBy('timestamp','desc') 讀回來的順序一樣） */
let seededMessages: Array<Record<string, unknown>> = []

function makeDb() {
  const subCollection = () => ({
    doc: (docId?: string) => ({
      id: docId ?? 'auto',
      get: vi.fn(async () => ({ exists: false, data: () => undefined })),
      set: vi.fn(async () => {}),
    }),
    orderBy: () => ({
      limit: (n: number) => ({ get: vi.fn(async () => ({ docs: seededMessages.slice(0, n).map(m => ({ data: () => m })) })) }),
    }),
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

/**
 * 跟正式站「查詢訂單」同形：問編號。開始方式用「客人打特定的字」確定觸發——
 * 這支測的是「出貨題要不要繞過流程」，不是比對（正式站那條是「看意思」，`C-370` 後靠 AI 判斷）。
 */
const ORDER_SCRIPT = {
  id: 'script-order', workspaceId: WS, name: '查詢訂單', enabled: true, priority: 50, rootNodeId: 't',
  nodes: [
    { id: 't', type: 'trigger', matchMode: 'keyword', keywords: ['訂單', '查詢', '進度'], examples: [], priority: 50, next: 'c1' },
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
  seededMessages = []
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

  it('一個詞對到好幾台（「咖啡機」）→ 照舊進流程，AI 也不會挑一台答', async () => {
    vi.mocked(productsInConversation).mockResolvedValue({ products: new Set(['小滑手', 'ibarista']), from: 'query' })

    await handleMessageEvent(textEvent('咖啡機訂單編號M20261011191817ADNO 請問什麼時候會出貨，謝謝'), { workspaceId: WS })

    expect(vi.mocked(answerWithAi)).not.toHaveBeenCalled()
    expect(vi.mocked(startScript)).toHaveBeenCalledTimes(1)
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

/**
 * `C-344`：客人點過的按鈕要交給「認商品」那份、⛔ 不能進給 AI 讀的那份。
 * 2026-10-12 那場：按鈕在 10/9，到 10/12 的提問中間隔了 7 則——原本只讀 8 則、又把按鈕濾掉，AI 看不到。
 */
describe('對話脈絡：按鈕紀錄只拿來認商品', () => {
  /** 10/12 23:22 那一刻往回的訊息（新的在前），照正式站那場排 */
  function seed10_12() {
    seededMessages = [
      { direction: 'incoming', messageType: 'text', text: '我的會什麼時候出貨' },
      { direction: 'outgoing', messageType: 'text', sender: 'human', text: '您好，廠商公告是於 10 月底 依照訂單順序陸續出貨喔' },
      { direction: 'outgoing', messageType: 'text', sender: 'system', text: '您好,目前為雙十節連休,非客服服務時間' },
      { direction: 'incoming', messageType: 'text', text: 'M20261007002452KOYK' },
      { direction: 'outgoing', messageType: 'text', sender: 'bot', text: '您好,請問您的訂單編號是？' },
      { direction: 'incoming', messageType: 'text', text: 'M20261007002452KOYK訂單編號' },
      { direction: 'outgoing', messageType: 'text', sender: 'bot', text: '白您好， 依原廠公告： 商品將於 10 月底 依照訂單順序陸續出貨' },
      { direction: 'outgoing', messageType: 'image', sender: 'bot', text: '[圖片]' },
      { direction: 'incoming', messageType: 'customer_action', text: '客人點了「客服 - 出貨進度查詢 - 電淨艙 奇美 靜電集塵空氣清淨機 AP-08SPFG」' },
    ]
  }

  it('按鈕在第 9 則以前也讀得到，交給認商品那份；給 AI 讀的那份沒有它', async () => {
    seed10_12()
    vi.mocked(loadActiveScripts).mockResolvedValue([])

    await handleMessageEvent(textEvent('我的會什麼時候出貨'), { workspaceId: WS })

    const input = vi.mocked(answerWithAi).mock.calls[0]![0]
    expect(input.productHistory?.map(t => t.text).join('\n')).toContain('客人點了「客服 - 出貨進度查詢 - 電淨艙')
    expect(input.history?.map(t => t.text).join('\n')).not.toContain('客人點了')
    // 兩份都不含這一句（它是 query 本身）
    expect(input.history?.at(-1)?.text).not.toBe('我的會什麼時候出貨')
    expect(input.productHistory?.at(-1)?.text).not.toBe('我的會什麼時候出貨')
  })

  it('誰講的跟著帶（轉真人摘要要分得出 AI 說過、真人告知過）', async () => {
    seed10_12()
    vi.mocked(loadActiveScripts).mockResolvedValue([])

    await handleMessageEvent(textEvent('我的會什麼時候出貨'), { workspaceId: WS })

    const input = vi.mocked(answerWithAi).mock.calls[0]![0]
    expect(input.history?.find(t => t.text.startsWith('您好，廠商公告'))?.speaker).toBe('human')
    expect(input.history?.find(t => t.text === 'M20261007002452KOYK')?.speaker).toBeUndefined()
  })

  it('跳過「查詢訂單」流程的判斷也看得到按鈕：句子沒寫商品、但點過電淨艙 → 交給 AI', async () => {
    seed10_12()
    vi.mocked(productsInConversation).mockImplementation(async (_w, _t, h) =>
      (h ?? []).some(t => t.text.includes('電淨艙')) ? { products: new Set(['chimei 電淨艙']), from: 'history' } : null)

    await handleMessageEvent(textEvent('請問我的訂單什麼時候出貨'), { workspaceId: WS })

    expect(vi.mocked(startScript)).not.toHaveBeenCalled()
    expect(vi.mocked(answerWithAi)).toHaveBeenCalledTimes(1)
  })
})

/**
 * `C-4`：AI 讀的對話有時間上限（給 AI 讀 72 小時、認商品 7 天、加好友／活動登記帶出來的推播 72 小時）。
 * 以前只看則數：10/16 客人問「我為何 9/3 買是 22900？」，產品鎖認到 65 天前的「乾淨方MAX 開賣通知」，轉真人。
 */
describe('對話脈絡有時間上限（C-4）', () => {
  const at = (msAgo: number) => ({ toMillis: () => Date.now() - msAgo })
  const H = 60 * 60 * 1000
  const D = 24 * H

  it('65 天前的開賣通知：認商品那份、給 AI 讀那份都沒有它', async () => {
    seededMessages = [
      { direction: 'incoming', messageType: 'text', text: '我為何9/3買是22900？', timestamp: at(0) },
      { direction: 'outgoing', messageType: 'text', sender: 'bot', text: 'Hi 恭喜你成功啟動專屬開賣通知！ SHARP 最新機種《乾淨方MAX》', timestamp: at(65 * D) },
      { direction: 'incoming', messageType: 'customer_action', text: '客人從活動「乾淨方max問卷」登記', payload: { actionType: 'campaign_claim' }, timestamp: at(65 * D + 500) },
      { direction: 'outgoing', messageType: 'image', sender: 'bot', text: '[圖片]', timestamp: at(65 * D + 1000) },
      { direction: 'incoming', messageType: 'customer_action', text: '客人加入好友', payload: { actionType: 'follow' }, timestamp: at(65 * D + 2000) },
    ]
    vi.mocked(loadActiveScripts).mockResolvedValue([])

    await handleMessageEvent(textEvent('我為何9/3買是22900？'), { workspaceId: WS })

    const input = vi.mocked(answerWithAi).mock.calls[0]![0]
    expect(input.productHistory).toEqual([])
    expect(input.history).toEqual([])
  })

  it('C-344 那場（按鈕在 3 天多前）：認商品看得到按鈕；給 AI 讀的只剩 72 小時內', async () => {
    seededMessages = [
      { direction: 'incoming', messageType: 'text', text: '我的會什麼時候出貨', timestamp: at(0) },
      { direction: 'outgoing', messageType: 'text', sender: 'human', text: '您好，廠商公告是於 10 月底 依照訂單順序陸續出貨喔', timestamp: at(10 * H) },
      { direction: 'outgoing', messageType: 'text', sender: 'system', text: '您好,目前為雙十節連休,非客服服務時間', timestamp: at(3.5 * D) },
      { direction: 'incoming', messageType: 'text', text: 'M20261007002452KOYK', timestamp: at(3.5 * D + 1000) },
      { direction: 'outgoing', messageType: 'text', sender: 'bot', text: '白您好， 依原廠公告： 商品將於 10 月底 依照訂單順序陸續出貨', timestamp: at(3.5 * D + 60_000) },
      { direction: 'incoming', messageType: 'customer_action', text: '客人點了「客服 - 出貨進度查詢 - 電淨艙 奇美 靜電集塵空氣清淨機 AP-08SPFG」', payload: { actionType: 'button_module' }, timestamp: at(3.5 * D + 62_000) },
    ]
    vi.mocked(loadActiveScripts).mockResolvedValue([])

    await handleMessageEvent(textEvent('我的會什麼時候出貨'), { workspaceId: WS })

    const input = vi.mocked(answerWithAi).mock.calls[0]![0]
    expect(input.productHistory?.map(t => t.text).join('\n')).toContain('出貨進度查詢 - 電淨艙')
    expect(input.history?.map(t => t.text)).toEqual(['您好，廠商公告是於 10 月底 依照訂單順序陸續出貨喔'])
  })

  it('8 天前點過的按鈕不拿來認商品（7 天以上）', async () => {
    seededMessages = [
      { direction: 'incoming', messageType: 'text', text: '我的會什麼時候出貨', timestamp: at(0) },
      { direction: 'incoming', messageType: 'customer_action', text: '客人點了「客服 - 出貨進度查詢 - 電淨艙」', payload: { actionType: 'button_module' }, timestamp: at(8 * D) },
    ]
    vi.mocked(loadActiveScripts).mockResolvedValue([])

    await handleMessageEvent(textEvent('我的會什麼時候出貨'), { workspaceId: WS })

    expect(vi.mocked(answerWithAi).mock.calls[0]![0].productHistory).toEqual([])
  })

  it('跳過流程的判斷吃同一把尺：65 天前的開賣通知不能讓「何時出貨」繞過流程', async () => {
    seededMessages = [
      { direction: 'incoming', messageType: 'text', text: '請問我的訂單什麼時候出貨', timestamp: at(0) },
      { direction: 'outgoing', messageType: 'text', sender: 'bot', text: '恭喜你成功啟動專屬開賣通知！奇美《電淨艙》', timestamp: at(65 * D) },
      { direction: 'incoming', messageType: 'customer_action', text: '客人從活動「電淨艙問卷」登記', payload: { actionType: 'campaign_claim' }, timestamp: at(65 * D + 500) },
    ]
    vi.mocked(productsInConversation).mockImplementation(async (_w, _t, h) =>
      (h ?? []).some(t => t.text.includes('電淨艙')) ? { products: new Set(['chimei 電淨艙']), from: 'history' } : null)

    await handleMessageEvent(textEvent('請問我的訂單什麼時候出貨'), { workspaceId: WS })

    expect(vi.mocked(answerWithAi)).not.toHaveBeenCalled()
    expect(vi.mocked(startScript)).toHaveBeenCalledTimes(1)
  })
})
