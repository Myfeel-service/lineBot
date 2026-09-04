/**
 * AI 讀對話貼標建議（ai-tag-suggest.ts）。
 * 釘的是三條鐵律：
 *   1. ⛔ 模型不生 ID——回來的 tagId 只留白名單（候選集合）內的，幻覺 id、重複 id 全丟。
 *   2. prompt 只給「還能建議的候選」。
 *   3. ⛔ 逐字稿只有「**這一場**裡**客人**說的話」——舊對話與我們自己發出去的訊息
 *      （店家、機器人、推播）都不進去。這條是 2026-09-03 稽核線上 118 條建議後補的，
 *      實例見 pickCustomerLines 那組測試。
 */
import { beforeEach, describe, it, expect, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__' },
  Timestamp: { fromMillis: (ms: number) => ({ __ms: ms }) },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('./gemini', () => ({ generateJson: vi.fn(), runWithLlmBudget: vi.fn() }))
vi.mock('./ai-settings', () => ({ getAiSettings: vi.fn() }))
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn() }))
vi.mock('./inactive-tag', () => ({ INACTIVE_TAG_CODE: 'sys_inactive' }))
vi.mock('./tagging', () => ({ addTagsToUser: vi.fn(async () => ({ added: [] })) }))
vi.mock('./scanner-health', () => ({ recordScannerFailure: vi.fn(async () => {}) }))
/**
 * ⛔ **不要 mock `./tag-suggestion-log`**：成效底帳（`tagSuggestionLogs`）是採用率的分母，
 * 而它整支包在 try/catch 裡——mock 掉就等於把「一筆都沒寫進去」變成全綠。
 * 假 db 自己實作 `batch()` 讓真的寫入被記下來（見 fakeSuggestDb / fakeScanDb）。
 */

import { generateJson, runWithLlmBudget } from './gemini'
import { getAiSettings } from './ai-settings'
import { addTagsToUser } from './tagging'
import {
  buildSuggestPrompt,
  dropDuplicateReasons,
  filterSuggestible,
  prunePendingForAppliedTags,
  recordManualRemovalAsDismissed,
  scanTagSuggestions,
} from './ai-tag-suggest'
// 逐字稿規則搬到 shared（兩支掃描器共用同一份，見該檔檔頭）
import { pickCustomerLines, sessionWindow } from '~~/shared/tag-transcript'

const WS = 'ws1'

/**
 * userTagSuggestions 的迷你假 db：getAll 回指定文件，set 記錄寫入。
 * 每份文件帶自己的 ref.set，模擬 snap.ref.set 的用法。
 */
function fakeSuggestDb(docs: Record<string, Record<string, unknown> | null>) {
  const writes: Array<{ id: string; data: any }> = []
  /** 成效底帳（tagSuggestionLogs）收到的東西——⛔ 沒有這個，記帳寫失敗會被 try/catch 吞掉還全綠 */
  const logs: Array<Record<string, any>> = []
  const makeSnap = (id: string) => {
    const data = docs[id]
    return {
      id,
      exists: data != null,
      data: () => data,
      ref: { set: async (d: any) => { writes.push({ id, data: d }) } },
    }
  }
  const db: any = {
    collection: (name: string) => ({ doc: (id: string) => ({ __id: id, __col: name }) }),
    getAll: async (...refs: Array<{ __id: string }>) => refs.map(r => makeSnap(r.__id)),
    batch: () => ({
      set: (ref: { __col: string }, data: Record<string, any>) => {
        if (ref.__col === 'tagSuggestionLogs') logs.push(data)
      },
      commit: async () => {},
    }),
  }
  return { db, writes, logs }
}

