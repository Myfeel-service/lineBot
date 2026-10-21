/**
 * 客人只丟訂單資料、沒說要做什麼 → 先問他想詢問什麼（`D-133`，2026-10-19 老闆拍板）。多輪走完：
 *   丟資料 → 機器人問（附三顆按鈕、不扣則）
 *     → 點「什麼時候出貨」→ 不進流程、AI 答（認商品看得到他前面點過的按鈕）
 *     → 點「修改訂單資料」→ 店家的「查詢訂單」流程（真的引擎）撿到前面那筆編號、不再問一次
 *
 * 流程引擎用真的（startScript／advanceScript），只把「讀這個帳號有哪些流程」換掉；
 * 假資料庫會記住寫進去的東西（客人資料、對話），下一輪讀得到——多輪靠的就是這一點。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({}))

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => { const t = Date.now(); return { toMillis: () => t } },
    delete: () => '__del__',
    increment: (n: number) => ({ __inc: n }),
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
  getUserProfile: vi.fn(async () => ({ displayName: '白', pictureUrl: '' })),
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
  productsInConversation: vi.fn(async () => null),
  routeMessage: vi.fn(async () => null),
  summarizeHandoffContext: vi.fn(async () => ''),
  truncateLabel: (s: string) => s,
}))
vi.mock('./ai-settings', () => ({ getAiSettings: vi.fn() }))
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn(async () => {}) }))
vi.mock('./ai-handoff-notify', () => ({ notifyHandoffToStaff: vi.fn(async () => {}) }))
vi.mock('./ai-scripts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ai-scripts')>()),
  loadActiveScripts: vi.fn(async () => []),
}))
vi.mock('./reply-quota', () => ({ isReplyQuotaExhausted: vi.fn(async () => false) }))

import { handleMessageEvent } from './handler'
import { getDb } from './firebase'
import { replyMessage } from './line'
import { getAiSettings } from './ai-settings'
import { answerWithAi, routeMessage } from './ai-answer'
import { loadActiveScripts } from './ai-scripts'
import { recordAiUsage } from './ai-usage'
import { enterModule } from './conversation-session'
import { ORDER_INFO_ASK_TEXT, ORDER_INFO_MODIFY_OPTION, ORDER_INFO_SHIP_OPTION } from '~~/shared/order-info-only'

const WS = 'ws-order'
let LINE_UID = ''
let DOC_ID = ''
let uidSeq = 0

/** 10/09 客人「白」打的那一則 */
const BAI = 'M20261007002452KOYK訂單編號\n名字白坤永\n電話0982085948'
const ORDER_NO = 'M20261007002452KOYK'

/**
 * 跟正式站「查詢訂單」同形：問編號 → 問姓名 → 收完轉真人。
 * 開始方式用「客人打特定的字」（訂單／查詢／進度）：這支測的是流程前後那一問，不是比對——
 * 正式站那條是「看意思」，`C-370` 之後要靠 AI 判斷才接得到，測試裡用字確定觸發。
 */
const ORDER_SCRIPT = {
  id: 'script-order', workspaceId: WS, name: '查詢訂單', enabled: true, priority: 50, rootNodeId: 't',
  nodes: [
    { id: 't', type: 'trigger', matchMode: 'keyword', keywords: ['訂單', '查詢', '進度'], examples: [], priority: 50, next: 'c1' },
    { id: 'c1', type: 'collect', question: '您好,請問您的訂單編號是？', fieldName: 'order_id', expireMs: 600000, format: 'alphanumericSymbol', next: 'c2' },
    { id: 'c2', type: 'collect', question: '請問訂購人姓名？', fieldName: 'name', expireMs: 600000, format: 'any', next: 'r1' },
    { id: 'r1', type: 'reply', text: '已收到您的資訊，我們將盡快為您查詢並處理', thenHandoff: true },
  ],
}

const at = (ms: number) => ({ toMillis: () => ms })
const tsOf = (m: Record<string, any>) => m.timestamp?.toMillis?.() ?? 0

type Snap = { exists: boolean; data: () => Record<string, any> | undefined; get: (field: string) => unknown }
const snapOf = (row: Record<string, any> | undefined): Snap => ({ exists: Boolean(row), data: () => row, get: f => row?.[f] })

