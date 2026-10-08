import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({}))

vi.mock('firebase-admin/firestore', () => ({
  // 時間戳都要是「真的時間」：這支測的是「圖片前後誰先誰後」，寫入的時間對不上，前後就判斷不出來
  FieldValue: {
    serverTimestamp: () => { const t = Date.now(); return { toMillis: () => t } },
    delete: () => '__del__',
    // arrayUnion：圖片的 AI 描述會把可搜尋片段**加**到那一則訊息上（見 describeAndAttachImage）
    arrayUnion: (...values: unknown[]) => ({ __arrayUnion: values }),
  },
  Timestamp: {
    now: () => { const t = Date.now(); return { toMillis: () => t } },
    fromMillis: (m: number) => ({ toMillis: () => m }),
  },
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
import { enterModule, shouldSuppressInboundBotAutomationForSession } from './conversation-session'
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
const ASK_TEXT = '收到您的照片了 📷 請問想了解什麼呢？'

/**
 * 圖片進來的時間預設在 20 秒前：問之前要等「圖片進來後 15 秒」看客人有沒有動作，
 * 設成已經等過了，大部分 case 不用真的睡 15 秒。「等到一半客人才打字」那兩條另外設成
 * 只剩 1 秒、真的跑一輪等待（見最後一個 describe 前的那組）。
 */
const IMAGE_AT = () => Date.now() - 20_000

const at = (ms: number) => ({ toMillis: () => ms })
const tsOf = (m: Record<string, any>) => m.timestamp?.toMillis?.() ?? 0

/**
 * 假 Firestore：訊息子集合寫進去的東西查得到（handler 自己存的圖片、問句都會出現在之後的查詢裡），
 * 跟真的一樣——「字比圖早、但比較晚存進來」這種情況靠的就是這一點。
 */
function makeDb() {
  const conversations = new Map<string, Record<string, any>>()
  const messages = new Map<string, Record<string, any>>()
  let seq = 0
  /** 之後幾次「看圖片前後」的查詢要失敗（模擬 Firestore 偶發逾時） */
  let failScans = 0

  const rows = (dir: string, keep: (m: Record<string, any>) => boolean = () => true) =>
    [...messages.entries()]
      .filter(([, m]) => keep(m))
      .sort(([, a], [, b]) => (dir === 'desc' ? tsOf(b) - tsOf(a) : tsOf(a) - tsOf(b)))
      .map(([id, m]) => ({ id, data: () => m }))

  const messagesCollection = {
    doc: (id?: string) => {
      const docId = id ?? `msg-${++seq}`
      return {
        id: docId,
        set: vi.fn(async (data: any, opts?: { merge?: boolean }) => {
          // 存「我們送出的訊息」刻意慢一點：寫入瞬間完成的話，handler 有沒有等它做完都看不出差別
          if (data?.direction === 'outgoing') await new Promise(resolve => setTimeout(resolve, 30))
          messages.set(docId, opts?.merge ? { ...(messages.get(docId) ?? {}), ...data } : data)
        }),
      }
    },
    // 答題流程讀最近 8 則對話
    orderBy: (_f: string, dir = 'asc') => ({
      limit: (n: number) => ({ get: vi.fn(async () => ({ docs: rows(dir).slice(0, n) })) }),
    }),
    // 看圖片前後客人有沒有動作
    where: (_f: string, op: string, value: { toMillis: () => number }) => ({
      orderBy: (_f2: string, dir = 'asc') => ({
        limit: (n: number) => ({
          get: vi.fn(async () => {
            if (failScans > 0) {
              failScans--
              throw new Error('4 DEADLINE_EXCEEDED')
            }
            const v = value.toMillis()
            return { docs: rows(dir, m => (op === '>' ? tsOf(m) > v : tsOf(m) >= v)).slice(0, n) }
          }),
        }),
      }),
    }),
  }
  const otherCollection = {
    doc: (id?: string) => ({
      id: id ?? `other-${++seq}`,
      get: vi.fn(async () => ({ exists: false, data: () => undefined })),
      set: vi.fn(async () => {}),
    }),
    orderBy: () => ({ limit: () => ({ get: vi.fn(async () => ({ docs: [] })) }) }),
  }

  const userDoc = {
    exists: true,
    data: () => ({ workspaceId: WS, lineUserId: LINE_UID, displayName: '測試客人', isBlocked: false }),
  }
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
    collection: (name: string) => (name === 'messages' ? messagesCollection : otherCollection),
  })

  // 交易要真的一次一個：「多張圖只有一張負責問」靠它，並行的幾張不能同時讀到「還沒人在等」
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

  return {
    db,
    conversations,
    messages,
    /** 放一則既有的對話紀錄 */
    seed: (m: Record<string, any>) => { messages.set(`seed-${++seq}`, m) },
    failNextScans: (n: number) => { failScans = n },
  }
}

let ctx: ReturnType<typeof makeDb>

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

/** handler 這次存下來的圖片訊息，各自被記成哪種處理結果 */
function imageOutcomes(): string[] {
  return [...ctx.messages.values()]
    .filter(m => m.messageType === 'image' && m.imageReplyOutcome)
    .map(m => m.imageReplyOutcome)
    .sort()
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

function readsAs(
  description: string,
  questions: string[],
  state: 'ok' | 'noQuestion' | 'malformed' | 'unavailable' = questions.length ? 'ok' : 'noQuestion',
) {
  vi.mocked(readInboundImage).mockResolvedValue({ description, questions, state })
}

beforeEach(() => {
  vi.clearAllMocks()
  LINE_UID = `U${String(++uidSeq).padStart(32, '0')}`
  DOC_ID = `${WS}_${LINE_UID}`
  ctx = makeDb()
  vi.mocked(getDb).mockReturnValue(ctx.db as any)
  vi.mocked(shouldSuppressInboundBotAutomationForSession).mockResolvedValue(false)
  vi.mocked(replyMessage).mockResolvedValue(undefined as any)
})

describe('客人傳的照片：開關關著時什麼都不變', () => {
  it('沒開 → 客人照舊收到引導語，不問、AI 也不會被叫去答題', async () => {
    setSettings(false)
    readsAs('破掉的杯子', [])

    await handleMessageEvent(imageEvent(), { workspaceId: WS })

    expect(repliedTexts().join()).toContain(ACK_HINT)
    expect(repliedTexts()).not.toContain(ASK_TEXT)
    expect(vi.mocked(answerWithAi)).not.toHaveBeenCalled()
  })
})

describe('客人傳的照片：只傳圖、沒動作 → 問一句', () => {
  beforeEach(() => setSettings(true))

  it('問一句、附猜的選項＋找真人；不拿猜的問題去叫 AI 答題', async () => {
    readsAs('鍋子底部白色掉漆', ['瑕疵可以換貨嗎？', '掉漆能送修嗎？'])

    await handleMessageEvent(imageEvent(), { workspaceId: WS })

    expect(vi.mocked(replyMessage)).toHaveBeenCalledTimes(1)
    expect(repliedTexts()).toEqual([ASK_TEXT])
    expect(quickReplyLabels()).toEqual(['瑕疵可以換貨嗎？', '掉漆能送修嗎？', '🙋 找真人'])
    // `C-207` 的根：猜的問題直接答題＝替客人編一句話、答案算在他頭上
    expect(vi.mocked(answerWithAi)).not.toHaveBeenCalled()
    expect(ctx.conversations.get(DOC_ID)?.aiMeta).toBeUndefined()
    expect(imageOutcomes()).toEqual(['asked'])
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

    expect(repliedTexts()).toEqual([ASK_TEXT])
    expect(quickReplyLabels()).toEqual(['🙋 找真人'])
  })

  it('讀圖整個失敗（存檔失敗、Gemini 掛了）→ 一樣問，客人不會被已讀不回', async () => {
    vi.mocked(archiveConversationMedia).mockResolvedValueOnce({ ok: false, state: 'expired' } as any)
    readsAs('', [], 'unavailable')

    await handleMessageEvent(imageEvent(), { workspaceId: WS })

    expect(repliedTexts()).toEqual([ASK_TEXT])
  })

  it('會先亮「輸入中…」：接下來要沉默十幾秒（讀圖＋等客人動作）', async () => {
    readsAs('訂單截圖', [])

    await handleMessageEvent(imageEvent(), { workspaceId: WS })

    expect(vi.mocked(showLoadingAnimation)).toHaveBeenCalledTimes(1)
  })

  it('問句存進對話（標「系統」）、記機器人首接、讓出等待位子——都在 webhook 結束前做完', async () => {
    readsAs('訂單截圖', [])
    let firstHandledMarked = false
    vi.mocked(enterModule).mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 30))
      firstHandledMarked = true
    })

    await handleMessageEvent(imageEvent(), { workspaceId: WS })
    // ⛔ 這裡刻意不多等：主機回應完就凍結，沒在 handler 裡等完的寫入在正式站上會掉。
    // 存問句與記首接在假資料庫裡都要 30ms，handler 沒等它們的話，這裡一定還沒寫進去

    const saved = [...ctx.messages.values()].filter(m => m.direction === 'outgoing')
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ text: ASK_TEXT, sender: 'system', senderName: '客人傳照片時的提問' })
    expect(saved[0]!.aiGenerated).toBeUndefined()
    expect(vi.mocked(enterModule)).toHaveBeenCalledWith('sess-1', expect.any(String), 'bot_flow', undefined, WS)
    expect(firstHandledMarked).toBe(true)
    const conv = ctx.conversations.get(DOC_ID)!
    expect(tsOf({ timestamp: conv.lastImageAskAt })).toBeGreaterThan(0)
    expect(conv.imageAskWaitingAt).toBeNull()
  })

  it('一次傳好幾張：只有一張負責等和問、只亮一次「輸入中…」，其他張記成同一批', async () => {
    readsAs('鍋子底部白色掉漆', ['瑕疵可以換貨嗎？'])
    const t = IMAGE_AT()

    await Promise.all([
      handleMessageEvent(imageEvent({ timestamp: t, id: 'img-a', replyToken: 'rt-a' }), { workspaceId: WS }),
      handleMessageEvent(imageEvent({ timestamp: t + 1, id: 'img-b', replyToken: 'rt-b' }), { workspaceId: WS }),
      handleMessageEvent(imageEvent({ timestamp: t + 2, id: 'img-c', replyToken: 'rt-c' }), { workspaceId: WS }),
    ])

    expect(vi.mocked(replyMessage)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(showLoadingAnimation)).toHaveBeenCalledTimes(1)
    expect(imageOutcomes()).toEqual(['asked', 'batchFollower', 'batchFollower'])
  })

  it('負責問的那張讀圖失敗 → 用同一批其他張猜出來的選項', async () => {
    const t = IMAGE_AT()
    ctx.seed({ direction: 'incoming', messageType: 'image', text: '[圖片]', timestamp: at(t - 1000), mediaQuestions: ['瑕疵可以換貨嗎？'] })
    readsAs('', [], 'unavailable')

    await handleMessageEvent(imageEvent({ timestamp: t }), { workspaceId: WS })

    expect(quickReplyLabels()).toEqual(['瑕疵可以換貨嗎？', '🙋 找真人'])
  })

  it('上一輪（機器人回過話之前）的照片，猜的選項不拿來用', async () => {
    const t = IMAGE_AT()
    ctx.seed({ direction: 'incoming', messageType: 'image', text: '[圖片]', timestamp: at(t - 50_000), mediaQuestions: ['舊照片的問題？'] })
    ctx.seed({ direction: 'outgoing', messageType: 'text', text: '好的，已為您處理', timestamp: at(t - 40_000) })
    readsAs('新的訂單截圖', ['什麼時候出貨？'])

    await handleMessageEvent(imageEvent({ timestamp: t }), { workspaceId: WS })

    expect(quickReplyLabels()).toEqual(['什麼時候出貨？', '🙋 找真人'])
  })

  it('問句送不出去（回覆權杖過期）→ 不記「問過了」、讓出位子，下一張照片還會問', async () => {
    readsAs('訂單截圖', [])
    vi.mocked(replyMessage).mockRejectedValueOnce(new Error('Invalid reply token'))

    await handleMessageEvent(imageEvent(), { workspaceId: WS })

    const conv = ctx.conversations.get(DOC_ID)!
    expect(conv.lastImageAskAt).toBeUndefined()
    expect(conv.imageAskWaitingAt).toBeNull()
    expect(imageOutcomes()).toEqual(['replyFailed'])

    await handleMessageEvent(imageEvent({ timestamp: Date.now() - 16_000, id: 'img-2', replyToken: 'rt-2' }), { workspaceId: WS })
    expect(vi.mocked(replyMessage)).toHaveBeenCalledTimes(2)
  })

  it('查詢偶爾出錯（判斷時、等待時各一次）→ 還是會問，不會讓客人等不到回應', async () => {
    readsAs('訂單截圖', [])
    ctx.failNextScans(2)

    await handleMessageEvent(imageEvent(), { workspaceId: WS })

    expect(repliedTexts()).toEqual([ASK_TEXT])
  })
})