describe('prunePendingForAppliedTags：標籤貼上了就把建議剪掉', () => {
  it('剪掉命中的那筆，pending 還有剩 → hasPending 維持 true', async () => {
    const { db, writes } = fakeSuggestDb({
      u1: { workspaceId: WS, pending: [{ tagId: 't1' }, { tagId: 't2' }], hasPending: true },
    })
    expect(await prunePendingForAppliedTags(db, WS, ['u1'], ['t1'])).toBe(1)
    expect(writes).toHaveLength(1)
    expect(writes[0]!.data.pending).toEqual([{ tagId: 't2' }])
    expect(writes[0]!.data.hasPending).toBe(true)
  })

  it('剪光了 → hasPending 必須翻成 false（不然列表那顆章永遠亮著）', async () => {
    const { db, writes } = fakeSuggestDb({
      u1: { workspaceId: WS, pending: [{ tagId: 't1' }], hasPending: true },
    })
    expect(await prunePendingForAppliedTags(db, WS, ['u1'], ['t1'])).toBe(1)
    expect(writes[0]!.data.pending).toEqual([])
    expect(writes[0]!.data.hasPending).toBe(false)
  })

  it('沒有命中 → 完全不寫（每次貼標都白寫一筆是不行的）', async () => {
    const { db, writes } = fakeSuggestDb({
      u1: { workspaceId: WS, pending: [{ tagId: 't9' }], hasPending: true },
    })
    expect(await prunePendingForAppliedTags(db, WS, ['u1'], ['t1'])).toBe(0)
    expect(writes).toHaveLength(0)
  })

  it('沒有建議文件的客人 → 略過，不建檔', async () => {
    const { db, writes } = fakeSuggestDb({ u1: null })
    expect(await prunePendingForAppliedTags(db, WS, ['u1'], ['t1'])).toBe(0)
    expect(writes).toHaveLength(0)
  })

  it('⛔ 別的租戶的文件一律不動（主鍵撞號也不能跨租戶寫）', async () => {
    const { db, writes } = fakeSuggestDb({
      u1: { workspaceId: 'other-ws', pending: [{ tagId: 't1' }], hasPending: true },
    })
    expect(await prunePendingForAppliedTags(db, WS, ['u1'], ['t1'])).toBe(0)
    expect(writes).toHaveLength(0)
  })

  /**
   * D-42 的成效底帳。人自己手動貼了 AI 也正在建議的那顆＝**AI 判對了**，
   * 只是沒按採用鈕；不記的話這些會從採用率的分子憑空消失。
   */
  it('剪掉建議時記一筆 superseded（AI 猜中、人自己先貼了）', async () => {
    const { db, logs } = fakeSuggestDb({
      u1: { workspaceId: WS, pending: [{ tagId: 't1' }, { tagId: 't2' }], hasPending: true },
    })
    await prunePendingForAppliedTags(db, WS, ['u1'], ['t1'])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ workspaceId: WS, event: 'superseded', tagId: 't1', userId: 'u1' })
  })

  it('沒剪到就不記帳（沒發生的事不能進底帳）', async () => {
    const { db, logs } = fakeSuggestDb({
      u1: { workspaceId: WS, pending: [{ tagId: 't9' }], hasPending: true },
    })
    await prunePendingForAppliedTags(db, WS, ['u1'], ['t1'])
    expect(logs).toHaveLength(0)
  })

  it('空輸入不打 db；批次多人各自處理', async () => {
    const { db, writes } = fakeSuggestDb({
      u1: { workspaceId: WS, pending: [{ tagId: 't1' }], hasPending: true },
      u2: { workspaceId: WS, pending: [{ tagId: 't1' }, { tagId: 't3' }], hasPending: true },
    })
    expect(await prunePendingForAppliedTags(db, WS, [], ['t1'])).toBe(0)
    expect(await prunePendingForAppliedTags(db, WS, ['u1'], [])).toBe(0)
    expect(writes).toHaveLength(0)
    expect(await prunePendingForAppliedTags(db, WS, ['u1', 'u2'], ['t1'])).toBe(2)
    expect(writes.map(w => w.data.hasPending)).toEqual([false, true])
  })
})

describe('filterSuggestible：模型不生 ID 的最後防線', () => {
  const candidates = new Set(['t1', 't2', 't3'])

  it('清單外的 id（模型幻覺）一律丟棄', () => {
    expect(filterSuggestible(['t1', 'made-up', 't2'], candidates)).toEqual(['t1', 't2'])
  })

  it('同一個 id 回兩次只留一個', () => {
    expect(filterSuggestible(['t1', 't1', 't1'], candidates)).toEqual(['t1'])
  })

  it('超過上限截斷（一場最多 3 個，避免一場對話貼滿全身）', () => {
    expect(filterSuggestible(['t1', 't2', 't3'], candidates, 2)).toEqual(['t1', 't2'])
  })

  it('空值與空白 id 不會混進來', () => {
    expect(filterSuggestible(['', '  ', 't2'], candidates)).toEqual(['t2'])
  })

  it('模型全回幻覺 → 空陣列（寧可沒建議，不可錯建議）', () => {
    expect(filterSuggestible(['x', 'y'], candidates)).toEqual([])
  })
})

