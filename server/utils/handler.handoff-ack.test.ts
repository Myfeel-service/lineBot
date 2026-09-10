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
vi.mock('./conversation-media', () => ({ archiveConversationMedia: vi.fn(async () => ({ ok: false })) }))
vi.mock('./media-describe', () => ({ readInboundImage: vi.fn(async () => ({ description: '', question: '' })) }))

import { handleMessageEvent, handlePostbackEvent } from './handler'
import { getDb } from './firebase'
import { replyMessage } from './line'
import { getSessionStatusCached, shouldSuppressInboundBotAutomationForSession, enterModule } from './conversation-session'
import { notifyHandoffToStaff } from './ai-handoff-notify'
import { getAiSettings } from './ai-settings'
import { loadActiveScripts, startScript } from './ai-scripts'
import { answerWithAi } from './ai-answer'

// 走 AI 那條路的案例要一份「欄位齊全」的設定（反問 cooldown 等都會被讀到），
// 自己拼容易漏欄位、也會跟真實預設漂掉 → 用真的正規化函式造（./ai-settings 本身被 mock 掉了）
const { normalizeAiSettings } = await vi.importActual<typeof import('./ai-settings')>('./ai-settings')

/** 服務時間內、AI 全自動（clearAllMocks 不會還原 mockResolvedValue，逐個 describe 自己設回來） */
const AI_SETTINGS_DEFAULT = { enabled: true, replyMode: 'auto', sensitiveTopics: [] }

const WS = 'ws-ack'

function makeDb(lineUserId: string, opts: { workspaceId?: string; flows?: Record<string, any> } = {}) {
  const ws = opts.workspaceId ?? WS
  const flows = opts.flows ?? {}
  const conversations = new Map<string, Record<string, unknown>>()
  let autoId = 0
  const userDoc = {
    exists: true,
    data: () => ({ workspaceId: ws, lineUserId, displayName: '測試客人', isBlocked: false }),
  }
  const db = {
    collection: (col: string) => ({
      where: () => ({ get: vi.fn(async () => ({ empty: true, docs: [] })) }),
      doc: (id?: string) => ({
        get: vi.fn(async () => {
          if (col === 'users') return userDoc
          if (col === 'flows' && flows[String(id)]) {
            return { exists: true, data: () => flows[String(id)] }
          }
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
          // 走 AI 那條路時會往回讀最近訊息當上下文（loadAiConvoContext）；這些案例不需要歷史
          orderBy: () => ({ limit: () => ({ get: vi.fn(async () => ({ empty: true, docs: [] })) }) }),
        }),
      }),
    }),
  }
  return db
}

function textEvent(lineUserId: string, text: string, atMs: number): any {
  return {
    type: 'message',
    timestamp: atMs,
    source: { type: 'user', userId: lineUserId },
    replyToken: `reply-${atMs}`,
    message: { type: 'text', id: `msg-${atMs}`, text },
  }
}

/** 這位客人收到的所有出站文字 */
function sentTexts(): string[] {
  return vi.mocked(replyMessage).mock.calls.flatMap(c =>
    (c[1] as any[]).map(m => String(m?.text ?? '')),
  )
}

/** 切成「已轉真人、等專員回覆」的狀態（下一則訊息所有自動回覆都會被抑制） */
function nowWaitingForHuman() {
  vi.mocked(shouldSuppressInboundBotAutomationForSession).mockResolvedValue(true)
  vi.mocked(getSessionStatusCached).mockResolvedValue('pending_human' as any)
}

/**
 * 實測災情：09:35 客人收到「已為您安排專員，將盡快回覆您」，09:36 又收到
 * 「已收到您的訊息，專員會盡快回覆您」——同一件事講兩次，客人以為前一次沒生效
 * 又再按一次轉接，而真人其實 2 小時後才回。兩句安撫語要吃同一份節流。
 */
