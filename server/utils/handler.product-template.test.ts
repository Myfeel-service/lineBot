import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({}))

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__ts__',
    delete: () => '__del__',
    increment: (n: number) => ({ __inc: n }),
    arrayUnion: (...v: unknown[]) => ({ __union: v }),
  },
  Timestamp: { now: () => ({ toMillis: () => 0 }), fromMillis: (m: number) => ({ toMillis: () => m, __ms: m }) },
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
  answerWithAi: vi.fn(), routeMessage: vi.fn(), summarizeHandoffContext: vi.fn(),
  truncateLabel: (s: string) => s,
}))
vi.mock('./ai-settings', () => ({ getAiSettings: vi.fn(async () => null) }))
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn() }))
vi.mock('./ai-handoff-notify', () => ({ notifyHandoffToStaff: vi.fn() }))
vi.mock('./ai-scripts', () => ({
  advanceScript: vi.fn(), loadActiveScripts: vi.fn(async () => []), startScript: vi.fn(),
}))
/** 試算表來的知識卡（一列一張）與商品清單 */
const CARDS: Record<string, Array<{ title: string, content: string }>> = {}
const REGISTRIES: Record<string, any> = {}
vi.mock('./ai-knowledge-sources', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listChunksBySource: vi.fn(async (_db: unknown, _ws: string, sourceId: string) => (CARDS[sourceId] ?? []).map(c => ({ isOverview: false, ...c }))),
}))
vi.mock('./sheet-products', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadSheetProductRegistry: vi.fn(async (_db: unknown, _ws: string, sourceId: string) => REGISTRIES[sourceId] ?? null),
}))

import { handlePostbackEvent } from './handler'
import { getDb } from './firebase'
import { replyMessage } from './line'
import { encodeTriggerModule } from '~~/shared/action-schema'
import { sheetFieldToken } from '~~/shared/sheet-field'

/**
 * `C-437`：客人在商品目錄點了一張卡 → 收到的商品資訊範本填的是**那個商品**。
 * 整條路（postback 解出商品 → 讀模組 → 填格子 → 組 LINE 訊息 → 回覆）走一次，不只測填格子那一支：
 * ⛔ postback 那條路的模組是跟 session 並行預先讀好的，商品沒傳到那裡＝範本永遠是空的，單元測試抓不到。
 */

const LINE_UID = 'U0000000000000000000000000000009'
const at = (field: string) => sheetFieldToken({ row: '@', field })
const COVER = 'https://storage.googleapis.com/b/uploads/ws/sheet-products/k.jpg'

function makeDb(workspaceId: string, flows: Record<string, any>) {
  const query = (col: string): any => ({
    where: () => query(col),
    orderBy: () => query(col),
    limit: () => query(col),
    get: async () => {
      if (col !== 'knowledgeSources') return { empty: true, docs: [] }
      const src = { workspaceId, type: 'gsheet', name: '客服（商品資訊）', gsheetFieldHeaders: ['出貨時間', '商品頁面', '常見問答頁'] }
      return { empty: false, docs: [{ id: 'src1', get: (f: string) => (src as any)[f] }] }
    },
  })
  return {
    collection: (col: string) => ({
      ...query(col),
      doc: (id?: string) => ({
        get: vi.fn(async () => {
          if (col === 'users') return { exists: true, data: () => ({ workspaceId, lineUserId: LINE_UID, displayName: '測試客人', isBlocked: false }) }
          if (col === 'flows' && id && flows[id]) return { exists: true, data: () => flows[id] }
          return { exists: false, data: () => undefined }
        }),
        set: vi.fn(async () => {}),
        update: vi.fn(async () => {}),
        collection: () => ({ doc: () => ({ set: vi.fn(async () => {}) }) }),
      }),
    }),
  }
}

const postback = (data: string): any => ({
  type: 'postback',
  timestamp: 1700000000000,
  source: { type: 'user', userId: LINE_UID },
  replyToken: 'reply-token',
  postback: { data },
})

const TEMPLATE = {
  type: 'text',
  imageUrl: at('@image'),
  imageWidth: 1200,
  imageHeight: 675,
  title: at('@name'),
  text: `出貨時間：${at('出貨時間')}\n有問題直接留言`,
  buttons: [
    { type: 'uri', label: '查看商品頁', uri: at('商品頁面') },
    { type: 'uri', label: '常見問答', uri: at('常見問答頁') },
  ],
}

let n = 0
beforeEach(() => {
  vi.clearAllMocks()
  CARDS.src1 = [{ title: 'KIESLECT 小耳記 10S', content: '出貨時間：10 月下旬陸續出貨\n商品頁面：以下提供商品頁面連結供您參考： https://www.myfeel-tw.com/projects/10S' }]
  REGISTRIES.src1 = {
    products: { pk: { id: 'pk', title: 'KIESLECT 小耳記 10S', aliases: [], inCatalog: true, missingSince: null, cover: { url: COVER, fromUrlKey: 'x', at: 1 } } },
    changes: [],
  }
})

async function tap(data: (moduleId: string) => string) {
  const ws = `ws-tpl-${++n}`
  const moduleId = `tpl-${n}`
  vi.mocked(getDb).mockReturnValue(makeDb(ws, { [moduleId]: { workspaceId: ws, name: '商品資訊範本', isActive: true, messages: [TEMPLATE], moduleType: 'bot_flow' } }) as any)
  await handlePostbackEvent(postback(data(moduleId)), { workspaceId: ws })
  const [, messages] = vi.mocked(replyMessage).mock.calls[0] as unknown as [string, any[]]
  return messages
}

describe('客人點商品目錄的卡片 → 範本填那個商品', () => {
  it('⭐ 圖、商品名、出貨時間、商品頁都是點的那一個；常見問答頁空白＝那顆按鈕不出現', async () => {
    const [card] = await tap(id => encodeTriggerModule(id, [], 'src1:pk'))
    const bubble = card.contents.contents[0]
    expect(bubble.hero.url).toBe(COVER)
    const texts = bubble.body.contents.map((c: any) => c.text)
    expect(texts).toEqual(['KIESLECT 小耳記 10S', '出貨時間：10 月下旬陸續出貨\n有問題直接留言'])
    expect(bubble.footer.contents.map((b: any) => [b.action.label, b.action.uri])).toEqual([['查看商品頁', 'https://www.myfeel-tw.com/projects/10S']])
    expect(JSON.stringify(card)).not.toContain('{{sheet:')
  })

  it('對照組：沒帶商品的舊按鈕叫出同一個模組——那幾行不顯示，⛔ 不送原字', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const [msg] = await tap(id => encodeTriggerModule(id, []))
    expect(JSON.stringify(msg)).not.toContain('{{sheet:')
    expect(JSON.stringify(msg)).not.toContain('KIESLECT')
    expect(JSON.stringify(msg)).toContain('有問題直接留言')
    warn.mockRestore()
  })
})