describe('buildSuggestPrompt', () => {
  const catalog = [
    { id: 't1', name: '送禮客群', criteria: '客人提到要送人、找禮物', mode: 'suggest' as const },
    { id: 't2', name: 'VIP', criteria: '', mode: 'auto' as const },
  ]
  const lines = ['請問禮盒可以代寄嗎', '想送給長輩']

  it('候選標籤帶 id 與名稱；逐字稿只有客人的話', () => {
    const p = buildSuggestPrompt(catalog, lines)
    expect(p).toContain('id: t1｜名稱: 送禮客群｜判斷條件: 客人提到要送人、找禮物')
    expect(p).toContain('id: t2｜名稱: VIP')
    expect(p).toContain('客: 請問禮盒可以代寄嗎')
    expect(p).toContain('只能從清單中選')
  })

  /**
   * 2026-09-03（`C-131`②）：舊版逐字稿含「店:」，而店家／機器人的話佔了一大半，
   * 模型就拿我們自己發的開賣通知當客人的興趣依據（Alice 5 條建議有 3 條是這樣來的）。
   * 現在改成不給看，prompt 的說法也要跟著改——⛔ 留著「店家說的話不能當依據」
   * 會讓模型以為那些話仍在、只是不能引用。
   */
  it('🔴 prompt 不可以再出現「店:」的角色，要明講我們的訊息沒放進來', () => {
    const p = buildSuggestPrompt(catalog, lines)
    expect(p).not.toContain('店: ')
    expect(p).not.toContain('店家（店:）說的話不能當依據')
    expect(p).toContain('刻意不放進來')
    expect(p).toContain('不要憑推測補上')
  })

  it('明講排除句優先（「…的不算」被無視是這次錯最多的一類）', () => {
    expect(buildSuggestPrompt(catalog, lines)).toContain('的不算')
  })

  it('明講一句理由不可套多顆標籤（湊數的訊號）', () => {
    expect(buildSuggestPrompt(catalog, lines)).toContain('同一句理由不可以套在兩顆以上')
  })

  it('沒填條件的標籤不會多出空的「判斷條件:」段', () => {
    const p = buildSuggestPrompt(catalog, lines)
    expect(p).not.toContain('id: t2｜名稱: VIP｜判斷條件:')
  })

  /**
   * 判斷條件欄的 maxlength=200（標籤編輯器）。
   * 先前 prompt 只截前 80 字＝使用者認真寫的條件被默默丟掉一半、畫面一個字都沒講。
   * ⛔ 動標籤編輯器的 maxlength 時，這條會失敗提醒你兩邊要一起改。
   */
  it('條件滿 200 字要整段進 prompt，不准靜默截斷（對齊輸入框上限）', () => {
    const crit = '條'.repeat(200)
    const p = buildSuggestPrompt([{ id: 't1', name: '在看除濕機', criteria: crit, mode: 'suggest' }], lines)
    expect(p).toContain(crit)
  })
})

/**
 * 逐字稿的兩條紅線（`C-131`，2026-09-03 稽核 118 條線上建議抓到的實害）。
 * 兩組測試都是拿**線上真實案例**當輸入——不是造一個剛好會過的情境。
 */
describe('pickCustomerLines：只讀「這一場」、只讀「客人說的話」', () => {
  const ts = (ms: number) => ({ toMillis: () => ms })
  const START = 1_000_000
  const END = START + 3600_000
  const WIN = { startMs: START, endMs: END }

  it('🔴 這一場之前的訊息一律不算（Sam：8/29 只點了問卷登記，卻被拿 5 月的退貨對話貼標）', () => {
    const rows = [
      { direction: 'incoming', text: '您好 我要辦理退貨', timestamp: ts(START - 90 * 86400_000) },
      { direction: 'incoming', text: '是否已安排退貨', timestamp: ts(START - 90 * 86400_000 + 1000) },
      { direction: 'incoming', messageType: 'customer_action', text: '客人從活動「乾淨方max問卷」登記', timestamp: ts(START + 10) },
    ]
    // 這一場裡客人「說的話」是 0 句 → 呼叫端的「至少兩句」門檻會直接跳過這場
    expect(pickCustomerLines(rows, WIN)).toEqual([])
  })

  /**
   * 🔴 上界（2026-09-03 自我複審抓到的：第一版只設了下界）。
   * 排程晚一點才處理到某一場時，客人**後面那場**的訊息全都晚於這場的開始時間，
   * 於是變成這場的證據——錯的方向不同、性質跟上面那條一模一樣。
   */
  it('🔴 這一場結束之後的訊息也不算（下一場的話不可以變成這場的證據）', () => {
    const rows = [
      { direction: 'incoming', text: '這場問的是出貨', timestamp: ts(START + 10) },
      { direction: 'incoming', text: '這場也問出貨', timestamp: ts(START + 20) },
      { direction: 'incoming', text: '隔天新一場問的是退貨', timestamp: ts(END + 86400_000) },
    ]
    expect(pickCustomerLines(rows, WIN)).toEqual(['這場問的是出貨', '這場也問出貨'])
  })

  it('🔴 我們自己發的訊息不算依據（Alice：那 3 條建議的理由是「客人收到多則開賣通知」）', () => {
    const rows = [
      { direction: 'outgoing', text: 'Hi Alice 恭喜你成功啟動專屬開賣通知！香氛機將在 8 月上市', timestamp: ts(START + 10) },
      { direction: 'outgoing', text: '恭喜你成功登記專屬開賣優惠通知！小耳記即將於 8 月上市', timestamp: ts(START + 20) },
      { direction: 'incoming', text: 'BOYA麥克風保固多久', timestamp: ts(START + 30) },
      { direction: 'incoming', text: '可以支援iphone嗎', timestamp: ts(START + 40) },
    ]
    expect(pickCustomerLines(rows, WIN)).toEqual(['BOYA麥克風保固多久', '可以支援iphone嗎'])
  })

  it('真人客服的話也不算（Benjamin Chen 的理由是「店家回覆將於 9 月中旬出貨」）', () => {
    const rows = [
      { direction: 'incoming', text: '加購的貼片沒收到', timestamp: ts(START + 10) },
      { direction: 'outgoing', text: '這批貼片預計 9 月中旬出貨', timestamp: ts(START + 20) },
    ]
    expect(pickCustomerLines(rows, WIN)).toEqual(['加購的貼片沒收到'])
  })

  it('按鈕與加好友這種動作紀錄不是「說的話」', () => {
    const rows = [
      { direction: 'incoming', messageType: 'customer_action', text: '客人點了「真人客服」', timestamp: ts(START + 10) },
      { direction: 'incoming', text: '請問何時出貨', timestamp: ts(START + 20) },
    ]
    expect(pickCustomerLines(rows, WIN)).toEqual(['請問何時出貨'])
  })

  it('⛔ 沒有時間戳的訊息丟掉（分不出屬於哪一場，寧可少一行也不要算舊帳）', () => {
    const rows = [
      { direction: 'incoming', text: '沒有時間戳的舊訊息' },
      { direction: 'incoming', text: '這場的話', timestamp: ts(START + 10) },
    ]
    expect(pickCustomerLines(rows, WIN)).toEqual(['這場的話'])
  })

  it('剛好落在頭尾那一刻的都算這一場（兩端都含，否則開場或收尾那句會掉）', () => {
    const rows = [
      { direction: 'incoming', text: '開場第一句', timestamp: ts(START) },
      { direction: 'incoming', text: '收尾最後一句', timestamp: ts(END) },
    ]
    expect(pickCustomerLines(rows, WIN)).toEqual(['開場第一句', '收尾最後一句'])
  })

  it('空白訊息（貼圖、圖片沒有文字）不佔行；一行最多 300 字', () => {
    const rows = [
      { direction: 'incoming', text: '   ', timestamp: ts(START + 10) },
      { direction: 'incoming', text: '長'.repeat(400), timestamp: ts(START + 20) },
    ]
    expect(pickCustomerLines(rows, WIN)).toEqual(['長'.repeat(300)])
  })
})

