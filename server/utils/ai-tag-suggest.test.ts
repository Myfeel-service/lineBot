/**
 * AI 讀對話貼標建議（ai-tag-suggest.ts）。
 * 釘的是兩條鐵律：
 *   1. ⛔ 模型不生 ID——回來的 tagId 只留白名單（候選集合）內的，幻覺 id、重複 id 全丟。
 *   2. prompt 只給「還能建議的候選」，且逐字稿把店家的話標開（店家的話不能當貼標依據）。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__' },
  Timestamp: { fromMillis: (ms: number) => ({ __ms: ms }) },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('./gemini', () => ({ generateJson: vi.fn(), runWithLlmBudget: vi.fn() }))
vi.mock('./ai-settings', () => ({ getAiSettings: vi.fn() }))
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn() }))
vi.mock('./inactive-tag', () => ({ INACTIVE_TAG_CODE: 'sys_inactive' }))

import { filterSuggestible, buildSuggestPrompt, prunePendingForAppliedTags, recordManualRemovalAsDismissed } from './ai-tag-suggest'

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
  const transcript = [
    { role: 'customer' as const, text: '請問禮盒可以代寄嗎' },
    { role: 'shop' as const, text: '可以的，結帳時填收件人就好' },
  ]

  it('候選標籤帶 id 與名稱；客/店逐字稿標開（店家的話不能當依據，prompt 有講）', () => {
    const p = buildSuggestPrompt(catalog, transcript)
    expect(p).toContain('id: t1｜名稱: 送禮客群｜判斷條件: 客人提到要送人、找禮物')
    expect(p).toContain('id: t2｜名稱: VIP')
    expect(p).toContain('客: 請問禮盒可以代寄嗎')
    expect(p).toContain('店: 可以的，結帳時填收件人就好')
    expect(p).toContain('店家（店:）說的話不能當依據')
    expect(p).toContain('只能從清單中選')
  })

  it('沒填條件的標籤不會多出空的「判斷條件:」段', () => {
    const p = buildSuggestPrompt(catalog, transcript)
    expect(p).not.toContain('id: t2｜名稱: VIP｜判斷條件:')
  })

  /**
   * 判斷條件欄的 maxlength=200（標籤編輯器）。
   * 先前 prompt 只截前 80 字＝使用者認真寫的條件被默默丟掉一半、畫面一個字都沒講。
   * ⛔ 動標籤編輯器的 maxlength 時，這條會失敗提醒你兩邊要一起改。
   */
  it('條件滿 200 字要整段進 prompt，不准靜默截斷（對齊輸入框上限）', () => {
    const crit = '條'.repeat(200)
    const p = buildSuggestPrompt([{ id: 't1', name: '在看除濕機', criteria: crit, mode: 'suggest' }], transcript)
    expect(p).toContain(crit)
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
