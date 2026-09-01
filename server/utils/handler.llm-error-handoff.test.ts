/**
 * AI 服務打不通（`llm_error`）時，要走**和其他轉真人原因一樣**的完整流程。
 *
 * 這支測試存在的理由是一場真的災情（2026-09-01，MYFEEL 正式資料還原）：
 *   15:04:02 客人問「乾淨方max 晚上開賣，什麼時候可以拿到呢」
 *   15:04:07 判成 llm_error → **客人一個字都沒收到**
 *   15:06:33 客人傳貼圖試探 → 還是沒有回應
 *   15:29:09 客人自己連按三次「真人客服」才被接住（中間 25 分鐘全靜音）
 *
 * 當時的程式只寫 aiMeta ＋ 呼叫 notifyHandoffToStaff，沒有走 deliverHandoffReply。
 * 後果不只是「客人沒收到」——session 沒進 live_agent，就不在待處理佇列裡；而通知模式
 * 若是 `missed_only`（MYFEEL 正是），當下不推播、只把內容存起來，回頭撈它的
 * remindOverdueHandoffs **只掃 pending_human 的 session** → 那則通知永遠不會送出。
 *
 * 所以下面每一條都對應那場災情的一個環節，⛔ 不要因為「反正 AI 壞了」就放寬。
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
  getUserProfile: vi.fn(async () => ({ displayName: '小古', pictureUrl: '' })),
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
  getAiSettings: vi.fn(async () => ({
    enabled: true, replyMode: 'auto', sensitiveTopics: [], disambiguation: { cooldownMinutes: 0 },
  })),
}))
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn(async () => {}) }))
vi.mock('./ai-handoff-notify', () => ({ notifyHandoffToStaff: vi.fn(async () => {}) }))
vi.mock('./ai-scripts', () => ({
  advanceScript: vi.fn(), loadActiveScripts: vi.fn(async () => []), startScript: vi.fn(),
}))
vi.mock('./conversation-media', () => ({ archiveConversationMedia: vi.fn(async () => ({ ok: false })) }))
vi.mock('./media-describe', () => ({ readInboundImage: vi.fn(async () => ({ description: '', question: '' })) }))

import { handleMessageEvent } from './handler'
import { getDb } from './firebase'
import { replyMessage } from './line'
import { answerWithAi } from './ai-answer'
import { getAiSettings } from './ai-settings'
import { enterModule, getSessionStatusCached, shouldSuppressInboundBotAutomationForSession } from './conversation-session'
import { notifyHandoffToStaff } from './ai-handoff-notify'

/** 服務時間內、AI 全自動；clearAllMocks 不還原 mockResolvedValue，每個測試自己設回來 */
const AI_SETTINGS = (replyMode: 'auto' | 'draft' = 'auto') => ({
  enabled: true, replyMode, sensitiveTopics: [], disambiguation: { cooldownMinutes: 0 },
})

const WS = 'ws-llm-error'
/** 那場災情裡客人真正打的那句話 */
const QUERY = '乾淨方max 晚上開賣，什麼時候可以拿到呢'
const UID = 'U0120d558b84576088aacff06e77b46a7'

/** 這一輪寫進 conversations doc 的東西（aiMeta 要驗，不能只驗有沒有呼叫） */
let conversations: Map<string, Record<string, any>>
/** 寫進 aiTurns 子集合的回合快照 */
let turns: Record<string, any>[]