describe('sessionWindow：算不出範圍就要回 null（失敗方向選「這場不產生建議」）', () => {
  const ts = (ms: number) => ({ toMillis: () => ms })
  const T = 1_700_000_000_000

  it('有 openedAt 與 closedAt → 直接用', () => {
    expect(sessionWindow({ openedAt: ts(T), closedAt: ts(T + 1000), lastActivityAt: ts(T + 900) }))
      .toEqual({ startMs: T, endMs: T + 1000 })
  })

  it('沒有 closedAt → 退回最後活動時間當上界', () => {
    expect(sessionWindow({ openedAt: ts(T), lastActivityAt: ts(T + 500) })).toEqual({ startMs: T, endMs: T + 500 })
  })

  it('舊會話沒有 openedAt → 下界退回「上界往前 24 小時」（一場的上限）', () => {
    expect(sessionWindow({ lastActivityAt: ts(T) })).toEqual({ startMs: T - 24 * 3600_000, endMs: T })
  })

  /**
   * 🔴 兩個時間都讀不到時，第一版算出 `0 - 24h = -86400000`＝**比不設下界更寬鬆**，
   * 剛修好的過濾當場失效（自我複審抓到）。這條釘的就是那個負數。
   */
  it('🔴 兩個時間都讀不到 → null（⛔ 不可以算出負數下界，那比不過濾還糟）', () => {
    expect(sessionWindow({})).toBeNull()
    expect(sessionWindow({ openedAt: 123, lastActivityAt: 'not-a-timestamp' })).toBeNull()
  })

  it('頭尾顛倒（資料壞掉）→ null，不要硬算', () => {
    expect(sessionWindow({ openedAt: ts(T + 1000), closedAt: ts(T) })).toBeNull()
  })
})

/**
 * 一句理由套多顆標籤＝湊數（`C-131` 的第三種錯法）。
 * 線上實例：Yangyang 的「問過發票」「在等開賣」「問過出貨進度」三顆，
 * 理由都是同一句「客人詢問出貨時間，並希望提早出貨」。
 */