describe('客人傳的照片：客人自己有動作 → 不另外回圖', () => {
  beforeEach(() => setSettings(true))

  it('先打字、再附圖（圖是佐證）→ 一句都不回、不亮「輸入中…」，他那句話自己會被回答', async () => {
    const t = IMAGE_AT()
    ctx.seed({ direction: 'incoming', messageType: 'text', text: '請問此訂單，約何時出貨？謝謝', timestamp: at(t - 5000) })
    readsAs('訂單明細：付款完成', ['什麼時候出貨？'])

    await handleMessageEvent(imageEvent({ timestamp: t }), { workspaceId: WS })

    expect(vi.mocked(replyMessage)).not.toHaveBeenCalled()
    expect(vi.mocked(answerWithAi)).not.toHaveBeenCalled()
    expect(vi.mocked(showLoadingAnimation)).not.toHaveBeenCalled()
    expect(imageOutcomes()).toEqual(['typedBefore'])
  })

  it('一次傳好幾張：同一批的其他圖跳過、再往前看到客人打的字', async () => {
    const t = IMAGE_AT()
    ctx.seed({ direction: 'incoming', messageType: 'text', text: '收到的鍋子有瑕疵', timestamp: at(t - 8000) })
    ctx.seed({ direction: 'incoming', messageType: 'image', text: '[圖片]', timestamp: at(t - 500) })
    readsAs('鍋子底部白色掉漆', ['瑕疵可以換貨嗎？'])

    await handleMessageEvent(imageEvent({ timestamp: t }), { workspaceId: WS })

    expect(vi.mocked(replyMessage)).not.toHaveBeenCalled()
  })

  it('後面已經有一大批照片，也找得到圖片之前客人打的字（不會被擠出查詢上限）', async () => {
    const t = IMAGE_AT()
    ctx.seed({ direction: 'incoming', messageType: 'text', text: '收到的鍋子有瑕疵', timestamp: at(t - 3000) })
    // 70 張＞查詢上限 60：舊做法由新到舊取 20 則，圖片之前那句字會被後面的照片擠掉
    for (let i = 1; i <= 70; i++) {
      ctx.seed({ direction: 'incoming', messageType: 'image', text: '[圖片]', timestamp: at(t + i * 10) })
    }
    readsAs('鍋子底部白色掉漆', [])

    await handleMessageEvent(imageEvent({ timestamp: t }), { workspaceId: WS })

    expect(vi.mocked(replyMessage)).not.toHaveBeenCalled()
  })

  it('機器人已經回過話之後才傳圖（例如回一張截圖給 AI 要的訂單編號）→ 算新的一輪，會問', async () => {
    const t = IMAGE_AT()
    ctx.seed({ direction: 'incoming', messageType: 'text', text: '何時出貨', timestamp: at(t - 30_000) })
    ctx.seed({ direction: 'outgoing', messageType: 'text', text: '您好,請問您的訂單編號是？', timestamp: at(t - 20_000) })
    readsAs('訂單明細截圖', [])

    await handleMessageEvent(imageEvent({ timestamp: t }), { workspaceId: WS })

    expect(repliedTexts()).toEqual([ASK_TEXT])
  })

  it('兩分鐘以前打的字不算：那是上一件事', async () => {
    const t = IMAGE_AT()
    ctx.seed({ direction: 'incoming', messageType: 'text', text: '謝謝', timestamp: at(t - 3 * 60_000) })
    readsAs('破掉的杯子', [])

    await handleMessageEvent(imageEvent({ timestamp: t }), { workspaceId: WS })

    expect(repliedTexts()).toEqual([ASK_TEXT])
  })

  it('先傳圖、之後客人打了字 → 不問，照他打的那句回答', async () => {
    const t = IMAGE_AT()
    ctx.seed({ direction: 'incoming', messageType: 'text', text: '請問出貨時間？', timestamp: at(t + 9000) })
    readsAs('訂單明細：咖啡機、尚未出貨', ['什麼時候出貨？'])

    await handleMessageEvent(imageEvent({ timestamp: t }), { workspaceId: WS })

    expect(vi.mocked(replyMessage)).not.toHaveBeenCalled()
    expect(imageOutcomes()).toEqual(['customerActed'])
  })

  it('先傳圖、之後客人按了圖文選單的按鈕（記成「客人動作」不是文字）→ 不問，按鈕那邊自己會回', async () => {
    const t = IMAGE_AT()
    ctx.seed({ direction: 'incoming', messageType: 'customer_action', text: '客人點了「我要退貨」', timestamp: at(t + 6000) })
    readsAs('破掉的杯子', ['可以換貨嗎？'])

    await handleMessageEvent(imageEvent({ timestamp: t }), { workspaceId: WS })

    expect(vi.mocked(replyMessage)).not.toHaveBeenCalled()
  })
})