/** 假 Firestore：客人資料、對話、訊息寫進去讀得到（下一輪要看得到上一輪的記號與訊息） */
function makeDb() {
  const users = new Map<string, Record<string, any>>()
  const messages = new Map<string, Record<string, any>>()
  let storeProfile: Record<string, any> | undefined
  let seq = 0

  const merge = (prev: Record<string, any> | undefined, data: Record<string, any>) => {
    const out = { ...(prev ?? {}) }
    for (const [k, v] of Object.entries(data)) {
      if (v === '__del__') delete out[k]
      else out[k] = v
    }
    return out
  }
  const messagesCollection = {
    doc: (id?: string) => {
      const docId = id ?? `msg-${++seq}`
      return {
        id: docId,
        set: vi.fn(async (data: any, opts?: { merge?: boolean }) => {
          messages.set(docId, opts?.merge ? merge(messages.get(docId), data) : data)
        }),
      }
    },
    orderBy: (_f: string, dir = 'asc') => ({
      limit: (n: number) => ({
        get: vi.fn(async () => ({
          docs: [...messages.entries()]
            .sort(([, a], [, b]) => (dir === 'desc' ? tsOf(b) - tsOf(a) : tsOf(a) - tsOf(b)))
            .slice(0, n)
            .map(([mid, m]) => ({ id: mid, data: () => m })),
        })),
      }),
    }),
  }
  // 回傳型別寫成 any：子集合又指回 docRef，讓 TS 自己推會遞迴推不出來
  const docRef = (col: string, id?: string): any => ({
    id: id ?? `${col}-${++seq}`,
    get: vi.fn(async (): Promise<Snap> => {
      if (col === 'users') return snapOf(users.get(String(id)))
      if (col === 'storeProfiles') return snapOf(storeProfile)
      return snapOf(undefined)
    }),
    set: vi.fn(async (data: any, opts?: { merge?: boolean }) => {
      if (col === 'users') users.set(String(id), opts?.merge ? merge(users.get(String(id)), data) : data)
    }),
    update: vi.fn(async (data: any) => {
      if (col === 'users') users.set(String(id), merge(users.get(String(id)), data))
    }),
    collection: (name: string) => (name === 'messages'
      ? messagesCollection
      : { doc: () => docRef('sub'), orderBy: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }) }),
  })
  const db = {
    collection: (col: string) => ({
      where: () => ({ get: vi.fn(async () => ({ empty: true, docs: [] })) }),
      doc: (id?: string) => docRef(col, id),
    }),
  }
  return {
    db,
    users,
    messages,
    seed: (m: Record<string, any>) => { messages.set(`seed-${++seq}`, m) },
    setStoreIndustry: (industry: string) => {
      storeProfile = { fields: { industry: { value: industry, source: 'owner', updatedAt: 0 } }, siteUrl: '' }
    },
  }
}

let ctx: ReturnType<typeof makeDb>

function textEvent(text: string, replyToken = 'rt-1'): any {
  return {
    type: 'message',
    timestamp: Date.now(),
    source: { type: 'user', userId: LINE_UID },
    replyToken,
    message: { type: 'text', id: `m-${replyToken}`, text },
  }
}

function setSettings(opts: { enabled?: boolean, replyMode?: 'auto' | 'draft' } = {}) {
  vi.mocked(getAiSettings).mockResolvedValue({
    enabled: opts.enabled ?? true,
    replyMode: opts.replyMode ?? 'auto',
    sensitiveTopics: [],
    imageAnswer: { enabled: false },
    confidenceThreshold: 0.75,
    disambiguation: { enabled: false, top1Min: 0.7, top1Max: 0.85, maxSpread: 0.1, maxOptions: 3, cooldownMinutes: 10 },
    handoffNotify: { enabled: false, lineUserIds: [], displayNames: {}, slaRemindMinutes: 10 },
    serviceHours: { enabled: false, start: '09:00', end: '18:00', weekendOff: true, dndReply: '' },
  } as any)
}

/** 第 n 次回覆客人的訊息（從 0 數） */
function reply(n: number): any[] {
  return (vi.mocked(replyMessage).mock.calls[n]?.[1] as any[]) ?? []
}

/** 意圖路由（LLM）把這句送進「查詢訂單」流程——正式站認不出商品的出貨題常被這樣送 */
/**
 * 要走「AI 判斷意思」那條路的 case：把查詢訂單換成正式站那種「看意思」（`C-370` 之後只有這種會交給路由），
 * 再讓路由回答「這句是查詢訂單」。
 */