describe('dropDuplicateReasons：同一句理由只能算一顆標籤', () => {
  it('🔴 三顆共用一句理由 → 只留第一顆，其餘回報為丟掉', () => {
    const reason = '客人詢問出貨時間，並希望提早出貨'
    const { kept, dropped } = dropDuplicateReasons([
      { id: 'shipping', reason },
      { id: 'invoice', reason },
      { id: 'launch', reason },
    ])
    expect(kept.map(k => k.id)).toEqual(['shipping'])
    expect(dropped.map(d => d.id)).toEqual(['invoice', 'launch'])
  })

  it('只差標點空白也算同一句（模型常改一個逗號）', () => {
    const { kept } = dropDuplicateReasons([
      { id: 'a', reason: '客人詢問出貨時間，希望提早出貨' },
      { id: 'b', reason: '客人詢問出貨時間 希望提早出貨。' },
    ])
    expect(kept.map(k => k.id)).toEqual(['a'])
  })

  it('理由各自不同 → 全部留下（正常情況不能被誤殺）', () => {
    const { kept, dropped } = dropDuplicateReasons([
      { id: 'a', reason: '客人問麥克風續航' },
      { id: 'b', reason: '客人問訂單什麼時候出貨' },
    ])
    expect(kept).toHaveLength(2)
    expect(dropped).toHaveLength(0)
  })

  it('⛔ 理由留空不在這裡處理（那是另一種毛病，別混在一起吃掉）', () => {
    const { kept } = dropDuplicateReasons([{ id: 'a', reason: '' }, { id: 'b', reason: '' }])
    expect(kept.map(k => k.id)).toEqual(['a', 'b'])
  })
})

describe('recordManualRemovalAsDismissed：手動拆標＝否決票（防 auto 拉鋸戰）', () => {
  /** tags getAll ＋ userTagSuggestions doc get/set 的迷你假 db */
  function fakeDb(opts: {
    tags: Record<string, Record<string, unknown> | null>
    suggestions: Record<string, Record<string, unknown> | null>
  }) {
    const writes: Array<{ id: string; data: any }> = []
    const db: any = {
      collection: (name: string) => ({
        doc: (id: string) => ({
          __col: name,
          __id: id,
          get: async () => ({
            id,
            exists: opts.suggestions[id] != null,
            data: () => opts.suggestions[id],
          }),
          set: async (data: any) => { writes.push({ id, data }) },
        }),
      }),
      getAll: async (...refs: Array<{ __id: string }>) =>
        refs.map(r => ({ id: r.__id, exists: opts.tags[r.__id] != null, data: () => opts.tags[r.__id] })),
    }
    return { db, writes }
  }

  it('拆掉 AI 在判的標籤 → 記進 dismissedTagIds，pending 裡同顆建議一併清掉', async () => {
    const { db, writes } = fakeDb({
      tags: { t1: { workspaceId: 'ws1', aiMode: 'auto' } },
      suggestions: { u1: { workspaceId: 'ws1', pending: [{ tagId: 't1' }, { tagId: 't2' }], dismissedTagIds: [], hasPending: true } },
    })
    await recordManualRemovalAsDismissed(db, 'ws1', ['u1'], ['t1'])
    expect(writes).toHaveLength(1)
    expect(writes[0]!.data.dismissedTagIds).toContain('t1')
    expect(writes[0]!.data.pending).toEqual([{ tagId: 't2' }])
    expect(writes[0]!.data.hasPending).toBe(true)
  })

  it('拆掉 off 標籤（問卷/客服這類）→ 完全不寫（別為日常移標多建文件）', async () => {
    const { db, writes } = fakeDb({
      tags: { t1: { workspaceId: 'ws1' } }, // 沒有 aiMode ＝ off
      suggestions: {},
    })
    await recordManualRemovalAsDismissed(db, 'ws1', ['u1'], ['t1'])
    expect(writes).toHaveLength(0)
  })

  it('客人還沒有建議文件 → 建一份只帶否決票的（auto 不記住就會貼回來）', async () => {
    const { db, writes } = fakeDb({
      tags: { t1: { workspaceId: 'ws1', aiMode: 'suggest' } },
      suggestions: { u1: null },
    })
    await recordManualRemovalAsDismissed(db, 'ws1', ['u1'], ['t1'])
    expect(writes).toHaveLength(1)
    expect(writes[0]!.data.dismissedTagIds).toEqual(['t1'])
    expect(writes[0]!.data.hasPending).toBe(false)
  })

  it('⛔ 別的租戶的標籤／建議文件一律不動', async () => {
    const { db, writes } = fakeDb({
      tags: { t1: { workspaceId: 'other', aiMode: 'auto' } },
      suggestions: { u1: { workspaceId: 'ws1', pending: [], dismissedTagIds: [], hasPending: false } },
    })
    await recordManualRemovalAsDismissed(db, 'ws1', ['u1'], ['t1'])
    expect(writes).toHaveLength(0)
  })

  it('已經在否決名單裡 → 不重複寫', async () => {
    const { db, writes } = fakeDb({
      tags: { t1: { workspaceId: 'ws1', aiMode: 'auto' } },
      suggestions: { u1: { workspaceId: 'ws1', pending: [], dismissedTagIds: ['t1'], hasPending: false } },
    })
    await recordManualRemovalAsDismissed(db, 'ws1', ['u1'], ['t1'])
    expect(writes).toHaveLength(0)
  })
})

