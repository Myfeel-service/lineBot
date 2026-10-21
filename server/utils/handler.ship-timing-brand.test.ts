/**
 * 「要不要繞過『查詢訂單』流程」那一步（handler 的 shipTimingGoesToAi）跟 AI 答題認商品是**同一個函式**
 * （productsInConversation）——這支用真的那一支、配 MYFEEL 正式的商品名／別名，證明 handler 那個呼叫點拿到一台。
 *
 * 2026-10-19 正式站 11:01：「SHARP「乾淨方MAX」…何時會安排出貨」——以前「SHARP」四台＋「除濕機」三台被聯集成 6 台，
 * 句子裡要是寫了「訂單」，就會被「查詢訂單」流程攔去再問一次編號、然後轉真人。
 * 其他整條分流（草稿模式、看不出商品、要取消…）在 handler.ship-timing.test.ts。
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
// ⭐ 認商品用真的（productsInConversation）；答題、路由、摘要換成假的
vi.mock('./ai-answer', async importOriginal => ({
  ...(await importOriginal<typeof import('./ai-answer')>()),
  answerWithAi: vi.fn(),
  routeMessage: vi.fn(async () => null),
  summarizeHandoffContext: vi.fn(async () => ''),
}))
// 商品名、別名（productsInConversation 讀的兩份）換成 MYFEEL 正式資料，其餘照真的
vi.mock('./ai-knowledge-chunks', async importOriginal => ({
  ...(await importOriginal<typeof import('./ai-knowledge-chunks')>()),
  getWorkspaceProductNames: vi.fn(async () => [
    'SHARP「乾淨方MAX」', 'SHARP iBarista 智慧咖啡機', 'SHARP 自動調理零水鍋', 'Poketomo 口袋同萌',
    '上好ㄟ抽取式除濕機', 'GPLUS 居不可濕', 'CHIMEI 靜電集塵空氣清淨機 AP-08SPFG (電淨艙)',
  ]),
}))
vi.mock('./ai-product-alias', async importOriginal => ({
  ...(await importOriginal<typeof import('./ai-product-alias')>()),
  getProductAliases: vi.fn(async () => ({
    aliases: {
      sharp變頻除濕機dwux19ftwdwux22fthdwux22ftw: 'SHARP「乾淨方MAX」',
      gplus除濕機: 'GPLUS 居不可濕',
      nwt威技除濕機: '上好ㄟ抽取式除濕機',
      sharp小獴友poketomo口袋同萌: 'Poketomo 口袋同萌',
    },
    aliasLabels: {
      sharp變頻除濕機dwux19ftwdwux22fthdwux22ftw: 'SHARP 變頻除濕機 DW-UX19FT-W DW-UX22FT-H DW-UX22FT-W',
      gplus除濕機: 'GPLUS 除濕機',
      nwt威技除濕機: 'NWT 威技 除濕機',
      sharp小獴友poketomo口袋同萌: 'SHARP 小獴友 Poketomo 口袋同萌',
    },
    dismissedPairs: [],
  })),
}))
vi.mock('./ai-settings', async importOriginal => ({
  ...(await importOriginal<typeof import('./ai-settings')>()),
  getAiSettings: vi.fn(),
}))
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn(async () => {}) }))
vi.mock('./ai-handoff-notify', () => ({ notifyHandoffToStaff: vi.fn(async () => {}) }))
vi.mock('./ai-scripts', () => ({
  advanceScript: vi.fn(), loadActiveScripts: vi.fn(async () => []), startScript: vi.fn(),
}))
vi.mock('./conversation-media', () => ({ archiveConversationMedia: vi.fn(async () => ({ ok: false })) }))
vi.mock('./media-describe', () => ({ readInboundImage: vi.fn() }))

const { handleMessageEvent } = await import('./handler')
const { getDb } = await import('./firebase')
const { getAiSettings } = await import('./ai-settings')
const { answerWithAi } = await import('./ai-answer')
const { loadActiveScripts, startScript } = await import('./ai-scripts')

const WS = 'ws-ship-brand'
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

function textEvent(text: string): any {
  return {
    type: 'message', timestamp: Date.now(), source: { type: 'user', userId: LINE_UID },
    replyToken: 'reply-token-1', message: { type: 'text', id: 'msg-1', text },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  LINE_UID = `U${String(++uidSeq).padStart(32, '0')}`
  vi.mocked(getDb).mockReturnValue(makeDb() as any)
  vi.mocked(getAiSettings).mockResolvedValue({
    enabled: true, replyMode: 'auto', sensitiveTopics: [], imageAnswer: { enabled: true }, confidenceThreshold: 0.75,
    disambiguation: { enabled: false, top1Min: 0.7, top1Max: 0.85, maxSpread: 0.1, maxOptions: 3, cooldownMinutes: 10 },
    handoffNotify: { enabled: false, lineUserIds: [], displayNames: {}, slaRemindMinutes: 10 },
    serviceHours: { enabled: false, start: '09:00', end: '18:00', weekendOff: true, dndReply: '' },
  } as any)
  vi.mocked(loadActiveScripts).mockResolvedValue([ORDER_SCRIPT] as any)
  vi.mocked(startScript).mockResolvedValue({ replyText: '您好,請問您的訂單編號是？', thenHandoff: false, finished: false })
  vi.mocked(answerWithAi).mockResolvedValue({
    decision: 'answered', answer: '乾淨方MAX 預計 10 月中旬依訂單順序陸續出貨喔！', confidence: 0.85,
    sources: [{ chunkId: 'max_ship' }], handoffReason: null, answerKind: 'kb', offerFindHuman: true,
  } as any)
})

describe('出貨題講了品牌＋商品名：handler 那個呼叫點認得出一台', () => {
  it('🔴 「訂單編號…，SHARP 乾淨方MAX 什麼時候出貨」→ 不進「查詢訂單」流程，交給 AI 答', async () => {
    await handleMessageEvent(textEvent('訂單編號 M20260906123456ABCD，請問 SHARP 乾淨方MAX 什麼時候出貨'), { workspaceId: WS })

    expect(vi.mocked(startScript)).not.toHaveBeenCalled()
    expect(vi.mocked(answerWithAi)).toHaveBeenCalledTimes(1)
  })

  it('只講品類（「除濕機訂單什麼時候出貨」三台都有）→ 照舊進流程', async () => {
    await handleMessageEvent(textEvent('除濕機訂單什麼時候出貨'), { workspaceId: WS })

    expect(vi.mocked(startScript)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(answerWithAi)).not.toHaveBeenCalled()
  })
})
