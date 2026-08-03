import { beforeEach, describe, expect, it, vi } from 'vitest'

// Nuxt auto-import（handler.ts 只在組 imagemap 網址時用到，這裡給空值即可）
vi.stubGlobal('useRuntimeConfig', () => ({}))

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__del__' },
  Timestamp: { now: () => ({ toMillis: () => 0 }), fromMillis: (m: number) => ({ toMillis: () => m }) },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('./line', () => ({
  replyMessage: vi.fn(),
  pushMessage: vi.fn(),
  getUserProfile: vi.fn(async () => ({ displayName: '測試客人', pictureUrl: '' })),
  linkRichMenuIdToUser: vi.fn(),
  showLoadingAnimation: vi.fn(),
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
  shouldSuppressInboundBotAutomationForSession: vi.fn(async () => false),
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

import { handleMessageEvent, handlePostbackEvent, pushSupportPresetActionToUser } from './handler'
import { getDb } from './firebase'
import { pushMessage, replyMessage } from './line'
import { getAiSettings } from './ai-settings'
import { enterModule, onHumanOutgoingMessage } from './conversation-session'

const WS = 'ws1'
const LINE_UID = 'U0000000000000000000000000000001'
const DOC_ID = `${WS}_${LINE_UID}`

beforeEach(() => { vi.clearAllMocks() })

/**
 * 假 Firestore：撐起 ensureUser（users）、saveConversationMessage（conversations/messages）、
 * loadActiveAutoReplyRules（autoReplies 的 where().get()）
 */
function makeDb(opts: { autoReplies?: any[] } = {}) {
  const writes: { path: string; data: any }[] = []
  const userDoc = {
    exists: true,
    data: () => ({ workspaceId: WS, lineUserId: LINE_UID, displayName: '測試客人', isBlocked: false }),
  }

  const ruleDocs = (opts.autoReplies ?? []).map((r, i) => ({ id: r.id ?? `rule-${i}`, data: () => r }))

  const db = {
    collection: (col: string) => ({
      where: () => ({
        get: vi.fn(async () => ({
          empty: col !== 'autoReplies' || ruleDocs.length === 0,
          docs: col === 'autoReplies' ? ruleDocs : [],
        })),
      }),
      doc: (id?: string) => ({
        get: vi.fn(async () => (col === 'users' ? userDoc : { exists: false, data: () => undefined })),
        set: vi.fn(async (data: any) => { writes.push({ path: `${col}/${id}`, data }) }),
        update: vi.fn(async (data: any) => { writes.push({ path: `${col}/${id}`, data }) }),
        collection: (sub: string) => ({
          doc: () => ({
            set: vi.fn(async (data: any) => { writes.push({ path: `${col}/${id}/${sub}`, data }) }),
          }),
        }),
      }),
    }),
  }
  return { db, writes }
}

describe('客服預存送出後要記「真人已接手」', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const { db } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)
  })

  it('文字類預存：送出後呼叫 onHumanOutgoingMessage(不記帳會讓機器人跟真人搶話)', async () => {
    await pushSupportPresetActionToUser(
      DOC_ID,
      { type: 'message', text: '您好，這是預存回覆' } as any,
      null as any,
      'preset-1',
      '',
      WS,
    )

    expect(vi.mocked(pushMessage)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(onHumanOutgoingMessage)).toHaveBeenCalledWith(DOC_ID, WS)
  })

  it('網址類預存：同樣要記真人接手', async () => {
    await pushSupportPresetActionToUser(
      DOC_ID,
      { type: 'uri', uri: 'https://example.com' } as any,
      null as any,
      'preset-2',
      '',
      WS,
    )

    expect(vi.mocked(pushMessage)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(onHumanOutgoingMessage)).toHaveBeenCalledWith(DOC_ID, WS)
  })

  it('送不出去(沒有可發送的訊息)就不該記真人接手', async () => {
    await expect(
      pushSupportPresetActionToUser(DOC_ID, { type: 'none' } as any, null as any, 'preset-3', '', WS),
    ).rejects.toThrow()

    expect(vi.mocked(pushMessage)).not.toHaveBeenCalled()
    expect(vi.mocked(onHumanOutgoingMessage)).not.toHaveBeenCalled()
  })
})

