import { beforeEach, describe, expect, it, vi } from 'vitest'

// Nuxt auto-import（handler.ts 只在組 imagemap 網址時用到）
vi.stubGlobal('useRuntimeConfig', () => ({}))

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__del__', increment: (n: number) => `__inc:${n}__` },
  Timestamp: { now: () => ({ toMillis: () => 0 }), fromMillis: (m: number) => ({ toMillis: () => m }) },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('./line', () => ({
  replyMessage: vi.fn(async () => ({})),
  pushMessage: vi.fn(async () => ({})),
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
vi.mock('./claim-push-health', () => ({
  recordClaimPushMarkFailure: vi.fn(async () => {}),
  clearClaimPushMarkFailure: vi.fn(async () => {}),
}))
vi.mock('./ai-answer', () => ({
  answerWithAi: vi.fn(), routeMessage: vi.fn(), summarizeHandoffContext: vi.fn(),
  truncateLabel: (s: string) => s,
}))
vi.mock('./ai-settings', () => ({ getAiSettings: vi.fn(async () => null) }))
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn() }))
vi.mock('./ai-handoff-notify', () => ({ notifyHandoffToStaff: vi.fn() }))
vi.mock('./ai-scripts', () => ({
  advanceScript: vi.fn(), loadActiveScripts: vi.fn(async () => []), startScript: vi.fn(),
}))

import { handleFollowEvent } from './handler'
import { getDb } from './firebase'
import { pushMessage, replyMessage } from './line'
import { enterModule } from './conversation-session'
import { loadActiveScripts, startScript } from './ai-scripts'

const WS = 'ws1'
const LINE_UID = 'U0000000000000000000000000000001'
const MODULE_ID = 'welcome-module'
const REPLY_TOKEN = 'rt-1'

/** 觸發來源判定吃的是真的 shared 函式（沒 mock），所以腳本要長得像真文件 */
function followScript(over: Record<string, any> = {}) {
  return {
    id: 'fs1', workspaceId: WS, name: '加好友歡迎', enabled: true, priority: 50,
    rootNodeId: 't',
    nodes: [
      { id: 't', type: 'trigger', triggerEvent: 'follow', matchMode: 'keyword', keywordMatch: 'any', keywords: [], priority: 50, next: 'r', ...over },
      { id: 'r', type: 'reply', text: '歡迎！', thenHandoff: false },
    ],
  } as any
}

function messageScript() {
  return {
    id: 'ms1', workspaceId: WS, name: '退換貨', enabled: true, priority: 50,
    rootNodeId: 't',
    nodes: [
      { id: 't', type: 'trigger', matchMode: 'keyword', keywords: ['退貨'], priority: 50, next: 'r' },
      { id: 'r', type: 'reply', text: 'ok', thenHandoff: false },
    ],
  } as any
}

const REPLY_RESULT = { replyText: '歡迎！', thenHandoff: false, finished: true, completed: true }

/**
 * 假 Firestore：撐起 ensureUser、leadClaims 查詢與搶鎖、flows 讀取、存訊息、冷卻交易。
 * opts.withClaim = 這位客人有一張待套用的活動 claim（模組推播）。
 * opts.userScriptCooldowns = 冷卻交易讀到的 users.scriptCooldowns。
 */
function makeDb(opts: { withClaim?: boolean; userScriptCooldowns?: Record<string, number> } = {}) {
  const claim = {
    lineUserId: LINE_UID,
    workspaceId: WS,
    status: 'claimed',
    tagIds: [],
    action: { type: 'module', moduleId: MODULE_ID, text: '', uri: '' },
    moduleId: MODULE_ID,
  }
  const claimRef = {
    get: vi.fn(async () => ({ exists: true, data: () => claim })),
    set: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
  }

  const chainable = (docs: any[]) => {
    const q: any = {
      where: vi.fn(() => q),
      limit: vi.fn(() => q),
      orderBy: vi.fn(() => q),
      get: vi.fn(async () => ({ empty: docs.length === 0, size: docs.length, docs })),
    }
    return q
  }

  const messagesCol = { doc: vi.fn(() => ({ set: vi.fn(async () => {}) })) }

  const db: any = {
    collection: vi.fn((col: string) => {
      if (col === 'leadClaims') {
        const docs = opts.withClaim ? [{ id: 'claim-1', ref: claimRef, data: () => claim }] : []
        return { ...chainable(docs), doc: vi.fn(() => claimRef) }
      }
      if (col === 'flows') {
        return {
          doc: vi.fn(() => ({
            get: vi.fn(async () => ({
              exists: true,
              data: () => ({ isActive: true, moduleType: 'bot_flow', messages: [{ type: 'text', text: 'hi' }], name: '歡迎模組' }),
            })),
          })),
        }
      }
      if (col === 'conversations') {
        return {
          doc: vi.fn(() => ({
            get: vi.fn(async () => ({ exists: true, data: () => ({ workspaceId: WS }) })),
            set: vi.fn(async () => {}),
            collection: vi.fn(() => messagesCol),
          })),
        }
      }
      // users 等其餘集合
      return {
        ...chainable([]),
        doc: vi.fn(() => ({
          get: vi.fn(async () => ({ exists: true, data: () => ({ displayName: '測試客人', userId: LINE_UID }) })),
          set: vi.fn(async () => {}),
          update: vi.fn(async () => {}),
        })),
      }
    }),
    // claimLeadClaimForApply（搶 claim）與 claimScriptCooldown（冷卻）共用：依讀到的資料分流
    runTransaction: vi.fn(async (cb: any) => cb({
      get: vi.fn(async () => ({
        exists: true,
        data: () => (opts.userScriptCooldowns
          ? { scriptCooldowns: opts.userScriptCooldowns }
          : claim),
      })),
      set: vi.fn(),
      update: vi.fn(),
    })),
  }
  return db
}

