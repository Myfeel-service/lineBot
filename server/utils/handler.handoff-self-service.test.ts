/**
 * 轉真人之後，客人自己按的**自助按鈕**照樣回（`D-31`，老闆 2026-10-20「照建議」）。
 *
 * 真實事件（`H-19`）：2026-08-24 客人按「真人客服」之後，41 秒內又按了 34 次——訂單問題 30、
 * 真人客服 7、商品目錄 1——一則都沒回，隔天早上才有人開口。客人只是想自己查訂單。
 *
 * 這支用**多輪**走一遍：會話狀態跟著 handler 自己的動作變（按真人客服 → 進入等真人），
 * 不是每輪手動把狀態設好——要釘的是「轉真人之後的下一下」，不是某個假設好的狀態。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({}))

const session = vi.hoisted(() => ({ status: 'open' as string }))

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
// 會話狀態跟著 handler 的動作走：進「真人客服」＝待真人（同 conversation-session.ts 的 buildEnterModuleUpdates）
vi.mock('./conversation-session', () => ({
  ensureConversationSession: vi.fn(async () => 'sess-1'),
  enterModule: vi.fn(async (_sid: unknown, _uid: unknown, moduleType: string) => {
    if (moduleType === 'live_agent' && session.status !== 'human_handling') session.status = 'pending_human'
  }),
  getSessionStatusCached: vi.fn(async () => session.status),
  onHumanOutgoingMessage: vi.fn(async () => {}),
  recordConversationEvent: vi.fn(async () => {}),
  shouldSuppressInboundBotAutomationForSession: vi.fn(async () =>
    session.status === 'pending_human' || session.status === 'human_handling'),
}))
vi.mock('./ai-answer', () => ({
  answerWithAi: vi.fn(), routeMessage: vi.fn(async () => null), summarizeHandoffContext: vi.fn(async () => ''),
  truncateLabel: (s: string) => s, productsInConversation: vi.fn(() => []),
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
import { enterModule } from './conversation-session'
import { answerWithAi } from './ai-answer'
import { notifyHandoffToStaff } from './ai-handoff-notify'
import { addTagsToUser } from './tagging'
import { encodeTriggerModule } from '~~/shared/action-schema'

const WS = 'ws-self-service'
const LIVE = 'mod-live-agent'
const ORDER = 'mod-order'
const SHIP = 'mod-ship'
const CATALOG = 'mod-catalog'
const NOTE = 'mod-note'

const LIVE_TEXT = '謝謝您！我們的客服人員會很快聯絡您'
const ORDER_TEXT = '請選擇您要詢問的訂單問題'
const CATALOG_TEXT = '這是我們的商品目錄'
const NOTE_TEXT = '請輸入您要新增的訂單備註'

const flows: Record<string, any> = {
  [LIVE]: {
    workspaceId: WS, name: '真人客服', moduleType: 'live_agent', isSystem: true, isActive: true,
    messages: [{ type: 'text', text: LIVE_TEXT }],
  },
  // 照 MYFEEL「✥客服 - 訂單問題模組」的樣子：結尾放一顆「真人客服」快速回覆。
  // ⛔ 有這顆按鈕**不等於**按這個模組會轉真人（MYFEEL 90 個模組有 58 個長這樣）
  [ORDER]: {
    workspaceId: WS, name: '✥客服 - 訂單問題模組', moduleType: 'bot_flow', isActive: true,
    messages: [{
      type: 'quickReply',
      text: ORDER_TEXT,
      quickReplies: [
        { action: { type: 'module', label: '查詢出貨進度', moduleId: SHIP } },
        { action: { type: 'module', label: '真人客服', moduleId: LIVE } },
      ],
    }],
  },
  [CATALOG]: {
    workspaceId: WS, name: '🌸客服 - 商品資訊目錄🌸', moduleType: 'bot_flow', isActive: true,
    messages: [{ type: 'text', text: CATALOG_TEXT }],
  },
  // 要客人接著打字回答的模組（MYFEEL「新增訂單備註模組」）：等真人期間機器人不會接他的答案
  [NOTE]: {
    workspaceId: WS, name: '客服 - 訂單問題 - 新增訂單備註模組', moduleType: 'bot_flow', isActive: true,
    messages: [
      { type: 'text', text: NOTE_TEXT },
      { type: 'userInput', text: '請輸入備註：', moduleId: 'mod-note-done', attribute: 'orderNote' },
    ],
  },
}

function makeDb(lineUserId: string) {
  const writes: { path: string, data: any }[] = []
  return {
    writes,
    db: {
      collection: (col: string) => ({
        where: () => ({ get: vi.fn(async () => ({ empty: true, docs: [] })) }),
        doc: (id?: string) => ({
          get: vi.fn(async () => {
            if (col === 'users')
              return { exists: true, data: () => ({ workspaceId: WS, lineUserId, displayName: '測試客人', isBlocked: false }) }
            if (col === 'flows' && flows[String(id)]) return { exists: true, data: () => flows[String(id)] }
            return { exists: false, data: () => undefined }
          }),
          set: vi.fn(async (data: any) => { writes.push({ path: `${col}/${id}`, data }) }),
          update: vi.fn(async (data: any) => { writes.push({ path: `${col}/${id}`, data }) }),
          collection: (sub: string) => ({
            doc: () => ({ id: 'm', set: vi.fn(async (data: any) => { writes.push({ path: `${col}/${id}/${sub}`, data }) }) }),
          }),
        }),
      }),
    },
  }
}

const press = (uid: string, moduleId: string, tags: string[] = []) => handlePostbackEvent({
  type: 'postback',
  timestamp: Date.now(),
  source: { type: 'user', userId: uid },
  replyToken: `reply-${moduleId}-${Math.random()}`,
  postback: { data: encodeTriggerModule(moduleId, tags) },
} as any, { workspaceId: WS })

const say = (uid: string, text: string) => handleMessageEvent({
  type: 'message',
  timestamp: Date.now(),
  source: { type: 'user', userId: uid },
  replyToken: `reply-text-${Math.random()}`,
  message: { type: 'text', id: `msg-${Math.random()}`, text },
} as any, { workspaceId: WS })

/** 這一輪送出去的所有文字（含快速回覆那則的本文） */
function sentTextsSince(start: number): string[] {
  return vi.mocked(replyMessage).mock.calls.slice(start).flatMap(c => (c[1] as any[]).map(m => String(m?.text ?? '')))
}
const replyCount = () => vi.mocked(replyMessage).mock.calls.length