function routeToOrderScript() {
  const t = ORDER_SCRIPT.nodes[0]!
  vi.mocked(loadActiveScripts).mockResolvedValue([{
    ...ORDER_SCRIPT,
    nodes: [{ ...t, matchMode: 'semantic', keywords: [], examples: ['我想查訂單', '我的訂單進度'] }, ...ORDER_SCRIPT.nodes.slice(1)],
  }] as any)
  vi.mocked(routeMessage).mockResolvedValue({
    scriptId: 'script-order', intent: 'order_status', isFollowup: false, standaloneQuery: '',
    compareItems: [], subQuestions: [], inputTokens: 0, outputTokens: 0,
  } as any)
}

/** 10/09 那場的前文：先點「出貨進度查詢 → 電淨艙」、機器人回「10 月底出貨」 */
function seedButtonClick() {
  const now = Date.now()
  ctx.seed({ direction: 'incoming', messageType: 'customer_action', text: '客人點了「客服 - 出貨進度查詢 - 電淨艙 奇美 靜電集塵空氣清淨機 AP-08SPFG」', payload: { actionType: 'button_module' }, timestamp: at(now - 48_000) })
  ctx.seed({ direction: 'outgoing', messageType: 'text', sender: 'bot', text: '白您好，依原廠公告：商品將於 10 月底 依照訂單順序陸續出貨', timestamp: at(now - 45_000) })
}