/**
 * 整條路徑真的跑到了嗎（⛔ 純函式綠 ＋ typecheck 綠 ≠ 新程式被執行過）。
 *
 * 這組存在的理由：`pickCustomerLines` 可以寫得完美無缺，但只要 `suggestForSession`
 * 沒把「這一場的開始時間」傳進去，線上行為就一個字都沒改變——而上面那些單元測試
 * 照樣全綠。所以這裡從排程入口 `scanTagSuggestions` 打進去，斷言**送到模型手上的
 * prompt** 到底裝了什麼。
 *
 * 迷你假 Firestore：只實作這條路徑真的用到的鏈。
 */
function fakeScanDb(opts: {
  /** 這一場的訊息（時間戳用毫秒） */
  messages: Array<{ direction: string, text: string, atMs: number, messageType?: string }>
  sessionOpenedAtMs: number
  /** AI 在判的標籤 */
  tags?: Array<{ id: string, name: string, aiMode: 'suggest' | 'auto' }>
  /** 這位客人收件匣裡**已經**掛著的建議（`D-61`：切成「直接貼」之前留下的那些） */
  pending?: Array<{ tagId: string, reason?: string, sessionId?: string, suggestedAtMs?: number }>
}) {
  const writes: Array<{ col: string, id: string, data: any }> = []
  const chain = (result: any) => {
    const q: any = { where: () => q, orderBy: () => q, limit: () => q, select: () => q, get: async () => result }
    return q
  }
  const tagDocs = (opts.tags ?? [{ id: 't_ship', name: '問過出貨進度', aiMode: 'suggest' as const }])
    .map(t => ({ id: t.id, data: () => ({ name: t.name, aiMode: t.aiMode, status: 'active', code: t.name }) }))
  const msgDocs = opts.messages
    .slice().sort((a, b) => b.atMs - a.atMs) // 查詢是 timestamp desc
    .map(m => ({ data: () => ({ direction: m.direction, text: m.text, messageType: m.messageType ?? 'text', timestamp: { toMillis: () => m.atMs } }) }))

  const db: any = {
    collection(name: string) {
      if (name === 'workspaces') return chain({ docs: [{ id: 'ws1' }] })
      if (name === 'tags') return chain({ size: tagDocs.length, docs: tagDocs })
      if (name === 'conversationSessions') {
        return chain({
          empty: false,
          docs: [{
            id: 'sess1',
            data: () => ({
              userId: 'U1',
              openedAt: { toMillis: () => opts.sessionOpenedAtMs },
              lastActivityAt: { toMillis: () => opts.sessionOpenedAtMs + 3600_000 },
            }),
          }],
        })
      }
      if (name === 'userTags') return chain({ docs: [] })
      if (name === 'cronState' || name === 'userTagSuggestions') {
        return {
          doc: (id: string) => ({
            get: async () => ({
              id,
              exists: name === 'cronState' || (name === 'userTagSuggestions' && !!opts.pending),
              // 游標要有值，否則掃描器只會把游標定在「現在」就走人（開關剛打開的行為）
              data: () => (name === 'cronState'
                ? { cursorMs: 1 }
                : (opts.pending ? { workspaceId: 'ws1', userId: id, pending: opts.pending, hasPending: true } : undefined)),
            }),
            set: async (data: any) => { writes.push({ col: name, id, data }) },
          }),
        }
      }
      if (name === 'conversations') {
        return { doc: () => ({ collection: () => chain({ docs: msgDocs }) }) }
      }
      // 成效底帳走 batch().set(ref, data)；ref 只需要認得出是哪個 collection
      if (name === 'tagSuggestionLogs') return { doc: (id: string) => ({ __col: name, __id: id }) }
      return chain({ size: 0, docs: [], empty: true })
    },
    batch: () => ({
      set: (ref: { __col: string }, data: any) => { writes.push({ col: ref.__col, id: '', data }) },
      commit: async () => {},
    }),
  }
  return { db, writes }
}

