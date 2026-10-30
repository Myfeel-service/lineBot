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
import { CARD_BODY_MAX, LINE_CAROUSEL_JSON_MAX, cardMessageSizeError, estimateCardMessageBytes } from '~~/shared/card-message'
import { wrapBroadcastMessagesForClickTracking } from './broadcast-click-track'

/**
 * `C-398`（`D-153` ⑵）卡片訊息：新字級、綠色實心按鈕、提醒文字沒填時用第一張標題，
 * 以及**整組大小的估算一定不小於真的送出去的大小**（估小＝存得進去、送出時整則被 LINE 退回）。
 */

const FLOWS: Record<string, Record<string, unknown>> = {}
vi.mocked(getDb).mockReturnValue({
  collection: () => ({
    doc: (id: string) => ({ get: async () => ({ exists: !!FLOWS[id], data: () => FLOWS[id] }) }),
  }),
} as never)

let seq = 0
async function render(msg: Record<string, unknown>, userId = 'U1'): Promise<any> {
  const id = `card${++seq}`
  FLOWS[id] = { workspaceId: 'ws-a', isActive: true, name: '卡片', messages: [msg] }
  const r = await renderModuleToLineMessages(id, { workspaceId: 'ws-a', requestOrigin: 'https://lineminime.com' })
  return (r!.renderFor({}, userId) as any[])[0]
}

const card = (over: Record<string, unknown> = {}) => ({
  imageUrl: 'https://firebasestorage.googleapis.com/v0/b/x/o/flows%2Fhero.jpg?alt=media&token=abc',
  title: '【新品】即將開賣',
  text: '完成任務就有機會抽中贈品！\n步驟 1｜按讚追蹤\n步驟 2｜留言標註兩位朋友',
  action: { type: 'none' },
  actions: [{ type: 'uri', label: '前往完成任務', uri: 'https://shop.example.com/task', style: 'primary' }],
  ...over,
})
const message = (columns: unknown[], over: Record<string, unknown> = {}) => ({
  type: 'flexImageCarousel', altText: '', enableImage: true, imageAspectRatio: '1:1', columns, ...over,
})

describe('送出去的樣子', () => {
  it('標題放大加粗、內文放大加深（所有卡片一起換，舊卡片不用改資料）', async () => {
    const out = await render(message([card()]))
    const [title, body] = out.contents.contents[0].body.contents
    expect(title).toMatchObject({ weight: 'bold', size: 'lg', color: '#111111', wrap: true })
    expect(body).toMatchObject({ size: 'md', color: '#4B5563', wrap: true })
    expect(body.weight).toBeUndefined() // ⛔ 對話頁靠粗體認標題，內文加粗會被認成標題
  })

  it('選綠色按鈕＝LINE 的實心按鈕（綠色）；沒存樣式的舊按鈕照舊是文字連結', async () => {
    const out = await render(message([card({ actions: [
      { type: 'uri', label: '前往完成任務', uri: 'https://shop.example.com/task', style: 'primary' },
      { type: 'uri', label: '看規則', uri: 'https://shop.example.com/rules' },
      { type: 'uri', label: '看更多', uri: 'https://shop.example.com/more', style: 'link' },
    ] })]))
    const [primary, legacy, link] = out.contents.contents[0].footer.contents
    expect(primary).toMatchObject({ type: 'button', style: 'primary', color: '#06C755' })
    expect(legacy).toMatchObject({ type: 'button', style: 'link' })
    expect(link).toMatchObject({ type: 'button', style: 'link' })
  })

  it('只有文字連結的卡，按鈕區照舊（不加邊距，舊卡片按鈕的樣子不變）', async () => {
    const out = await render(message([card({ actions: [{ type: 'uri', label: '看更多', uri: 'https://a.example.com' }] })]))
    expect(out.contents.contents[0].footer.paddingAll).toBeUndefined()
  })

  it('`C-436` 目錄卡片帶著商品：點整張圖送出的 postback 帶上商品（範本靠它填格子），標籤照貼', async () => {
    const out = await render(message([card({
      title: '',
      text: '',
      actions: [],
      action: { type: 'module', moduleId: 'tpl-1', product: 'src1:a1b2c3d4e5', tagging: { enabled: true, addTagIds: ['tag-a'] } },
    })]))
    expect(out.contents.contents[0].hero.action).toMatchObject({ type: 'postback', data: 'triggerModule=tpl-1&tags=tag-a&p=src1%3Aa1b2c3d4e5' })
  })

  it('內文 1000 字一字不缺（以前切在 300）', async () => {
    const text = '飛'.repeat(CARD_BODY_MAX)
    const out = await render(message([card({ text })]))
    expect(out.contents.contents[0].body.contents[1].text).toBe(text)
  })

  it('提醒文字沒填：送固定的「卡片訊息」，⛔ 不拿第一張的標題（會存進對話紀錄、被 AI 當成客人在問那台，code review 第 1 條）', async () => {
    expect((await render(message([card()]))).altText).toBe('卡片訊息')
    expect((await render(message([card()], { altText: '自己寫的' }))).altText).toBe('自己寫的')
  })

  it('提醒文字只寫了名字變數、取不到名字：不可以送空的（LINE 會整次回覆退回，第 2 條）', async () => {
    expect((await render(message([card()], { altText: '{{displayName}}' }))).altText).toBe('卡片訊息')
  })
})