describe('客人傳的照片：等待期間真的會再查（等待只剩 1 秒，會真的睡一輪）', () => {
  beforeEach(() => setSettings(true))
  const almostDue = () => Date.now() - 14_000

  it('等到一半客人才打字 → 不問', async () => {
    const t = almostDue()
    readsAs('訂單截圖', ['什麼時候出貨？'])
    setTimeout(() => {
      ctx.seed({ direction: 'incoming', messageType: 'text', text: '請問出貨時間？', timestamp: at(t + 14_200) })
    }, 300)

    await handleMessageEvent(imageEvent({ timestamp: t }), { workspaceId: WS })

    expect(vi.mocked(replyMessage)).not.toHaveBeenCalled()
    expect(imageOutcomes()).toEqual(['customerActed'])
  })

  it('字比圖早、但比較晚才存進來（兩邊並行處理）→ 不問，不會在 AI 的答案旁邊再多一句', async () => {
    const t = almostDue()
    readsAs('訂單截圖', ['什麼時候出貨？'])
    // 第一次判斷時還看不到這句字（決定由這張負責問、亮了「輸入中…」），之後才存進來
    setTimeout(() => {
      ctx.seed({ direction: 'incoming', messageType: 'text', text: '請問此訂單約何時出貨？', timestamp: at(t - 1000) })
    }, 300)

    await handleMessageEvent(imageEvent({ timestamp: t }), { workspaceId: WS })

    expect(vi.mocked(showLoadingAnimation)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(replyMessage)).not.toHaveBeenCalled()
  })
})

