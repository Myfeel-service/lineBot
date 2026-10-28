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
import { parseTextButtonsCard } from '~~/shared/text-buttons-card'
import { collectClickTrackableUris, wrapBroadcastMessagesForClickTracking } from './broadcast-click-track'

/**
 * `C-397`：模組「＋文字」掛了按鈕，送出去的是卡片（Flex），不是按鈕範本。
 * 按鈕範本文字只收 160 字（`H-27`：超過的被切掉、客人收到半截）；卡片跟純文字一樣 5000。
 */

/** `H-27` 那則真的被切掉的推播原文長度（276 字）；這裡用同長度的字，看會不會一字不缺 */
const LONG_276 = '感謝大家的熱情敲碗與等待🩵\n'.repeat(20).slice(0, 276)

const FLOWS: Record<string, Record<string, unknown>> = {}
vi.mocked(getDb).mockReturnValue({
  collection: () => ({
    doc: (id: string) => ({ get: async () => ({ exists: !!FLOWS[id], data: () => FLOWS[id] }) }),
  }),
} as never)

let seq = 0
async function render(text: string, buttons: unknown[], attributes: Record<string, string> = {}, userId?: string): Promise<any[]> {
  const id = `tb${++seq}`
  FLOWS[id] = { workspaceId: 'ws-a', isActive: true, name: '開賣通知', messages: [{ type: 'text', text, buttons }] }
  const r = await renderModuleToLineMessages(id, { workspaceId: 'ws-a', requestOrigin: 'https://lineminime.com' })
  return r!.renderFor(attributes, userId) as any[]
}

const URI_BTN = { type: 'uri', label: '前往完成任務', uri: 'https://shop.example.com/task' }

describe('文字＋按鈕送出去是卡片', () => {
  it('276 字一字不缺（以前按鈕範本切在第 160 字）', async () => {
    const [msg] = await render(LONG_276, [URI_BTN])
    expect(msg.type).toBe('flex')
    expect(msg.template).toBeUndefined()
    expect(parseTextButtonsCard(msg)?.text).toBe(LONG_276)
    expect(LONG_276.length).toBe(276)
  })

  it('三種按鈕照舊：開網址、叫出模組、送一句話', async () => {
    const [msg] = await render('嗨', [
      URI_BTN,
      { type: 'module', label: '看規則', moduleId: 'm-rules' },
      { type: 'message', label: '我要參加', text: '我要參加' },
    ])
    const actions = parseTextButtonsCard(msg)!.actions as any[]
    expect(actions[0]).toEqual({ type: 'uri', label: '前往完成任務', uri: 'https://shop.example.com/task' })
    expect(actions[1]).toMatchObject({ type: 'postback', label: '看規則' })
    expect(String(actions[1].data)).toContain('m-rules')
    expect(actions[2]).toEqual({ type: 'message', label: '我要參加', text: '我要參加' })
  })

  it('開了貼標的網址按鈕，帶客人時照樣換成那一位的貼標連結（`C-322`）', async () => {
    const [msg] = await render('嗨', [{ ...URI_BTN, tagging: { enabled: true, addTagIds: ['t-1'] } }], {}, 'U1')
    expect(String((parseTextButtonsCard(msg)!.actions[0] as any).uri).startsWith('https://lineminime.com/api/t/')).toBe(true)
  })

  it('客人名字換進去；換完超過 5000 字就切在 5000（客人才收得到，不會整則被退）', async () => {
    const [named] = await render('{{displayName}} 您好', [URI_BTN], { displayName: '王小明' })
    expect(parseTextButtonsCard(named)!.text).toBe('王小明 您好')

    const [long] = await render(`${'飛'.repeat(4995)}{{displayName}}`, [URI_BTN], { displayName: '王小明王小明' })
    expect(parseTextButtonsCard(long)!.text.length).toBe(5000)
  })

  it('通知列那行字（altText）最多 400 字', async () => {
    const [msg] = await render('飛'.repeat(1000), [URI_BTN])
    expect(msg.altText.length).toBe(400)
  })

  it('沒按鈕的照舊是純文字', async () => {
    const [msg] = await render('嗨', [])
    expect(msg).toMatchObject({ type: 'text', text: '嗨' })
  })
})

describe('推播點擊統計認得卡片上的網址（模組型推播送出前會包追蹤連結）', () => {
  it('卡片底下的網址按鈕會被包成追蹤連結，點下去時也驗得過', async () => {
    const msgs = await render(LONG_276, [URI_BTN])
    const wrapped = wrapBroadcastMessagesForClickTracking(msgs, 'bc-1', 'https://lineminime.com') as any[]
    const uri = String((parseTextButtonsCard(wrapped[0])!.actions[0] as any).uri)
    expect(uri.startsWith('https://lineminime.com/api/r/')).toBe(true)
    expect(collectClickTrackableUris(msgs).has('https://shop.example.com/task')).toBe(true)
  })
})