describe('轉真人的安撫語只講一次', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(shouldSuppressInboundBotAutomationForSession).mockResolvedValue(false)
    vi.mocked(getSessionStatusCached).mockResolvedValue('open' as any)
  })

  it('剛回過「已為您安排專員」，客人再講話不會又收到「已收到您的訊息」', async () => {
    const uid = 'U0000000000000000000000000000101'
    vi.mocked(getDb).mockReturnValue(makeDb(uid) as any)

    const now = Date.now()
    await handleMessageEvent(textEvent(uid, '找真人', now), { workspaceId: WS })
    expect(sentTexts().some(t => t.includes('已為您安排專員'))).toBe(true)

    nowWaitingForHuman()
    await handleMessageEvent(textEvent(uid, '麻煩快一點', now + 30_000), { workspaceId: WS })

    expect(sentTexts().filter(t => t.includes('已收到您的訊息'))).toHaveLength(0)
  })

  it('沒有剛承諾過的客人，等待期間仍會收到一次「已收到您的訊息」（別把安撫語整個關掉）', async () => {
    const uid = 'U0000000000000000000000000000102'
    vi.mocked(getDb).mockReturnValue(makeDb(uid) as any)

    nowWaitingForHuman()
    await handleMessageEvent(textEvent(uid, '請問處理了嗎', Date.now()), { workspaceId: WS })

    expect(sentTexts().filter(t => t.includes('已收到您的訊息'))).toHaveLength(1)
  })
})

/**
 * 實測災情：店家在後台「真人客服」模組寫了自己的文案（「謝謝您！我們的客服人員會很快聯絡您」），
 * 客人轉真人時收到的卻一直是程式寫死的「已為您安排專員」——因為查流程用的是模組種類代號
 * 'sys_live_agent' 而不是這個工作區的文件 id（{workspaceId}_live_agent），永遠查不到。
 */
describe('轉真人的回覆要用店家自己設的文案', () => {
  const WS2 = 'ws-liveagent'

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(shouldSuppressInboundBotAutomationForSession).mockResolvedValue(false)
    vi.mocked(getSessionStatusCached).mockResolvedValue('open' as any)
  })

  it('店家設了文案 → 送店家的那句，不是預設值', async () => {
    const uid = 'U0000000000000000000000000000103'
    vi.mocked(getDb).mockReturnValue(makeDb(uid, {
      workspaceId: WS2,
      flows: {
        [`${WS2}_live_agent`]: {
          workspaceId: WS2,
          name: '真人客服',
          moduleType: 'live_agent',
          isActive: true,
          messages: [{ type: 'text', text: '謝謝您！我們的客服人員會很快聯絡您', buttons: [] }],
        },
      },
    }) as any)

    await handleMessageEvent(textEvent(uid, '找真人', Date.now()), { workspaceId: WS2 })

    expect(sentTexts()).toContain('謝謝您！我們的客服人員會很快聯絡您')
    expect(sentTexts().some(t => t.includes('已為您安排專員'))).toBe(false)
  })

  it('店家沒設文案（messages 空）→ 仍要有預設值兜底，不能靜默', async () => {
    const uid = 'U0000000000000000000000000000104'
    const WS3 = 'ws-liveagent-empty'
    vi.mocked(getDb).mockReturnValue(makeDb(uid, {
      workspaceId: WS3,
      flows: {
        [`${WS3}_live_agent`]: {
          workspaceId: WS3, name: '真人客服', moduleType: 'live_agent', isActive: true, messages: [],
        },
      },
    }) as any)

    await handleMessageEvent(textEvent(uid, '找真人', Date.now()), { workspaceId: WS3 })

    expect(sentTexts().some(t => t.includes('已為您安排專員'))).toBe(true)
  })
})

/**
 * 2026-09-10 實例：客人問「請問下訂後多久會收到？」，AI 完整答出出貨時程之後，
 * 下一則緊接著「您好,目前非客服服務時間…」——讀起來像在說前面那句不算數。
 * 兩則都沒錯，錯在中間沒有話把它們接起來。
 */
