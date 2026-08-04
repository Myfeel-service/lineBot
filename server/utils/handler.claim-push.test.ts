import { beforeEach, describe, expect, it, vi } from 'vitest'

// Nuxt auto-import（handler.ts 只在組 imagemap 網址時用到）
vi.stubGlobal('useRuntimeConfig', () => ({}))

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__del__', increment: (n: number) => `__inc:${n}__` },
  Timestamp: { now: () => ({ toMillis: () => 0 }), fromMillis: (m: number) => ({ toMillis: () => m }) },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('./line', () => ({
  replyMessage: vi.fn(),
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
import { pushMessage } from './line'
import { enterModule } from './conversation-session'
import { recordClaimPushMarkFailure } from './claim-push-health'

const WS = 'ws1'
const LINE_UID = 'U0000000000000000000000000000001'
const MODULE_ID = 'welcome-module'

/**
 * 假 Firestore：撐起 ensureUser、leadClaims 查詢與搶鎖、flows 讀取、存訊息。
 * opts.failMessageWrite = 模擬「存對話訊息失敗」（先前這會連帶讓蓋章被跳過）。
 */
function makeDb(opts: { failMessageWrite?: boolean } = {}) {
  const claim = {
    lineUserId: LINE_UID,
    workspaceId: WS,
    status: 'claimed',
    tagIds: [],
    action: { type: 'module', moduleId: MODULE_ID, text: '', uri: '' },
    moduleId: MODULE_ID,
  }
  const claimPatches: Record<string, any>[] = []
  const claimRef = {
    get: vi.fn(async () => ({ exists: true, data: () => claim })),
    set: vi.fn(async () => {}),
    update: vi.fn(async (patch: Record<string, any>) => { claimPatches.push(patch) }),
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

  const messagesCol = {
    doc: vi.fn(() => ({
      set: vi.fn(async () => {
        if (opts.failMessageWrite) throw new Error('存訊息失敗（模擬）')
      }),
    })),
  }

  const db: any = {
    collection: vi.fn((col: string) => {
      if (col === 'leadClaims') {
        return {
          ...chainable([{ id: 'claim-1', ref: claimRef, data: () => claim }]),
          doc: vi.fn(() => claimRef),
        }
      }
      if (col === 'flows') {
        return {
          doc: vi.fn(() => ({
            get: vi.fn(async () => ({
              exists: true,
              data: () => ({ isActive: true, moduleType: 'bot_flow', messages: [{ type: 'text', text: 'hi' }] }),
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
    // claimLeadClaimForApply：claimed → applying 的搶鎖
    runTransaction: vi.fn(async (cb: any) => cb({
      get: vi.fn(async () => ({ exists: true, data: () => claim })),
      set: vi.fn(),
      update: vi.fn(),
    })),
  }
  return { db, claimPatches }
}

/**
 * 活動推播送出後，會話要被蓋上「這場已回應」的章（enterModule 的 system_notice），
 * 否則客服會看到一堆其實不用處理的待辦。
 *
 * 實測（2026-08）這一步曾經安靜壞掉：推播、存訊息、後續動作被包在同一個 Promise.all 裡，
 * 任何一件失敗就連帶跳過蓋章——客人收到推播了、會話卻永遠掛在待處理。
 */
describe('活動推播後的「已回應」蓋章', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('推播成功 → 蓋章（帶已建立的 session，不再自己開一場）', async () => {
    const { db, claimPatches } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)

    await handleFollowEvent(LINE_UID, undefined, WS)

    expect(vi.mocked(pushMessage)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(enterModule)).toHaveBeenCalledWith('sess-1', LINE_UID, 'system_notice', undefined, WS)
    expect(claimPatches.at(-1)?.status).toBe('applied')
  })

  it('存訊息失敗也照樣蓋章（回歸測試：先前會被連帶跳過）', async () => {
    const { db } = makeDb({ failMessageWrite: true })
    vi.mocked(getDb).mockReturnValue(db as any)

    await handleFollowEvent(LINE_UID, undefined, WS)

    expect(vi.mocked(pushMessage)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(enterModule)).toHaveBeenCalledWith('sess-1', LINE_UID, 'system_notice', undefined, WS)
  })

  it('推播失敗 → 不蓋章（客人什麼都沒收到，這場確實還要人看）', async () => {
    const { db } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)
    vi.mocked(pushMessage).mockRejectedValueOnce(new Error('LINE 400'))

    await handleFollowEvent(LINE_UID, undefined, WS)

    expect(vi.mocked(enterModule)).not.toHaveBeenCalled()
  })

  it('蓋章失敗 → 寫進健康狀態（異常提醒中心看得到，不再只印 log）', async () => {
    const { db } = makeDb()
    vi.mocked(getDb).mockReturnValue(db as any)
    vi.mocked(enterModule).mockRejectedValueOnce(new Error('交易失敗'))

    await handleFollowEvent(LINE_UID, undefined, WS)

    expect(vi.mocked(recordClaimPushMarkFailure)).toHaveBeenCalledTimes(1)
  })
})