describe('客人傳的照片：問過之後', () => {
  beforeEach(() => setSettings(true))

  it('問過、客人還沒回應 → 再傳照片不重問、也不亮「輸入中…」', async () => {
    ctx.conversations.set(DOC_ID, { lastImageAskAt: at(Date.now() - 30_000) })
    readsAs('另一張鍋子照片', [])

    await handleMessageEvent(imageEvent(), { workspaceId: WS })

    expect(vi.mocked(replyMessage)).not.toHaveBeenCalled()
    expect(vi.mocked(showLoadingAnimation)).not.toHaveBeenCalled()
    expect(imageOutcomes()).toEqual(['alreadyAsked'])
  })

  it('問過、客人點了選項、AI 也回了 → 再傳的照片是新的一輪，會問', async () => {
    const now = Date.now()
    ctx.conversations.set(DOC_ID, { lastImageAskAt: at(now - 60_000) })
    ctx.seed({ direction: 'incoming', messageType: 'text', text: '瑕疵可以換貨嗎？', timestamp: at(now - 50_000) })
    ctx.seed({ direction: 'outgoing', messageType: 'text', text: '收到後 7 天內可換貨', timestamp: at(now - 45_000) })
    readsAs('新的訂單截圖', [])

    await handleMessageEvent(imageEvent(), { workspaceId: WS })

    expect(repliedTexts()).toEqual([ASK_TEXT])
  })

  it('負責等的那張沒讓出位子（主機中途被砍）→ 45 秒後不再擋住新照片', async () => {
    ctx.conversations.set(DOC_ID, { imageAskWaitingAt: at(Date.now() - 60_000) })
    readsAs('訂單截圖', [])

    await handleMessageEvent(imageEvent(), { workspaceId: WS })

    expect(repliedTexts()).toEqual([ASK_TEXT])
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
    expect(imageOutcomes()).toEqual(['suppressed'])
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
  function seedImage(extra: Record<string, unknown> = {}) {
    ctx.seed({
      direction: 'incoming', messageType: 'image', text: '[圖片]',
      mediaDescription: '訂單明細：全自動咖啡機、尚未出貨', mediaReadState: 'ok',
      timestamp: at(Date.now() - 15_000), ...extra,
    })
  }

  it('開關開著：前文的「[圖片]」換成照片說明，並標明是 AI 讀的、不是客人講的', async () => {
    setSettings(true)
    answerOk()
    seedImage()

    await handleMessageEvent(textEvent('請問出貨時間？'), { workspaceId: WS })

    expect(historyTexts()).toContain('[客人傳了一張圖片，AI 讀到：訂單明細：全自動咖啡機、尚未出貨]')
  })

  it('開關關著：維持「[圖片]」——客人收到的是「我只能閱讀文字」，AI 不能引用圖上的東西', async () => {
    setSettings(false)
    answerOk()
    seedImage()

    await handleMessageEvent(textEvent('請問出貨時間？'), { workspaceId: WS })

    expect(historyTexts()).toContain('[圖片]')
    expect(historyTexts().join()).not.toContain('咖啡機')
  })

  it('照片還沒讀完（圖跟字幾乎同時送出）→ 維持「[圖片]」，不會出現空的說明', async () => {
    setSettings(true)
    answerOk()
    seedImage({ mediaDescription: undefined, mediaReadState: undefined })

    await handleMessageEvent(textEvent('請問出貨時間？'), { workspaceId: WS })

    expect(historyTexts()).toContain('[圖片]')
  })

  it('讀圖格式壞掉（那句「說明」其實是模型吐的原文殘段）→ 不交給 AI', async () => {
    setSettings(true)
    answerOk()
    seedImage({ mediaDescription: '{"description":"訂單明細', mediaReadState: 'malformed' })

    await handleMessageEvent(textEvent('請問出貨時間？'), { workspaceId: WS })

    expect(historyTexts()).toContain('[圖片]')
    expect(historyTexts().join()).not.toContain('description')
  })
})