beforeEach(() => {
  vi.clearAllMocks()
  LINE_UID = `U${String(++uidSeq).padStart(32, '0')}`
  DOC_ID = `${WS}_${LINE_UID}`
  ctx = makeDb()
  ctx.users.set(DOC_ID, { workspaceId: WS, lineUserId: LINE_UID, displayName: '白', isBlocked: false })
  vi.mocked(getDb).mockReturnValue(ctx.db as any)
  setSettings()
  vi.mocked(loadActiveScripts).mockResolvedValue([ORDER_SCRIPT] as any)
  vi.mocked(routeMessage).mockResolvedValue(null)
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

describe('丟資料 → 機器人先問想詢問什麼', () => {
  it('10/09「白」那則：不進「查詢訂單」流程、不叫 AI，問一句＋三顆按鈕', async () => {
    seedButtonClick()

    await handleMessageEvent(textEvent(BAI), { workspaceId: WS })

    expect(vi.mocked(replyMessage)).toHaveBeenCalledTimes(1)
    const [msg] = reply(0)
    expect(msg.text).toBe(ORDER_INFO_ASK_TEXT)
    expect(msg.quickReply.items.map((i: any) => i.action)).toEqual([
      { type: 'message', label: '什麼時候出貨', text: '請問什麼時候出貨？' },
      { type: 'message', label: '修改訂單資料', text: '我想修改訂單資料' },
      { type: 'message', label: '🙋 找真人', text: '找真人' },
    ])
    expect(vi.mocked(answerWithAi)).not.toHaveBeenCalled()
    // 流程沒啟動（啟動的話客人身上會有進行中的流程）
    expect(ctx.users.get(DOC_ID)?.activeScript).toBeUndefined()
  })

  it('不扣則、記機器人首接；問句存進對話（標「系統」）、記號寫在客人身上——都在 webhook 結束前', async () => {
    await handleMessageEvent(textEvent(BAI), { workspaceId: WS })

    expect(vi.mocked(recordAiUsage)).not.toHaveBeenCalled()
    expect(vi.mocked(enterModule)).toHaveBeenCalledWith('sess-1', LINE_UID, 'bot_flow', undefined, WS)
    const saved = [...ctx.messages.values()].find(m => m.direction === 'outgoing')
    expect(saved).toMatchObject({ text: ORDER_INFO_ASK_TEXT, sender: 'system', senderName: '客人只傳訂單資料時的提問' })
    expect(ctx.users.get(DOC_ID)?.orderInfoAsk).toMatchObject({ text: BAI })
  })

  it('做服務的店（輪廓填「美容／美業」）→ 不放「什麼時候出貨」', async () => {
    ctx.setStoreIndustry('美容／美業')

    await handleMessageEvent(textEvent(BAI), { workspaceId: WS })

    expect(reply(0)[0].quickReply.items.map((i: any) => i.action.label)).toEqual(['修改訂單資料', '🙋 找真人'])
  })

  it('AI 沒開／草稿模式 → 不問，照舊交給店家的流程（按「什麼時候出貨」之後沒人答）', async () => {
    setSettings({ replyMode: 'draft' })

    await handleMessageEvent(textEvent(BAI), { workspaceId: WS })

    // 照舊：「查詢訂單」流程（關鍵字「訂單」）接走，編號先撿到了（`C-343`），直接問姓名
    expect(reply(0)[0].text).toBe('請問訂購人姓名？')
    expect(ctx.users.get(DOC_ID)?.activeScript).toBeTruthy()
  })

  it('有講要做什麼（「…請問何時出貨」）→ 不問', async () => {
    await handleMessageEvent(textEvent(`${ORDER_NO} 請問何時出貨`), { workspaceId: WS })

    expect(reply(0)[0]?.text).not.toBe(ORDER_INFO_ASK_TEXT)
  })

  it('問過了又丟一次資料 → 不重問', async () => {
    await handleMessageEvent(textEvent(BAI), { workspaceId: WS })
    await handleMessageEvent(textEvent(ORDER_NO, 'rt-2'), { workspaceId: WS })

    expect(reply(0)[0].text).toBe(ORDER_INFO_ASK_TEXT)
    expect(reply(1)[0]?.text).not.toBe(ORDER_INFO_ASK_TEXT)
  })
})

describe('問完之後客人點了按鈕', () => {
  it('點「什麼時候出貨」→ 不進流程（意圖路由想送進「查詢訂單」也不會），AI 答；認商品看得到前面點過的電淨艙按鈕', async () => {
    seedButtonClick()
    routeToOrderScript()
    await handleMessageEvent(textEvent(BAI), { workspaceId: WS })

    await handleMessageEvent(textEvent(ORDER_INFO_SHIP_OPTION.text, 'rt-2'), { workspaceId: WS })

    expect(vi.mocked(routeMessage)).not.toHaveBeenCalled()
    expect(ctx.users.get(DOC_ID)?.activeScript).toBeUndefined()
    expect(vi.mocked(answerWithAi)).toHaveBeenCalledTimes(1)
    const input = vi.mocked(answerWithAi).mock.calls[0]![0]
    expect(input.query).toBe(ORDER_INFO_SHIP_OPTION.text)
    expect(input.productHistory?.map(t => t.text).join('\n')).toContain('出貨進度查詢 - 電淨艙')
    // 他丟的那筆資料留在對話裡，AI 讀得到
    expect(input.history?.map(t => t.text).join('\n')).toContain(ORDER_NO)
    expect(reply(1)[0].text).toContain('10 月底')
  })

  it('點「修改訂單資料」→ 店家的「查詢訂單」流程撿到前面那筆編號，直接問下一題（不再問編號）', async () => {
    await handleMessageEvent(textEvent(BAI), { workspaceId: WS })

    await handleMessageEvent(textEvent(ORDER_INFO_MODIFY_OPTION.text, 'rt-2'), { workspaceId: WS })

    expect(reply(1)[0].text).toBe('請問訂購人姓名？')
    expect(ctx.users.get(DOC_ID)?.activeScript).toMatchObject({ currentNodeId: 'c2', collected: { order_id: ORDER_NO } })
    expect(vi.mocked(answerWithAi)).not.toHaveBeenCalled()
  })

  it('對照組：沒問過就直接打「我想修改訂單資料」→ 流程照問編號（證明上一條是靠剛剛那筆資料）', async () => {
    await handleMessageEvent(textEvent(ORDER_INFO_MODIFY_OPTION.text), { workspaceId: WS })

    expect(reply(0)[0].text).toBe('您好,請問您的訂單編號是？')
  })

  it('問過超過 2 小時才點「什麼時候出貨」→ 照一般規則走（認不出商品、意圖路由送進流程 → 流程照問編號）', async () => {
    routeToOrderScript()
    ctx.users.set(DOC_ID, { ...ctx.users.get(DOC_ID), orderInfoAsk: { text: BAI, askedAt: Date.now() - 3 * 60 * 60 * 1000 } })

    await handleMessageEvent(textEvent(ORDER_INFO_SHIP_OPTION.text), { workspaceId: WS })

    expect(vi.mocked(answerWithAi)).not.toHaveBeenCalled()
    expect(reply(0)[0].text).toBe('您好,請問您的訂單編號是？')
  })
})