function makeDb(opts: { flows?: Record<string, any> } = {}) {
  const flows = opts.flows ?? {}
  conversations = new Map()
  turns = []
  let autoId = 0
  const emptyQuery: any = {
    where: () => emptyQuery,
    orderBy: () => emptyQuery,
    limit: () => emptyQuery,
    get: vi.fn(async () => ({ empty: true, docs: [] })),
  }
  return {
    collection: (col: string) => ({
      where: () => emptyQuery,
      doc: (id?: string) => ({
        get: vi.fn(async () => {
          if (col === 'users') {
            return { exists: true, data: () => ({ workspaceId: WS, lineUserId: UID, displayName: '小古', isBlocked: false }) }
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
        collection: (sub: string) => ({
          ...emptyQuery,
          doc: (docId?: string) => ({
            id: docId ?? `auto-${++autoId}`,
            set: vi.fn(async (data: any) => { if (sub === 'aiTurns') turns.push(data) }),
          }),
        }),
      }),
    }),
  }
}

function textEvent(text: string, atMs: number): any {
  return {
    type: 'message',
    timestamp: atMs,
    source: { type: 'user', userId: UID },
    replyToken: `reply-${atMs}`,
    message: { type: 'text', id: `msg-${atMs}`, text },
  }
}

function sentTexts(): string[] {
  return vi.mocked(replyMessage).mock.calls.flatMap(c => (c[1] as any[]).map(m => String(m?.text ?? '')))
}

/** 這一輪寫下的 aiMeta */
function writtenAiMeta(): any {
  return Array.from(conversations.values()).map(v => v.aiMeta).filter(Boolean).at(-1)
}

/** answerWithAi 回「AI 服務打不通」 */
function aiServiceDown(errorDetail = '生成回答：Gemini error (503): The model is overloaded.') {
  vi.mocked(answerWithAi).mockResolvedValue({
    decision: 'handoff',
    answer: '',
    confidence: 0,
    sources: [],
    handoffReason: 'llm_error',
    errorDetail,
  } as any)
}

describe('AI 服務打不通 → 要真的轉真人（不是只寫一筆紀錄）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(shouldSuppressInboundBotAutomationForSession).mockResolvedValue(false)
    vi.mocked(getSessionStatusCached).mockResolvedValue('open' as any)
    vi.mocked(getAiSettings).mockResolvedValue(AI_SETTINGS() as any)
    vi.mocked(getDb).mockReturnValue(makeDb({
      flows: {
        [`${WS}_live_agent`]: {
          workspaceId: WS, name: '真人客服', moduleType: 'live_agent', isActive: true,
          messages: [{ type: 'text', text: '謝謝您！我們的客服人員會很快聯絡您', buttons: [] }],
        },
      },
    }) as any)
    aiServiceDown()
  })

  it('客人會收到一句話——不再是 25 分鐘已讀不回', async () => {
    await handleMessageEvent(textEvent(QUERY, Date.now()), { workspaceId: WS })
    expect(sentTexts()).toContain('謝謝您！我們的客服人員會很快聯絡您')
  })

  it('會進 live_agent＝這場真的排進待處理佇列（災情裡少的就是這一步）', async () => {
    await handleMessageEvent(textEvent(QUERY, Date.now()), { workspaceId: WS })
    expect(vi.mocked(enterModule).mock.calls.some(c => c[2] === 'live_agent')).toBe(true)
  })

  it('值班客服會被通知，而且原因寫的是 llm_error', async () => {
    await handleMessageEvent(textEvent(QUERY, Date.now()), { workspaceId: WS })
    expect(vi.mocked(notifyHandoffToStaff)).toHaveBeenCalledWith(
      expect.objectContaining({ customerLineUserId: UID, reason: 'llm_error', customerMessage: QUERY }),
    )
  })

  it('失敗原因存得下來——事後查得到是哪一種失敗，不是只有「失敗」兩個字', async () => {
    await handleMessageEvent(textEvent(QUERY, Date.now()), { workspaceId: WS })
    expect(writtenAiMeta()).toMatchObject({
      lastDecision: 'handoff',
      lastHandoffReason: 'llm_error',
      lastQuery: QUERY,
      lastErrorDetail: '生成回答：Gemini error (503): The model is overloaded.',
    })
    // aiMeta 每輪覆寫，逐回合的 aiTurns 才是事後查得到的那份
    expect(turns.at(-1)).toMatchObject({ handoffReason: 'llm_error', errorDetail: expect.stringContaining('503') })
  })

  it('答題流程整個丟例外（不是回 handoff）也走同一條路', async () => {
    vi.mocked(answerWithAi).mockRejectedValue(Object.assign(new Error('boom'), { statusCode: 502, statusMessage: 'Gemini error: network error: fetch failed' }))
    await handleMessageEvent(textEvent(QUERY, Date.now()), { workspaceId: WS })

    expect(sentTexts()).toContain('謝謝您！我們的客服人員會很快聯絡您')
    expect(vi.mocked(enterModule).mock.calls.some(c => c[2] === 'live_agent')).toBe(true)
    expect(writtenAiMeta().lastErrorDetail).toContain('network error')
  })

  it('⛔ 下一輪成功時不可以還掛著上一輪的失敗原因', async () => {
    await handleMessageEvent(textEvent(QUERY, Date.now()), { workspaceId: WS })
    expect(writtenAiMeta().lastErrorDetail).not.toBe('')

    vi.mocked(answerWithAi).mockResolvedValue({
      decision: 'answered', answer: '大約 3–5 個工作天到貨', confidence: 0.9, sources: [], handoffReason: null,
    } as any)
    await handleMessageEvent(textEvent('那運費呢', Date.now() + 60_000), { workspaceId: WS })

    expect(writtenAiMeta()).toMatchObject({ lastDecision: 'answered', lastErrorDetail: '' })
  })

  it('草稿模式：不對客人發話、不鎖 session，但客服照樣被通知', async () => {
    vi.mocked(getAiSettings).mockResolvedValue(AI_SETTINGS('draft') as any)
    await handleMessageEvent(textEvent(QUERY, Date.now()), { workspaceId: WS })

    expect(sentTexts().some(t => t.includes('客服人員會很快聯絡您'))).toBe(false)
    expect(vi.mocked(enterModule).mock.calls.some(c => c[2] === 'live_agent')).toBe(false)
    expect(vi.mocked(notifyHandoffToStaff)).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'llm_error' }),
    )
  })
})
