import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({}))

vi.mock('firebase-admin/firestore', () => ({
  // arrayUnion：圖片的 AI 描述會把可搜尋片段**加**到那一則訊息上（見 describeAndAttachImage）。
  // 少了它整支描述寫入會炸掉，而呼叫端是 catch 起來的＝圖片說明默默不見
  FieldValue: {
    serverTimestamp: () => '__ts__',
    delete: () => '__del__',
    arrayUnion: (...values: unknown[]) => ({ __arrayUnion: values }),
  },
  // now() 要是真的現在：「同一位客人 2 分鐘內只問一次」靠它判斷，回 0 會讓第二張圖以為很久沒問過
  Timestamp: { now: () => ({ toMillis: () => Date.now() }), fromMillis: (m: number) => ({ toMillis: () => m }) },
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
import { replyMessage, showLoadingAnimation } from './line'
import { getAiSettings } from './ai-settings'
import { answerWithAi } from './ai-answer'
import { readInboundImage } from './media-describe'
import { shouldSuppressInboundBotAutomationForSession } from './conversation-session'
import { archiveConversationMedia } from './conversation-media'

const WS = 'ws-img'
/**
 * 每個 case 換一位客人：引導語有「每人 10 分鐘一次」的節流，而那份節流表是模組層狀態，
 * 會跨測試殘留——共用同一個 uid 的話，第二個 case 之後的引導語會被靜靜吃掉。
 */
let LINE_UID = ''
let DOC_ID = ''
let uidSeq = 0

/** 引導語的關鍵字：只要客人收到這句，就代表走的是開關關著的舊路 */
const ACK_HINT = '只能閱讀文字'
/** 問句的關鍵字 */
const ASK_HINT = '請問想了解什麼呢'

/**
 * 圖片進來的時間刻意設在 20 秒前：問之前要等「圖片進來後 15 秒」看客人有沒有打字，
 * 設成已經等過了，測試就不用真的睡 15 秒（「等的期間客人打了字」另外用一則已存在的訊息模擬）。
 */
const IMAGE_AT = () => Date.now() - 20_000

interface StoredMessage {
  direction: 'incoming' | 'outgoing'
  messageType: string
  text: string
  timestamp: { toMillis: () => number }
  mediaDescription?: string
}

function makeDb() {
  const conversations = new Map<string, Record<string, unknown>>()
  /** 預先放進去的對話紀錄（客人前後打的字、機器人回過的話）；handler 新寫的訊息不進這裡 */
  const messages: StoredMessage[] = []
  /** handler 這次新寫進訊息子集合的東西 */
  const written: Record<string, any>[] = []
  const userDoc = {
    exists: true,
    data: () => ({ workspaceId: WS, lineUserId: LINE_UID, displayName: '測試客人', isBlocked: false }),
  }

  const asDocs = (list: StoredMessage[]) => ({ docs: list.map((m, i) => ({ id: `m-${i}`, data: () => m })) })
  const sorted = (dir: string) => [...messages].sort((a, b) =>
    dir === 'desc' ? b.timestamp.toMillis() - a.timestamp.toMillis() : a.timestamp.toMillis() - b.timestamp.toMillis())
  const subCollection = () => ({
    doc: (msgId?: string) => ({ id: msgId ?? 'auto-1', set: vi.fn(async (data: any) => { written.push(data) }) }),
    // 答題流程讀最近 8 則對話
    orderBy: (_f: string, dir = 'asc') => ({ limit: (n: number) => ({ get: vi.fn(async () => asDocs(sorted(dir).slice(0, n))) }) }),
    // 看客人在圖片前後有沒有打字
    where: (_f: string, op: string, value: { toMillis: () => number }) => ({
      orderBy: (_f2: string, dir = 'asc') => ({
        limit: (n: number) => ({
          get: vi.fn(async () => {
            const v = value.toMillis()
            const hit = sorted(dir).filter(m => (op === '>' ? m.timestamp.toMillis() > v : m.timestamp.toMillis() >= v))
            return asDocs(hit.slice(0, n))
          }),
        }),
      }),
    }),
  })

  const docRef = (col: string, id?: string) => ({
    get: vi.fn(async () => {
      if (col === 'users') return userDoc
      const data = col === 'conversations' ? conversations.get(String(id)) : undefined
      return { exists: Boolean(data), data: () => data, get: (field: string) => data?.[field] }
    }),
    set: vi.fn(async (data: any) => {
      if (col === 'conversations') {
        conversations.set(String(id), { ...(conversations.get(String(id)) ?? {}), ...data })
      }
    }),
    update: vi.fn(async () => {}),
    collection: subCollection,
  })

  // 交易要真的一次一個：「多張圖只問一次」靠它，並行的兩張圖不能同時讀到「還沒問過」
  let chain: Promise<unknown> = Promise.resolve()
  const tx = {
    get: (ref: ReturnType<typeof docRef>) => ref.get(),
    set: (ref: ReturnType<typeof docRef>, data: any) => { ref.set(data) },
  }
  const db = {
    collection: (col: string) => ({
      where: () => ({ get: vi.fn(async () => ({ empty: true, docs: [] })) }),
      doc: (id?: string) => docRef(col, id),
    }),
    runTransaction: (fn: (t: typeof tx) => Promise<unknown>) => {
      const run = chain.then(() => fn(tx))
      chain = run.catch(() => {})
      return run
    },
  }
  return { db, conversations, messages, written }
}

let ctx: ReturnType<typeof makeDb>

function at(ms: number) {
  return { toMillis: () => ms }
}

function imageEvent(opts: { timestamp?: number; id?: string; replyToken?: string } = {}): any {
  return {
    type: 'message',
    timestamp: opts.timestamp ?? IMAGE_AT(),
    source: { type: 'user', userId: LINE_UID },
    replyToken: opts.replyToken ?? 'reply-token-1',
    message: { type: 'image', id: opts.id ?? 'msg-img-1' },
  }
}

function textEvent(text: string): any {
  return {
    type: 'message',
    timestamp: Date.now(),
    source: { type: 'user', userId: LINE_UID },
    replyToken: 'reply-token-text',
    message: { type: 'text', id: 'msg-text-1', text },
  }
}

/** 客人收到的所有文字（問句、引導語、AI 答案都經過 replyMessage） */
function repliedTexts(): string[] {
  return vi.mocked(replyMessage).mock.calls.flatMap(([, msgs]) =>
    (msgs as any[]).map(m => String(m?.text ?? '')),
  )
}

/** 問句底下那排按鈕的字 */
function quickReplyLabels(): string[] {
  const msgs = vi.mocked(replyMessage).mock.calls.flatMap(([, m]) => m as any[])
  return msgs.flatMap(m => (m?.quickReply?.items ?? []).map((i: any) => i.action.label))
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

function readsAs(description: string, questions: string[], state: 'ok' | 'noQuestion' | 'unavailable' = questions.length ? 'ok' : 'noQuestion') {
  vi.mocked(readInboundImage).mockResolvedValue({ description, questions, state })
}

beforeEach(() => {
  vi.clearAllMocks()
  LINE_UID = `U${String(++uidSeq).padStart(32, '0')}`
  DOC_ID = `${WS}_${LINE_UID}`
  ctx = makeDb()
  vi.mocked(getDb).mockReturnValue(ctx.db as any)
  vi.mocked(shouldSuppressInboundBotAutomationForSession).mockResolvedValue(false)
})

describe('客人傳的照片：開關關著時什麼都不變', () => {
  it('沒開 → 客人照舊收到引導語，不問、AI 也不會被叫去答題', async () => {
    setSettings(false)
    readsAs('破掉的杯子', [])

    await handleMessageEvent(imageEvent(), { workspaceId: WS })

    expect(repliedTexts().join()).toContain(ACK_HINT)
    expect(repliedTexts().join()).not.toContain(ASK_HINT)
    expect(vi.mocked(answerWithAi)).not.toHaveBeenCalled()
  })
})

describe('客人傳的照片：只傳圖、沒說話 → 問一句', () => {
  beforeEach(() => setSettings(true))

  it('問一句、附猜的選項＋找真人；不拿猜的問題去叫 AI 答題', async () => {
    readsAs('鍋子底部白色掉漆', ['瑕疵可以換貨嗎？', '掉漆能送修嗎？'])

    await handleMessageEvent(imageEvent(), { workspaceId: WS })

    expect(vi.mocked(replyMessage)).toHaveBeenCalledTimes(1)
    expect(repliedTexts()).toEqual(['收到您的照片了 📷 請問想了解什麼呢？'])
    expect(quickReplyLabels()).toEqual(['瑕疵可以換貨嗎？', '掉漆能送修嗎？', '🙋 找真人'])
    // `C-207` 的根：猜的問題直接答題＝替客人編一句話、答案算在他頭上
    expect(vi.mocked(answerWithAi)).not.toHaveBeenCalled()
    expect((ctx.conversations.get(DOC_ID) as any)?.aiMeta).toBeUndefined()
  })

  it('「找真人」按鈕送出的是攔截認得的「找真人」，不是只有二次確認才認得的「轉接專員」', async () => {
    readsAs('鍋子底部白色掉漆', ['瑕疵可以換貨嗎？'])

    await handleMessageEvent(imageEvent(), { workspaceId: WS })

    const items = (vi.mocked(replyMessage).mock.calls[0]![1][0] as any).quickReply.items as any[]
    expect(items.at(-1).action).toEqual({ type: 'message', label: '🙋 找真人', text: '找真人' })
  })

  it('看不出想問什麼（自拍/風景）→ 問句照發，只剩「找真人」一顆，不硬掰選項', async () => {
    readsAs('在海邊的自拍照', [])

    await handleMessageEvent(imageEvent(), { workspaceId: WS })

    expect(repliedTexts().join()).toContain(ASK_HINT)
    expect(quickReplyLabels()).toEqual(['🙋 找真人'])
  })

  it('讀圖整個失敗（存檔失敗、Gemini 掛了）→ 一樣問，客人不會被已讀不回', async () => {
    vi.mocked(archiveConversationMedia).mockResolvedValueOnce({ ok: false, state: 'expired' } as any)
    readsAs('', [], 'unavailable')

    await handleMessageEvent(imageEvent(), { workspaceId: WS })

    expect(repliedTexts().join()).toContain(ASK_HINT)
    expect(repliedTexts().join()).not.toContain(ACK_HINT)
  })

  it('會先亮「輸入中…」：接下來要沉默十幾秒（讀圖＋等客人打字）', async () => {
    readsAs('訂單截圖', [])

    await handleMessageEvent(imageEvent(), { workspaceId: WS })

    expect(vi.mocked(showLoadingAnimation)).toHaveBeenCalled()
  })

  it('一次傳好幾張只問一次（並行處理的每張圖等完都會想問）', async () => {
    readsAs('鍋子底部白色掉漆', ['瑕疵可以換貨嗎？'])
    const t = IMAGE_AT()

    await Promise.all([
      handleMessageEvent(imageEvent({ timestamp: t, id: 'img-a', replyToken: 'rt-a' }), { workspaceId: WS }),
      handleMessageEvent(imageEvent({ timestamp: t + 1, id: 'img-b', replyToken: 'rt-b' }), { workspaceId: WS }),
      handleMessageEvent(imageEvent({ timestamp: t + 2, id: 'img-c', replyToken: 'rt-c' }), { workspaceId: WS }),
    ])

    expect(vi.mocked(replyMessage)).toHaveBeenCalledTimes(1)
  })

  it('問句標成「系統」：內建文字，後台沒有模組可以改', async () => {
    readsAs('訂單截圖', [])

    await handleMessageEvent(imageEvent(), { workspaceId: WS })
    // 存對話是 fire-and-forget（客人的回覆不能等 Firestore），讓它跑完再看
    await new Promise(resolve => setTimeout(resolve, 0))

    const saved = ctx.written.filter(m => m.direction === 'outgoing')
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({
      text: '收到您的照片了 📷 請問想了解什麼呢？',
      sender: 'system',
      senderName: '客人傳照片時的提問',
    })
    expect(saved[0]!.aiGenerated).toBeUndefined()
  })
})

describe('客人傳的照片：客人自己有打字 → 不另外回圖', () => {
  beforeEach(() => setSettings(true))

  it('先打字、再附圖（圖是佐證）→ 一句都不回，他那句話自己會被回答', async () => {
    const t = IMAGE_AT()
    ctx.messages.push({ direction: 'incoming', messageType: 'text', text: '請問此訂單，約何時出貨？謝謝', timestamp: at(t - 5000) })
    readsAs('訂單明細：付款完成', ['什麼時候出貨？'])

    await handleMessageEvent(imageEvent({ timestamp: t }), { workspaceId: WS })

    expect(vi.mocked(replyMessage)).not.toHaveBeenCalled()
    expect(vi.mocked(answerWithAi)).not.toHaveBeenCalled()
    // 不會出聲，就不該亮「輸入中…」
    expect(vi.mocked(showLoadingAnimation)).not.toHaveBeenCalled()
  })

  it('一次傳好幾張：同一批的其他圖跳過、再往前看到客人打的字', async () => {
    const t = IMAGE_AT()
    ctx.messages.push({ direction: 'incoming', messageType: 'text', text: '收到的鍋子有瑕疵', timestamp: at(t - 8000) })
    ctx.messages.push({ direction: 'incoming', messageType: 'image', text: '[圖片]', timestamp: at(t - 500) })
    readsAs('鍋子底部白色掉漆', ['瑕疵可以換貨嗎？'])

    await handleMessageEvent(imageEvent({ timestamp: t }), { workspaceId: WS })

    expect(vi.mocked(replyMessage)).not.toHaveBeenCalled()
  })

  it('機器人已經回過話之後才傳圖（例如回一張截圖給 AI 要的訂單編號）→ 算新的一輪，會問', async () => {
    const t = IMAGE_AT()
    ctx.messages.push({ direction: 'incoming', messageType: 'text', text: '何時出貨', timestamp: at(t - 30_000) })
    ctx.messages.push({ direction: 'outgoing', messageType: 'text', text: '您好,請問您的訂單編號是？', timestamp: at(t - 20_000) })
    readsAs('訂單明細截圖', [])

    await handleMessageEvent(imageEvent({ timestamp: t }), { workspaceId: WS })

    expect(repliedTexts().join()).toContain(ASK_HINT)
  })

  it('兩分鐘以前打的字不算：那是上一件事', async () => {
    const t = IMAGE_AT()
    ctx.messages.push({ direction: 'incoming', messageType: 'text', text: '謝謝', timestamp: at(t - 3 * 60_000) })
    readsAs('破掉的杯子', [])

    await handleMessageEvent(imageEvent({ timestamp: t }), { workspaceId: WS })

    expect(repliedTexts().join()).toContain(ASK_HINT)
  })

  it('先傳圖、等的期間客人打了字 → 不問，照他打的那句回答', async () => {
    const t = IMAGE_AT()
    ctx.messages.push({ direction: 'incoming', messageType: 'text', text: '請問出貨時間？', timestamp: at(t + 9000) })
    readsAs('訂單明細：咖啡機、尚未出貨', ['什麼時候出貨？'])

    await handleMessageEvent(imageEvent({ timestamp: t }), { workspaceId: WS })

    expect(vi.mocked(replyMessage)).not.toHaveBeenCalled()
  })
})

describe('客人傳的照片：不該開口的時候', () => {
  it('真人正在處理這通對話 → 機器人完全閉嘴（插話比不回更糟）', async () => {
    setSettings(true)
    vi.mocked(shouldSuppressInboundBotAutomationForSession).mockResolvedValue(true)
    readsAs('破掉的杯子', ['可以換貨嗎？'])

    await handleMessageEvent(imageEvent(), { workspaceId: WS })

    expect(vi.mocked(replyMessage)).not.toHaveBeenCalled()
  })

  it('等的十幾秒內真人接手了 → 不問', async () => {
    setSettings(true)
    // 第一次（進來時）還沒人接，第二次（等完要問之前）已經有人接
    vi.mocked(shouldSuppressInboundBotAutomationForSession)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)
    readsAs('破掉的杯子', ['可以換貨嗎？'])

    await handleMessageEvent(imageEvent(), { workspaceId: WS })

    expect(vi.mocked(replyMessage)).not.toHaveBeenCalled()
  })

  it('草稿模式：一個字都不對客人說，也不叫 AI 拿猜的問題產草稿', async () => {
    setSettings(true, 'draft')
    readsAs('破掉的杯子', ['可以換貨嗎？'])

    await handleMessageEvent(imageEvent(), { workspaceId: WS })

    expect(vi.mocked(replyMessage)).not.toHaveBeenCalled()
    expect(vi.mocked(answerWithAi)).not.toHaveBeenCalled()
  })
})

describe('客人打字時，AI 看得到他剛傳的照片', () => {
  function answerOk() {
    vi.mocked(answerWithAi).mockResolvedValue({
      decision: 'answered', answer: '小滑手將於 10 月底依訂單順序陸續出貨。',
      confidence: 0.9, sources: [], handoffReason: null, answerKind: 'kb',
    } as any)
  }
  function historyTexts(): string[] {
    return ((vi.mocked(answerWithAi).mock.calls[0]![0] as any).history ?? []).map((t: any) => t.text)
  }

  it('開關開著：前文的「[圖片]」換成照片說明，AI 才知道是哪個商品', async () => {
    setSettings(true)
    answerOk()
    ctx.messages.push({
      direction: 'incoming', messageType: 'image', text: '[圖片]',
      mediaDescription: '訂單明細：全自動咖啡機、尚未出貨', timestamp: at(Date.now() - 15_000),
    })

    await handleMessageEvent(textEvent('請問出貨時間？'), { workspaceId: WS })

    expect(historyTexts()).toContain('[圖片：訂單明細：全自動咖啡機、尚未出貨]')
  })

  it('開關關著：維持「[圖片]」——客人收到的是「我只能閱讀文字」，AI 不能引用圖上的東西', async () => {
    setSettings(false)
    answerOk()
    ctx.messages.push({
      direction: 'incoming', messageType: 'image', text: '[圖片]',
      mediaDescription: '訂單明細：全自動咖啡機、尚未出貨', timestamp: at(Date.now() - 15_000),
    })

    await handleMessageEvent(textEvent('請問出貨時間？'), { workspaceId: WS })

    expect(historyTexts()).toContain('[圖片]')
    expect(historyTexts().join()).not.toContain('咖啡機')
  })

  it('照片還沒讀完（圖跟字幾乎同時送出）→ 維持「[圖片]」，不會出現空的「[圖片：]」', async () => {
    setSettings(true)
    answerOk()
    ctx.messages.push({ direction: 'incoming', messageType: 'image', text: '[圖片]', timestamp: at(Date.now() - 1000) })

    await handleMessageEvent(textEvent('請問出貨時間？'), { workspaceId: WS })

    expect(historyTexts()).toContain('[圖片]')
  })
})
