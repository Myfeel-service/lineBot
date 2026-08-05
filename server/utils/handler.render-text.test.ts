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

import { renderTextForUser } from './handler'

/**
 * 「填入回覆框」把預存文字先給客服改，代換必須和真的送出同一套；
 * 這裡釘住那份契約——漏掉代換的話，客服會把 {{displayName}} 原封不動送給客人。
 */
describe('renderTextForUser', () => {
  const userData = {
    displayName: '王小明',
    attributes: { city: '台北', order: 'A123' },
  }

  it('把 displayName 與自訂屬性換成實際值', () => {
    expect(renderTextForUser('{{displayName}} 你好，{{city}} 的 {{order}} 出貨了', userData))
      .toBe('王小明 你好，台北 的 A123 出貨了')
  })

  it('displayName 蓋過同名屬性（和送出時的 buildAttributeContext 一致）', () => {
    expect(renderTextForUser('{{displayName}}', { displayName: '王小明', attributes: { displayName: '舊名字' } }))
      .toBe('王小明')
  })

  it('沒有值的屬性換成空字串，不會把 {{}} 留給客人看到', () => {
    expect(renderTextForUser('您好 {{nickname}}，謝謝', userData)).toBe('您好 ，謝謝')
  })

  it('沒有 {{ 的文字原封不動；沒有使用者資料也不會炸', () => {
    expect(renderTextForUser('謝謝您的來訊', userData)).toBe('謝謝您的來訊')
    expect(renderTextForUser('{{displayName}} 您好', null)).toBe(' 您好')
  })
})
