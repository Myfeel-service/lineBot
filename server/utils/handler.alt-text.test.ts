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
vi.mock('./line-action-tag-token', () => ({ createUriTagToken: vi.fn(() => 'tagtok') }))
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
 * `C-468`（老闆 2026-11-05「提醒文字是否可以單獨拉出來」）：
 * 「提醒文字」＝客人手機通知、聊天列表那一行。以前只有圖文訊息、卡片訊息、輪播有這一格，
 * **文字＋圖／文字＋按鈕送的也是卡片，店家卻改不了那一行**。這裡釘住改完的行為：
 *   ① 填了就用他填的 ② 沒填維持原本的樣子（⛔ 不能趁改版換掉客人看到的字）
 *   ③ 純文字沒有這一行字，藏在資料裡的也不准跟著送出去
 */

const FLOWS: Record<string, Record<string, unknown>> = {}
vi.mocked(getDb).mockReturnValue({
  collection: () => ({
    doc: (id: string) => ({ get: async () => ({ exists: !!FLOWS[id], data: () => FLOWS[id] }) }),
  }),
} as never)

const IMAGE = 'https://firebasestorage.googleapis.com/v0/b/x/o/flows%2Fhero.jpg?alt=media&token=abc'
const BUTTON = { type: 'uri', label: '看更多', uri: 'https://shop.example.com' }

let seq = 0
async function render(msg: Record<string, unknown>, attributes: Record<string, string> = {}): Promise<any> {
  const id = `alt${++seq}`
  FLOWS[id] = { workspaceId: 'ws-a', isActive: true, name: '提醒文字', messages: [msg] }
  const r = await renderModuleToLineMessages(id, { workspaceId: 'ws-a', requestOrigin: 'https://lineminime.com' })
  return (r!.renderFor(attributes, 'U1') as any[])[0]
}

describe('文字＋圖（送成一張卡）', () => {
  it('填了提醒文字就用他填的', async () => {
    const out = await render({ type: 'text', text: '這週新品開賣', imageUrl: IMAGE, altText: '新品開賣通知' })
    expect(out.altText).toBe('新品開賣通知')
  })

  it('沒填＝照舊拿內文（`C-416` 的行為不變）', async () => {
    const out = await render({ type: 'text', text: '這週新品開賣', imageUrl: IMAGE })
    expect(out.altText).toBe('這週新品開賣')
  })

  it('提醒文字裡的客人資料會換成那位客人的（跟別的欄位同一套）', async () => {
    const out = await render(
      { type: 'text', text: '這週新品開賣', imageUrl: IMAGE, altText: '{{displayName}}，新品開賣囉' },
      { displayName: '小明' },
    )
    expect(out.altText).toBe('小明，新品開賣囉')
  })

  it('⛔ 只寫了名字變數又取不到名字：不可以送空的（LINE 會整次回覆退回）——退回拿內文', async () => {
    const out = await render({ type: 'text', text: '這週新品開賣', imageUrl: IMAGE, altText: '{{displayName}}' })
    expect(out.altText).toBe('這週新品開賣')
  })

  it('提醒文字、內文、標題都空的才用「卡片訊息」', async () => {
    const out = await render({ type: 'text', text: '', imageUrl: IMAGE, altText: '' })
    expect(out.altText).toBe('卡片訊息')
  })
})

describe('文字＋按鈕（送成一張卡）', () => {
  it('填了就用他填的', async () => {
    const out = await render({ type: 'text', text: '活動辦法看這裡', buttons: [BUTTON], altText: '活動開跑' })
    expect(out.altText).toBe('活動開跑')
  })

  it('沒填＝照舊拿內文（`C-397` 的行為不變）', async () => {
    const out = await render({ type: 'text', text: '活動辦法看這裡', buttons: [BUTTON] })
    expect(out.altText).toBe('活動辦法看這裡')
  })
})

describe('純文字沒有這一行字', () => {
  it('⛔ 藏在舊資料裡的提醒文字不准跟著送出去（LINE 的文字訊息沒有這個欄位）', async () => {
    const out = await render({ type: 'text', text: '您好', altText: '不該送出去的字' })
    expect(out.type).toBe('text')
    expect(out.text).toBe('您好')
    expect('altText' in out).toBe(false)
  })
})

describe('卡片類沒填時補的字沒有被改掉', () => {
  /**
   * `C-468`：這題以前會紅——沒填提醒文字的圖文訊息在送出端**整則被靜默丟掉**（`return []`），
   * 客人什麼都收不到。現在補預設字照送。
   */
  it('圖文訊息沒填：照送、補「圖文訊息」，⛔ 不可以整則不見', async () => {
    const out = await render({
      type: 'richMessage',
      altText: '',
      heroImageUrl: IMAGE,
      layoutId: 'single',
      actions: [{ slot: 'A', type: 'uri', uri: 'https://shop.example.com' }],
    })
    expect(out.altText).toBe('圖文訊息')
  })

  it('圖片輪播沒填＝「圖片輪播」', async () => {
    const out = await render({
      type: 'imageCarousel',
      altText: '',
      columns: [{ imageUrl: IMAGE, action: { type: 'uri', label: '看', uri: 'https://shop.example.com' } }],
    })
    expect(out.altText).toBe('圖片輪播')
  })
})
