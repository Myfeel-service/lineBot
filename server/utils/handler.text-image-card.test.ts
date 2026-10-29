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
vi.mock('./line-action-tag-token', () => ({ createUriTagToken: vi.fn(() => 'tagtoken') }))
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
import { parseTextButtonsCard } from '~~/shared/text-buttons-card'

/**
 * `C-416`（`D-160` ②）：「＋文字」加了圖＝送成一張卡（大圖＋標題＋內文＋按鈕）。
 * 規則在 `shared/text-image-card.ts`：圖照原比例不裁、內文 5000、按鈕 4 顆且沒存樣式算綠色、點圖＝第 1 顆按鈕。
 */

const FLOWS: Record<string, Record<string, unknown>> = {}
vi.mocked(getDb).mockReturnValue({
  collection: () => ({
    doc: (id: string) => ({ get: async () => ({ exists: !!FLOWS[id], data: () => FLOWS[id] }) }),
  }),
} as never)

let seq = 0
async function render(msg: Record<string, unknown>, attributes: Record<string, string> = {}): Promise<any> {
  const id = `ti${++seq}`
  FLOWS[id] = { workspaceId: 'ws-a', isActive: true, name: '文字加圖', messages: [msg] }
  const r = await renderModuleToLineMessages(id, { workspaceId: 'ws-a', requestOrigin: 'https://lineminime.com' })
  return (r!.renderFor(attributes, 'U1') as any[])[0]
}

const IMG = 'https://storage.googleapis.com/b/uploads/w/hero.jpg'
const BTN = (over: Record<string, unknown> = {}) => ({ type: 'uri', label: '前往完成任務', uri: 'https://shop.example.com/task', ...over })
const textImage = (over: Record<string, unknown> = {}) => ({
  type: 'text',
  text: '完成任務就有機會抽中贈品！\n步驟 1｜按讚追蹤',
  imageUrl: IMG,
  imageWidth: 1040,
  imageHeight: 1040,
  buttons: [BTN()],
  ...over,
})
const bubbleOf = (out: any) => out.contents.contents[0]

describe('送出去的樣子', () => {
  it('一則卡片：輪播裡放一張（對話頁認得、整組 50 KB），大圖在上、內文、綠色按鈕', async () => {
    const out = await render(textImage())
    expect(out.type).toBe('flex')
    expect(out.contents.type).toBe('carousel')
    expect(out.contents.contents).toHaveLength(1)
    const b = bubbleOf(out)
    expect(b.hero).toMatchObject({ type: 'image', url: IMG, size: 'full', aspectRatio: '1:1', aspectMode: 'fit' })
    expect(b.body.contents.at(-1)).toMatchObject({ type: 'text', text: '完成任務就有機會抽中贈品！\n步驟 1｜按讚追蹤', wrap: true })
    expect(b.footer.contents[0]).toMatchObject({ type: 'button', style: 'primary', color: '#06C755' })
  })

  it('圖照原比例：1200×800 → 3:2；比 1:3 還長的收在 1:3；量不到寬高用 1:1（都用 fit 不裁）', async () => {
    expect(bubbleOf(await render(textImage({ imageWidth: 1200, imageHeight: 800 }))).hero.aspectRatio).toBe('3:2')
    expect(bubbleOf(await render(textImage({ imageWidth: 400, imageHeight: 2000 }))).hero.aspectRatio).toBe('1:3')
    expect(bubbleOf(await render(textImage({ imageWidth: undefined, imageHeight: undefined }))).hero.aspectRatio).toBe('1:1')
  })

  it('有標題：粗體在內文上面（對話頁靠粗體認標題）；沒標題只有內文', async () => {
    const withTitle = bubbleOf(await render(textImage({ title: '【奇美淨呼嚕】即將開賣' }))).body.contents
    expect(withTitle[0]).toMatchObject({ text: '【奇美淨呼嚕】即將開賣', weight: 'bold' })
    expect(withTitle[1].weight).toBeUndefined()
    expect(bubbleOf(await render(textImage())).body.contents).toHaveLength(1)
  })

  it('內文 5000 字一字不缺（卡片訊息是 1000，這條照純文字）', async () => {
    const text = '飛'.repeat(5000)
    expect(bubbleOf(await render(textImage({ text }))).body.contents.at(-1).text).toBe(text)
  })

  it('按鈕最多 4 顆；明講「文字連結」的才是連結', async () => {
    const out = await render(textImage({ buttons: [BTN(), BTN({ style: 'link' }), BTN(), BTN()] }))
    const styles = bubbleOf(out).footer.contents.map((b: any) => b.style)
    expect(styles).toEqual(['primary', 'link', 'primary', 'primary'])
  })

  it('點圖片＝按第 1 顆按鈕；沒有按鈕就不能點、也沒有按鈕列', async () => {
    const b = bubbleOf(await render(textImage({ buttons: [BTN(), BTN({ uri: 'https://shop.example.com/other' })] })))
    expect(b.hero.action).toEqual(b.footer.contents[0].action)
    const noBtn = bubbleOf(await render(textImage({ buttons: [] })))
    expect(noBtn.hero.action).toBeUndefined()
    expect(noBtn.footer).toBeUndefined()
  })

  it('通知列＝內文（跟純文字一樣），名字變數換掉', async () => {
    const out = await render(textImage({ text: '{{displayName}} 你好' }), { displayName: '王小明' })
    expect(out.altText).toBe('王小明 你好')
  })

  it('對照組：沒有圖的「文字＋按鈕」照舊是 `C-397` 那張卡（不是這張），純文字照舊是文字', async () => {
    const plainCard = await render({ type: 'text', text: '嗨', buttons: [BTN()] })
    expect(parseTextButtonsCard(plainCard)).not.toBeNull()
    expect(plainCard.contents.type).toBe('bubble')
    expect(await render({ type: 'text', text: '嗨' })).toMatchObject({ type: 'text', text: '嗨' })
    // 圖網址只有空白＝沒圖
    expect(await render({ type: 'text', text: '嗨', imageUrl: '  ' })).toMatchObject({ type: 'text' })
  })
})
