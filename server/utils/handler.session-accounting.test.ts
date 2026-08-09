import { beforeEach, describe, expect, it, vi } from 'vitest'

// Nuxt auto-import（handler.ts 只在組 imagemap 網址時用到，這裡給空值即可）
vi.stubGlobal('useRuntimeConfig', () => ({}))

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__del__' },
  Timestamp: { now: () => ({ toMillis: () => 0 }), fromMillis: (m: number) => ({ toMillis: () => m }) },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('./line', () => ({
  // 必須回 Promise：member-line-bind 會直接 .replyMessage(...).catch()
  replyMessage: vi.fn(async () => {}),
  pushMessage: vi.fn(),
  getUserProfile: vi.fn(async () => ({ displayName: '測試客人', pictureUrl: '' })),
  linkRichMenuIdToUser: vi.fn(),
  // 必須回 Promise：呼叫端會直接 .catch()，回 undefined 會炸
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
import { ensureConversationSession, enterModule, onHumanOutgoingMessage, recordConversationEvent } from './conversation-session'

const WS = 'ws1'
const LINE_UID = 'U0000000000000000000000000000001'
const DOC_ID = `${WS}_${LINE_UID}`

beforeEach(() => { vi.clearAllMocks() })

/**
 * 假 Firestore：撐起 ensureUser（users）、saveConversationMessage（conversations/messages）、
 * 腳本／設定等集合的 where().get()
 */
function makeDb(opts: { scripts?: any[] } = {}) {
  const writes: { path: string; data: any }[] = []
  const userDoc = {
    exists: true,
    data: () => ({ workspaceId: WS, lineUserId: LINE_UID, displayName: '測試客人', isBlocked: false }),
  }

  const scriptDocs = (opts.scripts ?? []).map((r, i) => ({ id: r.id ?? `script-${i}`, data: () => r }))

  const db = {
    collection: (col: string) => ({
      where: () => ({
        get: vi.fn(async () => ({
          empty: col !== 'scripts' || scriptDocs.length === 0,
          docs: col === 'scripts' ? scriptDocs : [],
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

/**
 * 選單切換的口徑（2026-08 改）：**完全不動會話**。
 *
 * 原本是「建 session + 記一筆 system_notice 把它移出待處理」，兩個問題：
 *   1. 客人只是點了一下選單，對話紀錄上卻長出一行系統事件。
 *   2. 距上次互動超過 24 小時時，這一下點擊會關掉舊會話、開一場空的新會話——
 *      實測畫面上只剩「新會話開始」一行、狀態掛在待處理，客服完全看不出客人做了什麼。
 */
describe('只切換圖文選單的按鈕 → 完全不動會話（不建立、不記錄）', () => {
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

  it('原生瞬間切換：不建立會話、不寫任何對話紀錄', async () => {
    await handlePostbackEvent(switchMenuEvent('switchMenu=menu-1', true), { workspaceId: 'ws-sw1' })

    expect(vi.mocked(replyMessage)).not.toHaveBeenCalled()
    expect(vi.mocked(ensureConversationSession)).not.toHaveBeenCalled()
    expect(vi.mocked(enterModule)).not.toHaveBeenCalled()
    expect(vi.mocked(recordConversationEvent)).not.toHaveBeenCalled()
  })

  it('舊版 postback 回退路徑：同樣不動會話(兩條切換路徑口徑要一致)', async () => {
    await handlePostbackEvent(switchMenuEvent('switchMenu=menu-1'), { workspaceId: 'ws-sw2' })

    expect(vi.mocked(ensureConversationSession)).not.toHaveBeenCalled()
    expect(vi.mocked(enterModule)).not.toHaveBeenCalled()
    expect(vi.mocked(recordConversationEvent)).not.toHaveBeenCalled()
  })

  it('觸發模組的按鈕不受影響：那是在跟店家說話,照常建立會話', async () => {
    await handlePostbackEvent(switchMenuEvent('triggerModule=some-module'), { workspaceId: 'ws-sw3' })

    expect(vi.mocked(ensureConversationSession)).toHaveBeenCalled()
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

describe('成員傳綁定碼 → 系統回覆完就要移出待處理', () => {
  function textEvent(text: string): any {
    return {
      type: 'message',
      timestamp: 1,
      source: { type: 'user', userId: LINE_UID },
      replyToken: 'reply-token',
      message: { type: 'text', id: 'm1', text },
    }
  }

  beforeEach(() => {
    const { db } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)
    // clearAllMocks 不會清掉前面 describe 設的 mockResolvedValue,明確歸零
    vi.mocked(getAiSettings).mockResolvedValue(null as any)
  })

  it('綁定訊息被消化(含查無此碼)→ 記 system_notice,否則會話永遠掛在待處理', async () => {
    await handleMessageEvent(textEvent('綁定 G9QCKC'), { workspaceId: WS })

    // 系統已回覆綁定結果(這裡是查無此碼的 ❌),會話不該留在待處理佇列
    expect(vi.mocked(replyMessage)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(enterModule)).toHaveBeenCalledWith(
      'sess-1', LINE_UID, 'system_notice', undefined, WS,
    )
  })

  it('一般文字不是綁定訊息 → 不蓋 system_notice 章', async () => {
    await handleMessageEvent(textEvent('請問有貨嗎'), { workspaceId: WS })

    expect(vi.mocked(enterModule)).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 'system_notice', expect.anything(), expect.anything(),
    )
  })
})