describe('勿擾時段：AI 已經先答了一般規則時要接一句', () => {
  const WS_DND = 'ws-dnd-order'

  /** start===end ＝沒有任何一分鐘落在服務時間內，測試不受執行時間影響 */
  function allDayDnd() {
    vi.mocked(getAiSettings).mockResolvedValue(normalizeAiSettings({
      enabled: true,
      replyMode: 'auto',
      systemPrompt: '你是客服',
      shopUrl: '',
      serviceHours: { enabled: true, start: '09:00', end: '09:00', dndReply: '目前非客服服務時間，我們會在服務時間盡快回覆您 🙏' },
    }) as any)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(shouldSuppressInboundBotAutomationForSession).mockResolvedValue(false)
    vi.mocked(getSessionStatusCached).mockResolvedValue('open' as any)
    vi.mocked(loadActiveScripts).mockResolvedValue([])
    allDayDnd()
  })

  it('AI 給了規則 → 勿擾那則前面補一句銜接', async () => {
    const uid = 'U0000000000000000000000000000110'
    vi.mocked(getDb).mockReturnValue(makeDb(uid, { workspaceId: WS_DND }) as any)
    vi.mocked(answerWithAi).mockResolvedValue({
      decision: 'handoff',
      answer: '一般是訂單成立後 3～5 個工作日出貨喔。',
      confidence: 0.8,
      sources: [],
      handoffReason: 'order_status',
    } as any)

    await handleMessageEvent(textEvent(uid, '我的訂單到哪了', Date.now()), { workspaceId: WS_DND })

    // 規則本身照樣先送（勿擾不影響它）
    expect(sentTexts()).toContain('一般是訂單成立後 3～5 個工作日出貨喔。')
    const dnd = sentTexts().find(t => t.includes('非客服服務時間'))
    expect(dnd).toContain('以上是一般的說明')
    expect(dnd).toContain('要請專員幫您查')
  })

  it('知識庫連規則都沒有（answer 空）→ 不加那句（沒有「以上」可指，會變空話）', async () => {
    const uid = 'U0000000000000000000000000000111'
    vi.mocked(getDb).mockReturnValue(makeDb(uid, { workspaceId: WS_DND }) as any)
    vi.mocked(answerWithAi).mockResolvedValue({
      decision: 'handoff',
      answer: '',
      confidence: 0.2,
      sources: [],
      // 仍用 order_status：low_confidence 會先走「要不要幫您轉接」的二次確認，走不到這裡
      handoffReason: 'order_status',
    } as any)

    await handleMessageEvent(textEvent(uid, '我的訂單到哪了', Date.now()), { workspaceId: WS_DND })

    const dnd = sentTexts().find(t => t.includes('非客服服務時間'))
    expect(dnd).toBeTruthy()
    expect(dnd).not.toContain('以上是一般的說明')
  })
})

/**
 * 實測災情：客人在圖文選單按了「真人客服」，收到「謝謝您！我們的客服人員會很快聯絡您」，
 * 但**沒有任何客服被通知**——這條路只回訊息、標狀態，漏了通知。客人問到第三次、
 * 走到 AI 的二次確認才真的排進佇列。老闆的口徑：機器人裡的轉真人都要真的轉真人。
 */
