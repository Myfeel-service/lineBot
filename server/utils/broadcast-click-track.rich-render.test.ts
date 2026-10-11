import { describe, expect, it, vi } from 'vitest'

// Nuxt auto-import（handler.ts 只在組 imagemap 網址時用到，這裡給空值即可）
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
  answerWithAi: vi.fn(), routeMessage: vi.fn(async () => null), summarizeHandoffContext: vi.fn(async () => ''),
  truncateLabel: (s: string) => s,
}))
vi.mock('./ai-settings', () => ({
  getAiSettings: vi.fn(async () => ({ enabled: true, replyMode: 'auto', sensitiveTopics: [] })),
}))
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn(async () => {}) }))
vi.mock('./ai-handoff-notify', () => ({ notifyHandoffToStaff: vi.fn(async () => {}) }))
vi.mock('./ai-scripts', () => ({
  advanceScript: vi.fn(), loadActiveScripts: vi.fn(async () => []), startScript: vi.fn(),
}))
vi.mock('./conversation-media', () => ({
  archiveConversationMedia: vi.fn(async () => ({ ok: true })),
}))

import { getDb } from './firebase'
import { renderModuleToLineMessages } from './handler'
import {
  clickTargetInBroadcast,
  collectClickTrackableUris,
  wrapBroadcastMessagesForClickTracking,
} from './broadcast-click-track'

/**
 * `C-301`：拿**真的組訊息那一支**（模組 → 送給 LINE 的格式）跑一次，⛔ 不靠手抄的形狀。
 * MYFEEL 9/29 以後的推播都是「圖文訊息＋一段文字」，連結只在圖片上——
 * 舊的包裝不認得那兩種格式，所以 LINE 記到 443 人點、我們記到 0。
 */
const ORIGIN = 'https://app.example.com'

const rich = (over: Record<string, unknown> = {}) => ({
  type: 'richMessage',
  altText: '小滑手開賣',
  heroImageUrl: 'https://img.example.com/hero.png',
  heroImageWidth: 1040,
  heroImageHeight: 1040,
  layoutId: 'single',
  actions: [{ slot: 'A', type: 'uri', uri: 'https://myfeel.design/TP6O9' }],
  ...over,
})

const DOCS: Record<string, Record<string, Record<string, unknown>>> = {
  flows: {
    'flow-flex': { workspaceId: 'ws-a', isActive: true, name: '走 Flex', messages: [rich(), { type: 'text', text: '快來看' }] },
    'flow-imagemap': { workspaceId: 'ws-a', isActive: true, name: '保留透明＝imagemap', messages: [rich({ transparentBackground: true })] },
  },
}
vi.mocked(getDb).mockReturnValue({
  collection: (col: string) => ({
    doc: (id: string) => ({ get: async () => ({ exists: !!DOCS[col]?.[id], data: () => DOCS[col]?.[id] }) }),
  }),
} as never)

function targetsInWrapped(wrapped: unknown): string[] {
  const out: string[] = []
  JSON.stringify(wrapped, (_k, v) => {
    if (typeof v === 'string' && v.startsWith(`${ORIGIN}/api/r/`)) {
      const parts = Buffer.from(v.slice(`${ORIGIN}/api/r/`.length), 'base64url').toString('utf-8').split('|')
      out.push(parts.slice(4).join('|'))
    }
    return v
  })
  return out
}

describe('`C-301` 圖文訊息發出去的兩種格式，連結都會被記到', () => {
  for (const [flowId, expectType] of [['flow-flex', 'flex'], ['flow-imagemap', 'imagemap']] as const) {
    it(`${expectType}：包得起來、點下去驗證得過（兩條驗證路都要過）`, async () => {
      const rendered = await renderModuleToLineMessages(flowId, { workspaceId: 'ws-a', requestOrigin: ORIGIN })
      expect(rendered?.lineMessages[0]?.type).toBe(expectType)

      const wrapped = wrapBroadcastMessagesForClickTracking(rendered!.lineMessages, 'camp-1', ORIGIN)
      const targets = targetsInWrapped(wrapped)
      expect(targets).toEqual(['https://myfeel.design/TP6O9'])

      // 驗證路①：舊推播沒有留存當時內容，拿模組現在的內容重組（`/api/r` 的 urisFromCurrentModule）
      expect(collectClickTrackableUris(rendered!.lineMessages).has(targets[0]!)).toBe(true)
      // 驗證路②：`C-246` 之後留存的編輯器格式
      expect(clickTargetInBroadcast(targets[0]!, { messages: [], sentContent: { messages: rendered!.hydratedMessages } })).toBe(true)
      // ⛔ 偽造的網址照樣不轉
      expect(clickTargetInBroadcast('https://evil.example.com', { messages: [], sentContent: { messages: rendered!.hydratedMessages } })).toBe(false)
    })
  }
})