describe('按按鈕命中舊關鍵字規則、回覆是純文字/網址 → 要記機器人首接', () => {
  function postbackEvent(data: string): any {
    return {
      type: 'postback',
      timestamp: 1,
      source: { type: 'user', userId: LINE_UID },
      replyToken: 'reply-token',
      postback: { data },
    }
  }

  it('文字動作的規則：回覆後呼叫 enterModule(先前只有模組分支有記,這條漏掉)', async () => {
    const { db } = makeDb({
      autoReplies: [{
        id: 'r1',
        name: '舊按鈕',
        keyword: 'legacy_button',
        matchType: 'exact',
        isActive: true,
        action: { type: 'message', text: '這是純文字回覆' },
      }],
    })
    vi.mocked(getDb).mockReturnValue(db as any)

    await handlePostbackEvent(postbackEvent('legacy_button'), { workspaceId: WS })

    expect(vi.mocked(replyMessage)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(enterModule)).toHaveBeenCalledWith(
      'sess-1', LINE_UID, 'bot_flow', undefined, WS,
    )
  })

  it('沒有任何規則命中 → 沒回覆就不該記首接(維持真正的未首接)', async () => {
    const { db } = makeDb({ autoReplies: [] })
    vi.mocked(getDb).mockReturnValue(db as any)

    // 換一個 workspaceId：loadActiveAutoReplyRules 有 per-workspace 快取，
    // 沿用上一個 case 的 WS 會讀到上面那條規則
    await handlePostbackEvent(postbackEvent('nothing_matches_this'), { workspaceId: 'ws-empty' })

    expect(vi.mocked(replyMessage)).not.toHaveBeenCalled()
    expect(vi.mocked(enterModule)).not.toHaveBeenCalled()
  })
})

describe('只切換圖文選單的按鈕 → 移出待處理佇列,但不算首接', () => {
  function switchMenuEvent(data: string, nativeSwitch = false): any {
    return {
      type: 'postback',
      timestamp: 1,
      source: { type: 'user', userId: LINE_UID },
      replyToken: 'reply-token',
      postback: { data, ...(nativeSwitch ? { params: { newRichMenuAliasId: 'alias-1' } } : {}) },
    }
  }

  beforeEach(() => {
    const { db } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)
  })

  it('原生瞬間切換：記 system_notice(只動 status,不灌水機器人首接)', async () => {
    await handlePostbackEvent(switchMenuEvent('switchMenu=menu-1', true), { workspaceId: 'ws-sw1' })

    expect(vi.mocked(replyMessage)).not.toHaveBeenCalled()
    expect(vi.mocked(enterModule)).toHaveBeenCalledWith(
      'sess-1', LINE_UID, 'system_notice', undefined, 'ws-sw1',
    )
  })

  it('舊版 postback 回退路徑：也要記(不能只有原生路徑有)', async () => {
    await handlePostbackEvent(switchMenuEvent('switchMenu=menu-1'), { workspaceId: 'ws-sw2' })

    expect(vi.mocked(enterModule)).toHaveBeenCalledWith(
      'sess-1', LINE_UID, 'system_notice', undefined, 'ws-sw2',
    )
  })
})

describe('客人傳圖/影/音/檔 → 回引導語就要記機器人首接', () => {
  function mediaEvent(type: string): any {
    return {
      type: 'message',
      timestamp: 1,
      source: { type: 'user', userId: LINE_UID },
      replyToken: 'reply-token',
      message: { type, id: 'm1' },
    }
  }

  beforeEach(() => {
    const { db } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)
    // 引導語只在 AI 開啟且為自動回覆模式時才發
    vi.mocked(getAiSettings).mockResolvedValue({ enabled: true, replyMode: 'auto' } as any)
  })

  it('圖片：回了引導語 → enterModule 記 bot_flow(不記 ai,避免灌水 AI 答題數)', async () => {
    // 每個 case 換 workspaceId：nonTextAckSentAt 是 module 級節流表，會跨測試殘留
    await handleMessageEvent(mediaEvent('image'), { workspaceId: 'ws-img' })

    await vi.waitFor(() => {
      expect(vi.mocked(replyMessage)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(enterModule)).toHaveBeenCalledWith(
        'sess-1', LINE_UID, 'bot_flow', undefined, 'ws-img',
      )
    })
  })

  it('貼圖：刻意不回 → 不記首接(維持真正的未首接)', async () => {
    await handleMessageEvent(mediaEvent('sticker'), { workspaceId: 'ws-sticker' })

    // 給 fire-and-forget 的分支足夠時間跑完再確認什麼都沒發生
    await new Promise(r => setTimeout(r, 10))
    expect(vi.mocked(replyMessage)).not.toHaveBeenCalled()
    expect(vi.mocked(enterModule)).not.toHaveBeenCalled()
  })

  it('AI 未開啟：不發引導語,也不記首接', async () => {
    vi.mocked(getAiSettings).mockResolvedValue({ enabled: false, replyMode: 'auto' } as any)
    await handleMessageEvent(mediaEvent('image'), { workspaceId: 'ws-aioff' })

    await new Promise(r => setTimeout(r, 10))
    expect(vi.mocked(replyMessage)).not.toHaveBeenCalled()
    expect(vi.mocked(enterModule)).not.toHaveBeenCalled()
  })
})
