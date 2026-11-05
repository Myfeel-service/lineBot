import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `C-468` 後續（老闆 2026-11-05「按你的建議執行」）：`followWelcomeAppendBlock`＝這個帳號**現在**加好友時，生日卡附不附得上。
 * ⭐ 這裡用**真的**腳本引擎（`previewScriptStart`）、真的組訊息（`buildScriptReplyMessages`／`buildLineMessages`）、
 *    真的判斷（`appendBlockedKind`）——只假掉資料來源（腳本清單、模組文件）。⛔ 不 mock 判斷本身，否則測到的是 mock。
 */

vi.stubGlobal('useRuntimeConfig', () => ({}))
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__del__', increment: (n: number) => `__inc:${n}__` },
  Timestamp: { now: () => ({ toMillis: () => 0 }), fromMillis: (m: number) => ({ toMillis: () => m }) },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('./line', () => ({
  replyMessage: vi.fn(async () => ({})),
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
vi.mock('./ai-answer', () => ({
  answerWithAi: vi.fn(), routeMessage: vi.fn(), summarizeHandoffContext: vi.fn(),
  truncateLabel: (s: string) => s,
}))
vi.mock('./ai-settings', () => ({ getAiSettings: vi.fn(async () => null) }))
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn() }))
vi.mock('./ai-handoff-notify', () => ({ notifyHandoffToStaff: vi.fn() }))
vi.mock('./ai-scripts', async (importOriginal) => {
  const real = await importOriginal<typeof import('./ai-scripts')>()
  return { ...real, loadActiveScripts: vi.fn(async () => []) }
})

const { followWelcomeAppendBlock } = await import('./handler')
const { getDb } = await import('./firebase')
const { loadActiveScripts } = await import('./ai-scripts')

const WS = 'ws1'
/** 模組文件（null＝被刪了） */
let flowMessages: any[] | null = null

function fakeDb() {
  return {
    collection: vi.fn((col: string) => ({
      doc: vi.fn(() => ({
        get: vi.fn(async () => (col === 'flows' && flowMessages
          ? { exists: true, data: () => ({ workspaceId: WS, isActive: true, moduleType: 'bot_flow', messages: flowMessages, name: '歡迎模組' }) }
          : { exists: false, data: () => undefined })),
      })),
      where: vi.fn(function (this: any) { return this }),
      get: vi.fn(async () => ({ empty: true, docs: [] })),
    })),
  }
}

/** 加好友腳本：trigger → 第一步 */
function followScript(first: Record<string, any>, extra: Record<string, any>[] = []) {
  return {
    id: 'fs1', workspaceId: WS, name: '加好友歡迎', enabled: true, priority: 50, rootNodeId: 't',
    nodes: [
      { id: 't', type: 'trigger', triggerEvent: 'follow', matchMode: 'keyword', keywordMatch: 'any', keywords: [], priority: 50, next: first.id },
      first,
      ...extra,
    ],
  } as any
}
const text = (t: string) => ({ type: 'text', text: t })
const qrMsg = { type: 'quickReply', text: '想了解什麼？', quickReplies: [{ action: { type: 'message', label: '價格', text: '價格' } }] }

beforeEach(() => {
  flowMessages = null
  vi.mocked(getDb).mockReturnValue(fakeDb() as any)
  vi.mocked(loadActiveScripts).mockResolvedValue([])
})

describe('加好友時生日卡附不附得上（followWelcomeAppendBlock）', () => {
  it('沒有歡迎訊息＝卡自己送，附得上（null）', async () => {
    expect(await followWelcomeAppendBlock(WS)).toBeNull()
  })
  it('歡迎訊息只回一句字＝附得上', async () => {
    vi.mocked(loadActiveScripts).mockResolvedValue([followScript({ id: 'r', type: 'reply', text: '歡迎！', thenHandoff: false })])
    expect(await followWelcomeAppendBlock(WS)).toBeNull()
  })
  it('歡迎腳本第一步就是選項題（快速回覆）＝附不上，去「自動回應」改', async () => {
    vi.mocked(loadActiveScripts).mockResolvedValue([followScript(
      { id: 'q', type: 'quickReply', question: '想了解什麼？', expireMs: 60_000, options: [{ label: '價格', next: 'r' }] },
      [{ id: 'r', type: 'reply', text: 'ok', thenHandoff: false }],
    )])
    expect(await followWelcomeAppendBlock(WS)).toEqual({ kind: 'quickReply', where: 'script' })
  })
  // ⚠️ 每一條用不同的模組 id：handler 的模組文件有 60 秒記憶體快取（同一個 id 會讀到上一條的模組）
  const viaModule = (moduleId: string) => vi.mocked(loadActiveScripts).mockResolvedValue([followScript({ id: 'm', type: 'module', moduleId })])
  it('歡迎送模組、模組最後一則帶快速回覆＝附不上，去「機器人模組」改', async () => {
    viaModule('mod-qr-last')
    flowMessages = [text('嗨'), qrMsg]
    expect(await followWelcomeAppendBlock(WS)).toEqual({ kind: 'quickReply', where: 'module' })
  })
  it('快速回覆不在最後一則＝照附', async () => {
    viaModule('mod-qr-first')
    flowMessages = [qrMsg, text('嗨')]
    expect(await followWelcomeAppendBlock(WS)).toBeNull()
  })
  it('模組已經 5 則＝放不下；4 則＝附得上', async () => {
    viaModule('mod-five')
    flowMessages = ['1', '2', '3', '4', '5'].map(text)
    expect(await followWelcomeAppendBlock(WS)).toEqual({ kind: 'full', where: 'module' })
    viaModule('mod-four')
    flowMessages = ['1', '2', '3', '4'].map(text)
    expect(await followWelcomeAppendBlock(WS)).toBeNull()
  })
  it('模組被刪了＝什麼都沒送、卡自己送（同 runFollowWelcomeScript）', async () => {
    vi.mocked(loadActiveScripts).mockResolvedValue([followScript({ id: 'm', type: 'module', moduleId: 'gone' })])
    flowMessages = null
    expect(await followWelcomeAppendBlock(WS)).toBeNull()
  })
  it('⛔ 什麼都不寫（只讀腳本清單、模組）', async () => {
    const db = fakeDb()
    vi.mocked(getDb).mockReturnValue(db as any)
    viaModule('mod-readonly')
    flowMessages = [qrMsg]
    expect(await followWelcomeAppendBlock(WS)).toEqual({ kind: 'quickReply', where: 'module' })
    const cols = db.collection.mock.calls.map(c => c[0])
    expect(cols.every(c => c === 'flows' || c === 'richMessages')).toBe(true)
  })
})