describe('scanTagSuggestions：送到模型手上的 prompt 真的只有「這一場、客人說的」', () => {
  const START = 1_700_000_000_000
  /** 送進 generateJson 的那份 prompt */
  const sentPrompt = () => String(vi.mocked(generateJson).mock.calls[0]?.[0] ?? '')

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getAiSettings).mockResolvedValue({ autoTagSuggest: { enabled: true } } as any)
    vi.mocked(runWithLlmBudget).mockImplementation(async (_wid: any, fn: any) => {
      const data = await fn()
      return { data, inputTokens: 10, outputTokens: 5 } as any
    })
    vi.mocked(generateJson).mockResolvedValue({ tags: [] } as any)
  })

  it('🔴 上一場的舊訊息不進 prompt（Sam：8/29 那場只點了問卷登記，卻被拿 5 月的話貼標）', async () => {
    const { db } = fakeScanDb({
      sessionOpenedAtMs: START,
      messages: [
        { direction: 'incoming', text: '我要辦理退貨', atMs: START - 90 * 86400_000 },
        { direction: 'incoming', text: '是否已安排退貨', atMs: START - 90 * 86400_000 + 1000 },
        { direction: 'incoming', text: '客人從活動「乾淨方max問卷」登記', atMs: START + 10, messageType: 'customer_action' },
      ],
    })
    await scanTagSuggestions(db)
    // 這一場客人一句話都沒說 → 連 LLM 都不該花
    expect(generateJson).not.toHaveBeenCalled()
  })

  it('🔴 我們自己發的開賣通知不進 prompt（Alice 那 3 條建議的依據）', async () => {
    const { db } = fakeScanDb({
      sessionOpenedAtMs: START,
      messages: [
        { direction: 'outgoing', text: '恭喜你成功啟動專屬開賣通知！香氛機即將上市', atMs: START + 10 },
        { direction: 'incoming', text: 'BOYA麥克風保固多久', atMs: START + 20 },
        { direction: 'incoming', text: '可以支援iphone嗎', atMs: START + 30 },
      ],
    })
    await scanTagSuggestions(db)

    expect(generateJson).toHaveBeenCalledTimes(1)
    expect(sentPrompt()).not.toContain('開賣通知')
    expect(sentPrompt()).toContain('BOYA麥克風保固多久')
    expect(sentPrompt()).toContain('可以支援iphone嗎')
  })

  it('🔴 三顆標籤共用一句理由 → 收件匣只留一顆（Yangyang 的湊數）', async () => {
    const reason = '客人詢問出貨時間，並希望提早出貨'
    vi.mocked(generateJson).mockResolvedValue({
      tags: [
        { id: 't_ship', reason },
        { id: 't_invoice', reason },
        { id: 't_launch', reason },
      ],
    } as any)
    const { db, writes } = fakeScanDb({
      sessionOpenedAtMs: START,
      tags: [
        { id: 't_ship', name: '問過出貨進度', aiMode: 'suggest' },
        { id: 't_invoice', name: '問過發票', aiMode: 'suggest' },
        { id: 't_launch', name: '在等開賣', aiMode: 'suggest' },
      ],
      messages: [
        { direction: 'incoming', text: '請問出貨進度', atMs: START + 10 },
        { direction: 'incoming', text: '可以提早出貨嗎', atMs: START + 20 },
      ],
    })
    await scanTagSuggestions(db)

    const inbox = writes.find(w => w.col === 'userTagSuggestions')
    expect(inbox).toBeTruthy()
    expect(inbox!.data.pending).toHaveLength(1)
    expect(inbox!.data.pending[0]).toMatchObject({ tagId: 't_ship', reason })
    // 底帳（採用率的分母）也只能記真的進了收件匣的那一顆
    const logged = writes.filter(w => w.col === 'tagSuggestionLogs')
    expect(logged).toHaveLength(1)
    expect(logged[0]!.data).toMatchObject({ event: 'suggested', tagId: 't_ship' })
  })

  /**
   * 🔴 去重與上限的**順序**（2026-09-03 自我複審抓到）。
   * 先套「一場最多 3 顆」的上限，湊數的重複項會先佔掉名額：模型回
   * [A(r1) B(r1) C(r1) D(r2)] 時，上限先砍掉 D（唯一依據不同的那顆），
   * 去重再殺掉 B、C，最後只剩 A——正確答案是 A＋D 兩顆。
   */
  it('🔴 重複理由不可以佔掉名額：3 顆同理由＋1 顆不同理由 → 留 2 顆（不是 1 顆）', async () => {
    const reason = '客人詢問出貨時間，並希望提早出貨'
    vi.mocked(generateJson).mockResolvedValue({
      tags: [
        { id: 't_ship', reason },
        { id: 't_invoice', reason },
        { id: 't_launch', reason },
        { id: 't_defect', reason: '客人回報收到的貼片有破損' },
      ],
    } as any)
    const { db, writes } = fakeScanDb({
      sessionOpenedAtMs: START,
      tags: [
        { id: 't_ship', name: '問過出貨進度', aiMode: 'suggest' },
        { id: 't_invoice', name: '問過發票', aiMode: 'suggest' },
        { id: 't_launch', name: '在等開賣', aiMode: 'suggest' },
        { id: 't_defect', name: '回報過商品故障', aiMode: 'suggest' },
      ],
      messages: [
        { direction: 'incoming', text: '請問出貨進度', atMs: START + 10 },
        { direction: 'incoming', text: '貼片破了', atMs: START + 20 },
      ],
    })
    await scanTagSuggestions(db)

    const inbox = writes.find(w => w.col === 'userTagSuggestions')
    expect(inbox!.data.pending.map((p: any) => p.tagId)).toEqual(['t_ship', 't_defect'])
  })

  /* ── 收件匣的舊建議不可以把「AI 直接貼」卡死（`D-61`）──────────────
     09-04 線上實況：13 顆標籤全設成「判到直接貼」，但 64 位客人身上留著 116 條
     切換前的舊建議。舊規則「這顆已經在等人決定就跳過」連 auto 也擋，於是
     **AI 不會自己貼、人也沒在按**，兩邊都不會發生，而畫面只寫著一個不會少的「待審 N 位」。 */
  it('🔴 收件匣掛著舊建議，也擋不住「AI 直接貼」：照判、照貼，並把那條舊建議收掉', async () => {
    vi.mocked(generateJson).mockResolvedValue({ tags: [{ id: 't_ship', reason: '客人問出貨進度' }] } as any)
    vi.mocked(addTagsToUser).mockResolvedValueOnce({ added: ['t_ship'], skipped: [], hits: [] })
    const { db, writes } = fakeScanDb({
      sessionOpenedAtMs: START,
      tags: [{ id: 't_ship', name: '問過出貨進度', aiMode: 'auto' }],
      pending: [{ tagId: 't_ship', reason: '（切成直接貼之前留下的）', suggestedAtMs: START - 86400_000 }],
      messages: [
        { direction: 'incoming', text: '請問出貨進度', atMs: START + 10 },
        { direction: 'incoming', text: '可以提早出貨嗎', atMs: START + 20 },
      ],
    })
    await scanTagSuggestions(db)

    // ① 這顆有進候選＝真的被判了（先前這裡根本不會呼叫 LLM）
    expect(generateJson).toHaveBeenCalledTimes(1)
    // ② 真的貼上了
    expect(vi.mocked(addTagsToUser).mock.calls[0]?.[1]).toEqual(['t_ship'])
    // ③ 那條舊建議要收掉，否則「待審 N 位」永遠不會減少
    const inbox = writes.filter(w => w.col === 'userTagSuggestions')
    expect(inbox).toHaveLength(1)
    expect(inbox[0]!.data.pending).toEqual([])
    expect(inbox[0]!.data.hasPending).toBe(false)
    // ④ 結局記成 auto_applied（沒有人按過，不可以記成 applied 灌水採用率）
    expect(writes.filter(w => w.col === 'tagSuggestionLogs').map(w => w.data.event)).toEqual(['auto_applied'])
  })

  it('「先建議」型有舊建議時照舊跳過（⛔ 同一個建議不可以每場對話都回來一次）', async () => {
    const { db, writes } = fakeScanDb({
      sessionOpenedAtMs: START,
      tags: [{ id: 't_ship', name: '問過出貨進度', aiMode: 'suggest' }],
      pending: [{ tagId: 't_ship', reason: '上一場就提過了', suggestedAtMs: START - 86400_000 }],
      messages: [
        { direction: 'incoming', text: '請問出貨進度', atMs: START + 10 },
        { direction: 'incoming', text: '可以提早出貨嗎', atMs: START + 20 },
      ],
    })
    await scanTagSuggestions(db)

    expect(generateJson).not.toHaveBeenCalled() // 沒有候選＝連 LLM 都不該花
    expect(writes.filter(w => w.col === 'userTagSuggestions')).toHaveLength(0)
  })

  it('🔴 同一輪又收又加：收掉的那條不可以被後面那次寫入原封不動塞回去', async () => {
    vi.mocked(generateJson).mockResolvedValue({
      tags: [
        { id: 't_ship', reason: '客人問出貨進度' },
        { id: 't_invoice', reason: '客人問發票怎麼開' },
      ],
    } as any)
    vi.mocked(addTagsToUser).mockResolvedValueOnce({ added: ['t_ship'], skipped: [], hits: [] })
    const { db, writes } = fakeScanDb({
      sessionOpenedAtMs: START,
      tags: [
        { id: 't_ship', name: '問過出貨進度', aiMode: 'auto' },
        { id: 't_invoice', name: '問過發票', aiMode: 'suggest' },
      ],
      pending: [{ tagId: 't_ship', reason: '（切成直接貼之前留下的）', suggestedAtMs: START - 86400_000 }],
      messages: [
        { direction: 'incoming', text: '請問出貨進度', atMs: START + 10 },
        { direction: 'incoming', text: '發票可以開公司嗎', atMs: START + 20 },
      ],
    })
    await scanTagSuggestions(db)

    // 最後一次寫入才是收件匣的最終狀態：只能有新加的那顆
    const inbox = writes.filter(w => w.col === 'userTagSuggestions')
    expect(inbox.at(-1)!.data.pending.map((p: any) => p.tagId)).toEqual(['t_invoice'])
  })

  /** 這一輪什麼都沒建議時，原因要進資料（不是只留一行 log 讓人事後猜） */
  it('🔴 沒產出建議時，跳過的原因要寫進 cronState 的 lastRound', async () => {
    const { db, writes } = fakeScanDb({
      sessionOpenedAtMs: START,
      messages: [
        { direction: 'incoming', text: '這是上一場的話', atMs: START - 90 * 86400_000 },
      ],
    })
    await scanTagSuggestions(db)

    const state = writes.find(w => w.col === 'cronState')
    expect(state!.data.lastRound).toMatchObject({ sessions: 1, suggested: 0, tooFewLines: 1, noWindow: 0 })
  })
})