describe('整組大小：估出來的一定 ≥ 真的送出去的（含貼標連結與推播點擊追蹤）', () => {
  const longUri = (n: number) => `https://shop.example.com/p/${encodeURIComponent('夏普自動調理鍋限量版')}?utm=${'x'.repeat(n)}`
  const tagged = { enabled: true, addTagIds: ['t-1', 't-2'] }
  const worstCard = () => card({
    imageUrl: `https://firebasestorage.googleapis.com/v0/b/x/o/${'a'.repeat(260)}`,
    title: '題'.repeat(80),
    text: '內'.repeat(CARD_BODY_MAX),
    action: { type: 'uri', uri: longUri(500), tagging: tagged },
    actions: [
      { type: 'uri', label: '按'.repeat(20), uri: longUri(500), tagging: tagged, style: 'primary' },
      { type: 'module', label: '按'.repeat(20), moduleId: 'f'.repeat(36), tagging: tagged },
      { type: 'message', label: '按'.repeat(20), text: '送'.repeat(100), tagging: tagged, style: 'primary' },
    ],
  })
  const actualBytes = async (msg: Record<string, unknown>) => {
    const out = await render(msg, 'U1234567890abcdef1234567890abcdef')
    const [wrapped] = wrapBroadcastMessagesForClickTracking([out], 'broadcast-id-0123456789', 'https://lineminime.com') as any[]
    return Math.max(
      Buffer.byteLength(JSON.stringify(out.contents), 'utf8'),
      Buffer.byteLength(JSON.stringify(wrapped.contents), 'utf8'),
    )
  }

  for (const [name, msg] of [
    ['一張一般的卡', message([card()])],
    ['三張一般的卡', message([card(), card(), card()])],
    ['一張塞滿的卡', message([worstCard()])],
    ['五張塞滿的卡', message(Array.from({ length: 5 }, worstCard))],
    ['十張塞滿的卡', message(Array.from({ length: 10 }, worstCard))],
  ] as const) {
    it(`${name}：估計 ≥ 實際`, async () => {
      const actual = await actualBytes(msg)
      expect(estimateCardMessageBytes(msg)).toBeGreaterThanOrEqual(actual)
    })
  }

  it('一般的卡不會被估太大（三張一般的卡遠低於上限，不會誤擋）', () => {
    expect(estimateCardMessageBytes(message([card(), card(), card()]))).toBeLessThan(LINE_CAROUSEL_JSON_MAX / 4)
  })

  it('十張塞滿的卡要擋，而且講得出怎麼辦', () => {
    const err = cardMessageSizeError(message(Array.from({ length: 10 }, worstCard)))
    expect(err).toMatch(/LINE 收不下.*上限 50 KB.*減少張數/)
  })

  it('十張一般的卡（內文兩三百字）不擋', () => {
    expect(cardMessageSizeError(message(Array.from({ length: 10 }, () => card({ text: '內'.repeat(250) }))))).toBe('')
  })
})
