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

/**
 * 模組引用圖文訊息（`G-98`，2026-09-29 權限盤點）：richMessageRef 的 id 是店家自己在模組裡填得到的。
 * 🔴 別的帳號的圖文訊息＝當作不存在（⛔ 不可以把那一家的圖與按鈕組出來送給自家客人）。
 * 模組本身的歸屬由 getFlowByModuleId 管（見 handler.render-module-tenant.test.ts），這裡只管它引用的那一份。
 */
const ref = (id: string) => ({ type: 'richMessageRef', richMessageId: id })
const DOCS: Record<string, Record<string, Record<string, unknown>>> = {
  flows: {
    'flow-a-own': { workspaceId: 'ws-a', isActive: true, name: '引用自家的', messages: [ref('rm-a')] },
    'flow-a-foreign': { workspaceId: 'ws-a', isActive: true, name: '引用別家的', messages: [ref('rm-b')] },
    'flow-b-own': { workspaceId: 'ws-b', isActive: true, name: 'B 家自己的', messages: [ref('rm-b2')] },
    'flow-a-borrow': { workspaceId: 'ws-a', isActive: true, name: '借快取', messages: [ref('rm-b2')] },
  },
  richMessages: {
    'rm-a': { workspaceId: 'ws-a', altText: '我家的圖文', heroImageUrl: 'https://x/a.png', actions: [] },
    'rm-b': { workspaceId: 'ws-b', altText: '別家的圖文', heroImageUrl: 'https://x/b.png', actions: [] },
    'rm-b2': { workspaceId: 'ws-b', altText: '別家的第二張', heroImageUrl: 'https://x/b2.png', actions: [] },
  },
}
vi.mocked(getDb).mockReturnValue({
  collection: (col: string) => ({
    doc: (id: string) => ({ get: async () => ({ exists: !!DOCS[col]?.[id], data: () => DOCS[col]?.[id] }) }),
  }),
} as never)

describe('模組引用的圖文訊息只給自己帳號的', () => {
  it('自己的圖文訊息照常換成最新內容', async () => {
    const r = await renderModuleToLineMessages('flow-a-own', { workspaceId: 'ws-a' })
    expect(r?.hydratedMessages[0]?.payload?.altText).toBe('我家的圖文')
  })

  it('🔴 引用別家的圖文訊息 → 不換成那一家的內容（當作不存在），並留下 log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await renderModuleToLineMessages('flow-a-foreign', { workspaceId: 'ws-a' })
    expect(r?.hydratedMessages[0]?.payload).toBeUndefined()
    expect(JSON.stringify(r)).not.toContain('別家的圖文')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('不屬於 ws-a'))
    warn.mockRestore()
  })

  it('🔴 快取不會讓別家借道：B 家自己先讀過（進了快取），A 家引用同一張照樣拿不到', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const b = await renderModuleToLineMessages('flow-b-own', { workspaceId: 'ws-b' })
    expect(b?.hydratedMessages[0]?.payload?.altText).toBe('別家的第二張')
    const a = await renderModuleToLineMessages('flow-a-borrow', { workspaceId: 'ws-a' })
    expect(JSON.stringify(a)).not.toContain('別家的第二張')
    warn.mockRestore()
  })
})
