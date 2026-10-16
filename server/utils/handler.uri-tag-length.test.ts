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
// 貼標 token 的長度照真的那支估：原網址整包 base64 編進去（約 1.33 倍）＋客人、標籤、簽章約兩百字
vi.mock('./line-action-tag-token', () => ({
  createUriTagToken: vi.fn((p: { targetUrl: string }) => 'x'.repeat(Math.ceil(p.targetUrl.length * 1.34) + 200)),
}))
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
 * 貼標連結太長（`C-322` 審查第 2 條）：LINE 的網址最多 1000 字，超過的話**整則**被退回——
 * 推播一人一則送時每一位都失敗、0 人收到。超過就退回原網址（這顆按鈕點了不貼標，但訊息送得出去）。
 */
const flowWith = (uri: string) => ({
  workspaceId: 'ws-a',
  isActive: true,
  name: '新品上市',
  messages: [{
    type: 'quickReply',
    text: '看看新品',
    quickReplies: [{ action: { type: 'uri', label: '去看看', uri, tagging: { enabled: true, addTagIds: ['t-new'] } } }],
  }],
})
const FLOWS: Record<string, Record<string, unknown>> = {}
vi.mocked(getDb).mockReturnValue({
  collection: () => ({
    doc: (id: string) => ({ get: async () => ({ exists: !!FLOWS[id], data: () => FLOWS[id] }) }),
  }),
} as never)

let seq = 0
async function uriFor(original: string): Promise<string> {
  // 每次一個新的模組 id（模組讀過會快取）
  const id = `f${++seq}`
  FLOWS[id] = flowWith(original)
  const r = await renderModuleToLineMessages(id, { workspaceId: 'ws-a', requestOrigin: 'https://lineminime.com' })
  const msgs = r!.renderFor({}, 'U1') as any[]
  return msgs[0].quickReply.items[0].action.uri
}

describe('貼標連結超過 LINE 的 1000 字上限', () => {
  it('一般長度的網址：換成那一位的貼標連結', async () => {
    const uri = await uriFor('https://shop.example.com/p/123?utm_source=line')
    expect(uri.startsWith('https://lineminime.com/api/t/')).toBe(true)
    expect(uri.length).toBeLessThanOrEqual(1000)
  })

  it('⛔ 原網址長（中文商品名＋UTM）、包成貼標連結會超過 1000 字 → 改用原網址、留 log（訊息才送得出去）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const long = `https://shop.example.com/p/${encodeURIComponent('夏普自動調理零水鍋二點四公升限量版贈品組合')}?utm_source=line&utm_medium=broadcast&utm_campaign=${'x'.repeat(400)}`
    expect(long.length).toBeLessThan(1000)
    const uri = await uriFor(long)
    expect(uri).toBe(long)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('超過 LINE 上限 1000'))
    warn.mockRestore()
  })
})