describe('機器人裡按到「真人客服」模組＝真的轉真人', () => {
  const WS4 = 'ws-menu-handoff'
  const MODULE_ID = `${WS4}_live_agent`

  function postbackEvent(lineUserId: string, moduleId: string): any {
    return {
      type: 'postback',
      timestamp: Date.now(),
      source: { type: 'user', userId: lineUserId },
      replyToken: 'reply-postback',
      postback: { data: `triggerModule=${moduleId}` },
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(shouldSuppressInboundBotAutomationForSession).mockResolvedValue(false)
    vi.mocked(getSessionStatusCached).mockResolvedValue('open' as any)
    vi.mocked(getAiSettings).mockResolvedValue(AI_SETTINGS_DEFAULT as any)
  })

  it('按下去 → 送店家文案、標記轉真人、而且通知值班客服', async () => {
    const uid = 'U0000000000000000000000000000105'
    vi.mocked(getDb).mockReturnValue(makeDb(uid, {
      workspaceId: WS4,
      flows: {
        [MODULE_ID]: {
          workspaceId: WS4, name: '真人客服', moduleType: 'live_agent', isActive: true,
          messages: [{ type: 'text', text: '謝謝您！我們的客服人員會很快聯絡您', buttons: [] }],
        },
      },
    }) as any)

    await handlePostbackEvent(postbackEvent(uid, MODULE_ID), { workspaceId: WS4 })

    expect(sentTexts()).toContain('謝謝您！我們的客服人員會很快聯絡您')
    // 狀態：進 live_agent（＝待真人、排進佇列）
    expect(vi.mocked(enterModule).mock.calls.some(c => c[2] === 'live_agent')).toBe(true)
    // 最重要的那一步：值班客服要知道有人在等
    expect(vi.mocked(notifyHandoffToStaff)).toHaveBeenCalledWith(
      expect.objectContaining({ customerLineUserId: uid }),
    )
  })

  it('一般機器人流程不會誤觸通知（只有真人客服模組才通知）', async () => {
    const uid = 'U0000000000000000000000000000106'
    const BOT_MODULE = 'some-bot-flow'
    vi.mocked(getDb).mockReturnValue(makeDb(uid, {
      workspaceId: WS4,
      flows: {
        [BOT_MODULE]: {
          workspaceId: WS4, name: '常見問題', moduleType: 'bot_flow', isActive: true,
          messages: [{ type: 'text', text: '這是常見問題', buttons: [] }],
        },
      },
    }) as any)

    await handlePostbackEvent(postbackEvent(uid, BOT_MODULE), { workspaceId: WS4 })

    expect(sentTexts()).toContain('這是常見問題')
    expect(vi.mocked(notifyHandoffToStaff)).not.toHaveBeenCalled()
  })

  /**
   * 勿擾時段的口徑：AI 轉真人會改口說「目前非服務時間」，但按圖文選單這條先前沒做，
   * 客人半夜按下去照樣收到「客服人員會很快聯絡您」然後整夜沒人——同一家店兩種說法。
   * 兩條路現在共用 dndHandoffReplyText。
   */
  it('勿擾時段按下去 → 改送勿擾訊息，不再承諾「很快聯絡您」', async () => {
    const uid = 'U0000000000000000000000000000107'
    vi.mocked(getAiSettings).mockResolvedValue({
      enabled: true, replyMode: 'auto', sensitiveTopics: [],
      // start===end ＝ 沒有任何一分鐘落在服務時間內 → 整天勿擾，測試不受執行時間影響
      serviceHours: { enabled: true, start: '09:00', end: '09:00', dndReply: '目前非服務時間，明天 9 點後回覆您' },
    } as any)
    vi.mocked(getDb).mockReturnValue(makeDb(uid, {
      workspaceId: WS4,
      flows: {
        [MODULE_ID]: {
          workspaceId: WS4, name: '真人客服', moduleType: 'live_agent', isActive: true,
          messages: [{ type: 'text', text: '謝謝您！我們的客服人員會很快聯絡您', buttons: [] }],
        },
      },
    }) as any)

    await handlePostbackEvent(postbackEvent(uid, MODULE_ID), { workspaceId: WS4 })

    expect(sentTexts()).toContain('目前非服務時間，明天 9 點後回覆您')
    expect(sentTexts()).not.toContain('謝謝您！我們的客服人員會很快聯絡您')
    // 轉真人本身照常發生：客人仍要排進佇列，只是不承諾「馬上有人」
    expect(vi.mocked(enterModule).mock.calls.some(c => c[2] === 'live_agent')).toBe(true)
  })
})

/**
 * 腳本結尾 thenHandoff=true 這條路先前傳的是空的 customerMessage，客服收到的通知只有
 * 「🙋 真人客服請求／原因：腳本轉真人」——不知道客人問了什麼，等於還要自己去後台翻。
 * 現在與其他入口一樣走 commitHandoff，帶上觸發腳本的那句話。
 */
describe('腳本結尾轉真人的通知要帶客人講了什麼', () => {
  const WS5 = 'ws-script-handoff'

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(shouldSuppressInboundBotAutomationForSession).mockResolvedValue(false)
    vi.mocked(getSessionStatusCached).mockResolvedValue('open' as any)
    vi.mocked(getAiSettings).mockResolvedValue(AI_SETTINGS_DEFAULT as any)
    vi.mocked(loadActiveScripts).mockResolvedValue([{
      id: 'script-1', name: '退貨', enabled: true, rootNodeId: 'n1',
      nodes: [{ id: 'n1', type: 'trigger', keywords: ['退貨'] }],
    }] as any)
    vi.mocked(startScript).mockResolvedValue({
      replyText: '我幫您轉給專員處理退貨',
      finished: true,
      thenHandoff: true,
      quickReplies: [],
    } as any)
  })

  it('腳本跑完轉真人 → 通知帶原始訊息、session 標記 live_agent', async () => {
    const uid = 'U0000000000000000000000000000108'
    vi.mocked(getDb).mockReturnValue(makeDb(uid, { workspaceId: WS5 }) as any)

    await handleMessageEvent(textEvent(uid, '我要退貨', Date.now()), { workspaceId: WS5 })

    // 先確定走的真的是腳本這條路（而不是掉到 AI fallback 也剛好通知了）
    expect(sentTexts()).toContain('我幫您轉給專員處理退貨')
    expect(vi.mocked(notifyHandoffToStaff)).toHaveBeenCalledWith(
      expect.objectContaining({ customerLineUserId: uid, customerMessage: '我要退貨' }),
    )
    expect(vi.mocked(enterModule).mock.calls.some(c => c[2] === 'live_agent')).toBe(true)
  })
})