beforeEach(() => {
  vi.clearAllMocks()
  session.status = 'open'
})

describe('轉真人之後，客人按自助按鈕照樣回（多輪）', () => {
  it('轉真人 → 按「訂單問題」→ 有回；再按「真人客服」→ 不重送模組也不再通知；打字 → AI 不接', async () => {
    // ⛔ 每個 case 換一位客人：安撫語的節流是 module 級的 Map（key = workspaceId:lineUserId）
    const uid = 'U00000000000000000000000000d31a1'
    const { db, writes } = makeDb(uid)
    vi.mocked(getDb).mockReturnValue(db as any)

    // ① 機器人服務中按「真人客服」→ 正式轉真人
    await press(uid, LIVE)
    expect(sentTextsSince(0)).toContain(LIVE_TEXT)
    expect(session.status).toBe('pending_human')
    expect(vi.mocked(notifyHandoffToStaff)).toHaveBeenCalledTimes(1)

    // ② 等真人期間按「訂單問題」（裡面有一顆真人客服按鈕也照樣算自助）→ 照樣回那個模組
    let mark = replyCount()
    await press(uid, ORDER)
    expect(sentTextsSince(mark)).toEqual([ORDER_TEXT])
    // 快速回覆的按鈕也照平常送（客人可以接著點「查詢出貨進度」）
    const sent = vi.mocked(replyMessage).mock.calls[mark]![1] as any[]
    expect(sent[0].quickReply.items.map((i: any) => i.action.label)).toEqual(['查詢出貨進度', '真人客服'])
    // 記帳跟平常一樣（客人收到回覆就要記），但**不會**把會話從等真人改回機器人
    expect(vi.mocked(enterModule)).toHaveBeenCalledWith('sess-1', uid, 'bot_flow', ORDER, WS)
    expect(session.status).toBe('pending_human')

    // ③ 再按一次「真人客服」→ 不重送「會很快聯絡您」、不再通知值班、不重轉
    mark = replyCount()
    await press(uid, LIVE)
    const third = sentTextsSince(mark)
    expect(third.join('')).not.toContain(LIVE_TEXT)
    expect(third).toHaveLength(1)
    expect(third[0]).toContain('已經幫您安排專員')
    expect(vi.mocked(notifyHandoffToStaff)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(enterModule).mock.calls.filter(c => c[2] === 'live_agent')).toHaveLength(1)

    // ④ 打字 → 照舊閉嘴（真人會接）：AI 不答
    mark = replyCount()
    await say(uid, '請問我的訂單出貨了嗎')
    expect(vi.mocked(answerWithAi)).not.toHaveBeenCalled()
    expect(sentTextsSince(mark).join('')).not.toContain(ORDER_TEXT)

    // 同事那邊看得出那則是客人自己按出來的（tooltip 的「來源」）
    const orderReply = writes.find(w => w.path.endsWith('/messages') && w.data.direction === 'outgoing' && w.data.text === ORDER_TEXT)
    expect(orderReply?.data.sender).toBe('bot')
    expect(orderReply?.data.senderName).toContain('客人自己按的')
  })

  it('等真人期間連按「訂單問題」30 次：每一次都有回（跟平常按一樣），不會被當成要擋的洗版', async () => {
    const uid = 'U00000000000000000000000000d31a2'
    vi.mocked(getDb).mockReturnValue(makeDb(uid).db as any)
    session.status = 'pending_human'

    for (let i = 0; i < 30; i++) await press(uid, ORDER)

    expect(sentTextsSince(0).filter(t => t === ORDER_TEXT)).toHaveLength(30)
  })

  it('要客人接著打字回答的模組 → 不回（他的答案機器人不會接），也不留下「等他回答」的狀態', async () => {
    const uid = 'U00000000000000000000000000d31a3'
    const { db, writes } = makeDb(uid)
    vi.mocked(getDb).mockReturnValue(db as any)
    session.status = 'pending_human'

    await press(uid, NOTE)

    expect(sentTextsSince(0).join('')).not.toContain(NOTE_TEXT)
    expect(sentTextsSince(0).join('')).toContain('已經幫您安排專員')
    expect(writes.some(w => w.path.startsWith('users/') && w.data.activeInput)).toBe(false)
  })

  it('自助按鈕上的貼標照常貼（跟平常按一樣）', async () => {
    const uid = 'U00000000000000000000000000d31a4'
    vi.mocked(getDb).mockReturnValue(makeDb(uid).db as any)
    session.status = 'pending_human'

    await press(uid, CATALOG, ['tag-catalog'])

    expect(sentTextsSince(0)).toEqual([CATALOG_TEXT])
    expect(vi.mocked(addTagsToUser)).toHaveBeenCalledWith(`${WS}_${uid}`, ['tag-catalog'], 'system', `postback:${CATALOG}`, WS)
  })
})

describe('真人正在對話中（真人處理中）', () => {
  it('按自助模組 → 照樣回；按「真人客服」→ 完全不出聲（同事就在線上）', async () => {
    const uid = 'U00000000000000000000000000d31b1'
    vi.mocked(getDb).mockReturnValue(makeDb(uid).db as any)
    session.status = 'human_handling'

    await press(uid, CATALOG)
    expect(sentTextsSince(0)).toEqual([CATALOG_TEXT])

    const mark = replyCount()
    await press(uid, LIVE)
    expect(replyCount()).toBe(mark)
    expect(vi.mocked(notifyHandoffToStaff)).not.toHaveBeenCalled()
    expect(session.status).toBe('human_handling')
  })
})