/**
 * C-56 加好友歡迎腳本：follow 事件 → 找 triggerEvent='follow' 的腳本 → 用 replyToken 回覆。
 * 統計口徑與活動推播同一把尺：蓋 system_notice、不記 bot 首接。
 */
describe('加好友歡迎腳本（runFollowWelcomeScript）', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('有 follow 腳本＋帶 replyToken → 啟動腳本、用 reply 送出、蓋 system_notice 章', async () => {
    vi.mocked(getDb).mockReturnValue(makeDb())
    vi.mocked(loadActiveScripts).mockResolvedValue([followScript()])
    vi.mocked(startScript).mockResolvedValue({ ...REPLY_RESULT })

    await handleFollowEvent(LINE_UID, undefined, WS, { replyToken: REPLY_TOKEN, requestOrigin: 'https://app.test' })

    expect(vi.mocked(startScript)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(startScript).mock.calls[0]![0]).toMatchObject({ id: 'fs1' })
    expect(vi.mocked(replyMessage)).toHaveBeenCalledWith(REPLY_TOKEN, expect.arrayContaining([expect.objectContaining({ text: '歡迎！' })]), WS)
    // 客人沒問就送的訊息＝system_notice，不記 bot 首接（與活動推播同口徑）
    expect(vi.mocked(enterModule)).toHaveBeenCalledWith('sess-1', LINE_UID, 'system_notice', undefined, WS)
  })

  it('沒帶 replyToken（/api/liff/apply 的補套用）→ 不跑歡迎腳本', async () => {
    vi.mocked(getDb).mockReturnValue(makeDb())
    vi.mocked(loadActiveScripts).mockResolvedValue([followScript()])

    await handleFollowEvent(LINE_UID, undefined, WS)

    expect(vi.mocked(startScript)).not.toHaveBeenCalled()
    expect(vi.mocked(replyMessage)).not.toHaveBeenCalled()
  })

  it('活動 claim 已推播成功 → 歡迎腳本讓位（不連轟兩串訊息）', async () => {
    vi.mocked(getDb).mockReturnValue(makeDb({ withClaim: true }))
    vi.mocked(loadActiveScripts).mockResolvedValue([followScript()])

    await handleFollowEvent(LINE_UID, undefined, WS, { replyToken: REPLY_TOKEN, requestOrigin: 'https://app.test' })

    expect(vi.mocked(pushMessage)).toHaveBeenCalledTimes(1) // 活動那則有送
    expect(vi.mocked(startScript)).not.toHaveBeenCalled()
  })

  it('活動 claim 推播失敗 → 客人什麼都沒收到，歡迎腳本照跑', async () => {
    vi.mocked(getDb).mockReturnValue(makeDb({ withClaim: true }))
    vi.mocked(loadActiveScripts).mockResolvedValue([followScript()])
    vi.mocked(startScript).mockResolvedValue({ ...REPLY_RESULT })
    vi.mocked(pushMessage).mockRejectedValueOnce(new Error('LINE 400'))

    await handleFollowEvent(LINE_UID, undefined, WS, { replyToken: REPLY_TOKEN, requestOrigin: 'https://app.test' })

    expect(vi.mocked(startScript)).toHaveBeenCalledTimes(1)
  })

  it('只有訊息型腳本 → 加好友不會誤觸發任何腳本', async () => {
    vi.mocked(getDb).mockReturnValue(makeDb())
    vi.mocked(loadActiveScripts).mockResolvedValue([messageScript()])

    await handleFollowEvent(LINE_UID, undefined, WS, { replyToken: REPLY_TOKEN, requestOrigin: 'https://app.test' })

    expect(vi.mocked(startScript)).not.toHaveBeenCalled()
    expect(vi.mocked(replyMessage)).not.toHaveBeenCalled()
  })

  it('防重複觸發冷卻中（封鎖又解除）→ 這次不再歡迎', async () => {
    vi.mocked(getDb).mockReturnValue(makeDb({ userScriptCooldowns: { fs1: Date.now() - 1_000 } }))
    vi.mocked(loadActiveScripts).mockResolvedValue([followScript({ cooldownMs: 3_600_000 })])

    await handleFollowEvent(LINE_UID, undefined, WS, { replyToken: REPLY_TOKEN, requestOrigin: 'https://app.test' })

    expect(vi.mocked(startScript)).not.toHaveBeenCalled()
  })

  it('結尾是機器人模組 → 模組訊息照送，章一樣蓋 system_notice（不記 bot 首接）', async () => {
    vi.mocked(getDb).mockReturnValue(makeDb())
    vi.mocked(loadActiveScripts).mockResolvedValue([followScript()])
    vi.mocked(startScript).mockResolvedValue({
      replyText: '', moduleId: MODULE_ID, collected: {}, thenHandoff: false, finished: true, completed: true,
    })

    await handleFollowEvent(LINE_UID, undefined, WS, { replyToken: REPLY_TOKEN, requestOrigin: 'https://app.test' })

    expect(vi.mocked(replyMessage)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(enterModule)).toHaveBeenCalledWith('sess-1', LINE_UID, 'system_notice', MODULE_ID, WS)
    expect(vi.mocked(enterModule)).not.toHaveBeenCalledWith('sess-1', LINE_UID, 'bot_flow', MODULE_ID, WS)
  })
})
