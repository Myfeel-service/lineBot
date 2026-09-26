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
 * 推播組模組訊息（`C-266`，2026-09-26 code review）：模組 id 來自推播按鈕的 postback，店家自己填得到。
 * 🔴 別的帳號的模組＝當作不存在（⛔ 不可以把那一家的內容組出來推出去）。
 */
const FLOWS: Record<string, Record<string, unknown>> = {
  'flow-mine': { workspaceId: 'ws-a', isActive: true, name: '我的模組', messages: [{ type: 'text', text: '我家的內容' }] },
  'flow-theirs': { workspaceId: 'ws-b', isActive: true, name: '別家的模組', messages: [{ type: 'text', text: '別家的內容' }] },
  'flow-orphan': { isActive: true, name: '沒有帳號的舊模組', messages: [{ type: 'text', text: '舊內容' }] },
}
vi.mocked(getDb).mockReturnValue({
  collection: () => ({
    doc: (id: string) => ({ get: async () => ({ exists: !!FLOWS[id], data: () => FLOWS[id] }) }),
  }),
} as never)

describe('renderModuleToLineMessages：只組自己帳號的模組', () => {
  it('自己的模組照常組出來', async () => {
    const r = await renderModuleToLineMessages('flow-mine', { workspaceId: 'ws-a' })
    expect(r?.lineMessages).toEqual([expect.objectContaining({ type: 'text', text: '我家的內容' })])
  })

  it('🔴 別的帳號的模組＝不存在', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await renderModuleToLineMessages('flow-theirs', { workspaceId: 'ws-a' })).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('不屬於 ws-a'))
    warn.mockRestore()
  })

  it('沒有帳號欄位的模組也不給（跟發送前檢查 validate.post 同一個判斷）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await renderModuleToLineMessages('flow-orphan', { workspaceId: 'ws-a' })).toBeNull()
    warn.mockRestore()
  })
})
