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
import { answerWithAi } from './ai-answer'

const WS = 'ws-turn'
let LINE_UID = ''
let DOC_ID = ''
let uidSeq = 0

interface WrittenDoc { id: string; data: any }

/**
 * 這支測的是「泡泡 ↔ 回合」的那條線，所以 mock 要**分開記錄**兩個子集合的寫入：
 * messages（客人看到的那則）與 aiTurns（當時的判斷）。兩邊的 id 對不上，
 * 畫面上的「為什麼這樣答」就會指到別的回合——正是這次要根治的問題。
 */
function makeDb() {
  const conversations = new Map<string, Record<string, unknown>>()
  const messages: WrittenDoc[] = []
  const turns: WrittenDoc[] = []
  let autoSeq = 0

  const userDoc = {
    exists: true,
    data: () => ({ workspaceId: WS, lineUserId: LINE_UID, displayName: '測試客人', isBlocked: false }),
  }

  const subCollection = (name: string) => ({
    doc: (docId?: string) => {
      // 沒帶 id＝要一個新的（newAiTurnId 就是這樣拿 turn id 的，真實 Firestore 也不打網路）
      const id = docId ?? `auto-${++autoSeq}`
      return {
        id,
        get: vi.fn(async () => ({ exists: false, data: () => undefined })),
        set: vi.fn(async (data: any) => {
          const sink = name === 'aiTurns' ? turns : messages
          sink.push({ id, data })
        }),
      }
    },
    orderBy: () => ({ limit: () => ({ get: vi.fn(async () => ({ docs: [] })) }) }),
  })

  const db = {
    collection: (col: string) => ({
      where: () => ({ get: vi.fn(async () => ({ empty: true, docs: [] })) }),
      doc: (id?: string) => ({
        get: vi.fn(async () => {
          if (col === 'users') return userDoc
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
        collection: subCollection,
      }),
    }),
  }
  return { db, conversations, messages, turns }
}

function textEvent(text: string): any {
  return {
    type: 'message',
    timestamp: Date.now(),
    source: { type: 'user', userId: LINE_UID },
    replyToken: 'reply-token-1',
    message: { type: 'text', id: 'msg-1', text },
  }
}

function setSettings() {
  vi.mocked(getAiSettings).mockResolvedValue({
    enabled: true,
    replyMode: 'auto',
    sensitiveTopics: [],
    imageAnswer: { enabled: false },
    confidenceThreshold: 0.75,
    disambiguation: { enabled: false, top1Min: 0.7, top1Max: 0.85, maxSpread: 0.1, maxOptions: 3, cooldownMinutes: 10 },
    handoffNotify: { enabled: false, lineUserIds: [], displayNames: {}, slaRemindMinutes: 10 },
    serviceHours: { enabled: false, start: '09:00', end: '18:00', weekendOff: true, dndReply: '' },
  } as any)
}

let ctx: ReturnType<typeof makeDb>

beforeEach(() => {
  vi.clearAllMocks()
  LINE_UID = `U${String(++uidSeq).padStart(32, '0')}`
  DOC_ID = `${WS}_${LINE_UID}`
  ctx = makeDb()
  vi.mocked(getDb).mockReturnValue(ctx.db as any)
  setSettings()
})

/** 這一則 outgoing 是 AI 送出的那一則（客人自己那則是 incoming） */
function outgoingWithTurn() {
  return ctx.messages.filter(m => m.data.direction === 'outgoing' && m.data.aiTurnId)
}

describe('每一則 AI 回覆都留下自己的脈絡', () => {
  it('答題：訊息上的 aiTurnId 指得到那一筆回合，內容就是當時的判斷', async () => {
    vi.mocked(answerWithAi).mockResolvedValue({
      decision: 'answered',
      answer: '保固是兩年。',
      confidence: 0.91,
      sources: [{ chunkId: 'chunk-a' }, { chunkId: 'chunk-b' }],
      handoffReason: null,
      answerKind: 'kb',
    } as any)

    await handleMessageEvent(textEvent('保固多久'), { workspaceId: WS })

    const outgoing = outgoingWithTurn()
    expect(outgoing).toHaveLength(1)
    expect(ctx.turns).toHaveLength(1)

    // 這一行就是整個治本的重點：泡泡指的回合必須真的存在
    expect(ctx.turns[0]!.id).toBe(outgoing[0]!.data.aiTurnId)

    const turn = ctx.turns[0]!.data
    expect(turn.decision).toBe('answered')
    expect(turn.query).toBe('保固多久')
    expect(turn.confidence).toBe(0.91)
    expect(turn.sourceChunkIds).toEqual(['chunk-a', 'chunk-b'])
    expect(turn.workspaceId).toBe(WS)
  })

  it('回合與 aiMeta 講的是同一件事（一個是歷史、一個是現在的狀態，內容不能各說各話）', async () => {
    vi.mocked(answerWithAi).mockResolvedValue({
      decision: 'answered', answer: '有的。', confidence: 0.88,
      sources: [{ chunkId: 'chunk-a' }], handoffReason: null, answerKind: 'kb',
    } as any)

    await handleMessageEvent(textEvent('有沒有現貨'), { workspaceId: WS })

    const meta = (ctx.conversations.get(DOC_ID) as any).aiMeta
    const turn = ctx.turns[0]!.data
    expect(turn.decision).toBe(meta.lastDecision)
    expect(turn.query).toBe(meta.lastQuery)
    expect(turn.confidence).toBe(meta.lastConfidence)
    expect(turn.sourceChunkIds).toEqual(meta.lastSourceChunkIds)
  })

  it('連續兩題各留一筆，不會互相覆寫（舊回合標得到，就是靠這個）', async () => {
    vi.mocked(answerWithAi).mockResolvedValue({
      decision: 'answered', answer: '第一題的答案', confidence: 0.9,
      sources: [{ chunkId: 'chunk-a' }], handoffReason: null, answerKind: 'kb',
    } as any)
    await handleMessageEvent(textEvent('第一個問題'), { workspaceId: WS })

    vi.mocked(answerWithAi).mockResolvedValue({
      decision: 'answered', answer: '第二題的答案', confidence: 0.6,
      sources: [{ chunkId: 'chunk-z' }], handoffReason: null, answerKind: 'kb',
    } as any)
    await handleMessageEvent(textEvent('第二個問題'), { workspaceId: WS })

    expect(ctx.turns).toHaveLength(2)
    expect(ctx.turns[0]!.id).not.toBe(ctx.turns[1]!.id)
    // 第一題的脈絡仍然完好——先前這裡會被 aiMeta 整份蓋掉，那一題就再也標不到答錯
    expect(ctx.turns[0]!.data.query).toBe('第一個問題')
    expect(ctx.turns[0]!.data.sourceChunkIds).toEqual(['chunk-a'])
    expect(ctx.turns[1]!.data.query).toBe('第二個問題')

    // 兩顆泡泡各自指向自己的那一筆
    const outgoing = outgoingWithTurn()
    expect(outgoing).toHaveLength(2)
    expect(outgoing.map(m => m.data.aiTurnId)).toEqual([ctx.turns[0]!.id, ctx.turns[1]!.id])
  })

  it('先問「要不要轉接」（no_grounding 走二次確認）：那顆泡泡也指得回這一次判斷', async () => {
    vi.mocked(answerWithAi).mockResolvedValue({
      decision: 'handoff', answer: '', confidence: 0.3,
      sources: [], handoffReason: 'no_grounding', answerKind: 'kb',
    } as any)

    await handleMessageEvent(textEvent('這題知識庫沒有'), { workspaceId: WS })

    const outgoing = outgoingWithTurn()
    expect(outgoing).toHaveLength(1)
    expect(outgoing[0]!.data.sender).toBe('ai')
    expect(ctx.turns[0]!.id).toBe(outgoing[0]!.data.aiTurnId)
    expect(ctx.turns[0]!.data.decision).toBe('handoff_confirm')
    expect(ctx.turns[0]!.data.handoffReason).toBe('no_grounding')
  })

  it('直接轉真人：客人看到的是模組文案（sender=bot），但仍指得回「AI 為什麼決定轉人」', async () => {
    // sensitive_topic 不在二次確認名單裡 → 直接走 deliverHandoffReply 送出模組文案
    vi.mocked(answerWithAi).mockResolvedValue({
      decision: 'handoff', answer: '', confidence: 0.2,
      sources: [], handoffReason: 'sensitive_topic', answerKind: 'kb',
    } as any)

    await handleMessageEvent(textEvent('我要申訴退費'), { workspaceId: WS })

    const outgoing = outgoingWithTurn()
    expect(outgoing.length).toBeGreaterThan(0)
    // 文案出自「真人客服」模組（要改文案去那裡改），但脈絡屬於這一次 AI 判斷
    expect(outgoing[0]!.data.sender).toBe('bot')
    expect(ctx.turns[0]!.id).toBe(outgoing[0]!.data.aiTurnId)
    expect(ctx.turns[0]!.data.decision).toBe('handoff')
    expect(ctx.turns[0]!.data.handoffReason).toBe('sensitive_topic')
  })
})
