/**
 * 「採用／忽略一條 AI 貼標建議」的唯一寫入點——**成效底帳的分子與分母就在這裡產生**。
 *
 * 為什麼非測不可（2026-09-04 `/code-review` 抓到它零測試）：`tag-suggestion-log.ts` 的檔頭
 * 寫著「這種帳現在不記，之後永遠補不回來」。這支若有回歸——採用時漏記、忽略時沒進
 * 「永不再提」、或把不在待審裡的也順手處理掉——**畫面完全正常，只有統計悄悄失真**，
 * 而失真的帳是補不回來的。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const addTagsToUser = vi.fn(async () => ({ added: [] as string[], skipped: [] as string[], hits: [] as any[] }))
const recordTagSuggestionEvents = vi.fn(async () => {})

vi.mock('./tagging', () => ({ addTagsToUser }))
vi.mock('./tag-suggestion-log', () => ({ recordTagSuggestionEvents }))
vi.mock('./ai-tag-suggest', () => ({ AI_TAG_SUGGEST_SOURCE_REF: 'ai-tag-suggest' }))
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '<ts>' },
}))

const { reviewSuggestions } = await import('./tag-suggestion-review')

const WID = 'ws1'
const UID = 'ws1_U123'

/** 假 Firestore：一份收件匣文件，記下寫進去的內容 */
function makeDb(doc: any | undefined) {
  const sets: any[] = []
  const db: any = {
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: doc !== undefined, data: () => doc }),
        set: async (data: any) => { sets.push(data) },
      }),
    }),
  }
  return { db, sets }
}

beforeEach(() => {
  addTagsToUser.mockClear()
  recordTagSuggestionEvents.mockClear()
})

describe('reviewSuggestions：採用', () => {
  it('真的貼上標籤、記進底帳、並從待審移除', async () => {
    const { db, sets } = makeDb({
      workspaceId: WID,
      pending: [{ tagId: 't_ship' }, { tagId: 't_invoice' }],
    })
    const r = await reviewSuggestions(db, { workspaceId: WID, userDocId: UID, tagIds: ['t_ship'], action: 'apply', operatorId: 'op1' })

    expect(r).toEqual({ outcome: 'done', processed: ['t_ship'] })
    expect(addTagsToUser).toHaveBeenCalledWith(UID, ['t_ship'], 'ai', 'ai-tag-suggest', WID)
    // 🔴 分子：沒記的話「這顆 AI 判得準不準」永遠算不出來
    expect(recordTagSuggestionEvents).toHaveBeenCalledWith(
      db, WID, 'applied', UID, ['t_ship'], { operatorId: 'op1' },
    )
    expect(sets[0].pending.map((p: any) => p.tagId)).toEqual(['t_invoice'])
    expect(sets[0].hasPending).toBe(true)
  })

  it('⛔採用不可以動到「永不再提」名單（那是忽略才有的語意）', async () => {
    const { db, sets } = makeDb({ workspaceId: WID, pending: [{ tagId: 't_ship' }], dismissedTagIds: ['t_old'] })
    await reviewSuggestions(db, { workspaceId: WID, userDocId: UID, tagIds: ['t_ship'], action: 'apply' })
    expect(sets[0].dismissedTagIds).toEqual(['t_old'])
  })

  it('待審清空後 hasPending 要跟著 false（列表靠它做等值查詢）', async () => {
    const { db, sets } = makeDb({ workspaceId: WID, pending: [{ tagId: 't_ship' }] })
    await reviewSuggestions(db, { workspaceId: WID, userDocId: UID, tagIds: ['t_ship'], action: 'apply' })
    expect(sets[0].pending).toEqual([])
    expect(sets[0].hasPending).toBe(false)
  })
})

describe('reviewSuggestions：忽略', () => {
  it('不貼標籤、記進底帳、而且要進「永不再提」名單', async () => {
    const { db, sets } = makeDb({ workspaceId: WID, pending: [{ tagId: 't_ship' }], dismissedTagIds: ['t_old'] })
    const r = await reviewSuggestions(db, { workspaceId: WID, userDocId: UID, tagIds: ['t_ship'], action: 'dismiss', operatorId: 'op1' })

    expect(r.outcome).toBe('done')
    expect(addTagsToUser).not.toHaveBeenCalled()
    // 🔴 忽略只寫進 dismissedTagIds（沒有時間、又跟手動移除混在一起），不記底帳就算不出分母
    expect(recordTagSuggestionEvents).toHaveBeenCalledWith(
      db, WID, 'dismissed', UID, ['t_ship'], { operatorId: 'op1' },
    )
    expect(sets[0].dismissedTagIds).toEqual(['t_old', 't_ship'])
  })

  it('同一顆忽略兩次不會在名單裡出現兩筆', async () => {
    const { db, sets } = makeDb({ workspaceId: WID, pending: [{ tagId: 't_ship' }], dismissedTagIds: ['t_ship'] })
    await reviewSuggestions(db, { workspaceId: WID, userDocId: UID, tagIds: ['t_ship'], action: 'dismiss' })
    expect(sets[0].dismissedTagIds).toEqual(['t_ship'])
  })
})

describe('reviewSuggestions：三種結果要分得出來', () => {
  it('沒有收件匣文件 → not_found（⛔不可以當成「已經被處理過」）', async () => {
    const { db, sets } = makeDb(undefined)
    const r = await reviewSuggestions(db, { workspaceId: WID, userDocId: UID, tagIds: ['t_ship'], action: 'apply' })
    expect(r).toEqual({ outcome: 'not_found', processed: [] })
    expect(sets).toHaveLength(0)
    expect(addTagsToUser).not.toHaveBeenCalled()
  })

  it('⛔別的工作區的文件一律當成不存在（跨租戶保護）', async () => {
    const { db, sets } = makeDb({ workspaceId: 'ws_other', pending: [{ tagId: 't_ship' }] })
    const r = await reviewSuggestions(db, { workspaceId: WID, userDocId: UID, tagIds: ['t_ship'], action: 'apply' })
    expect(r.outcome).toBe('not_found')
    expect(sets).toHaveLength(0)
  })

  it('這幾顆已經不在待審裡 → already_handled，而且什麼都不寫', async () => {
    const { db, sets } = makeDb({ workspaceId: WID, pending: [{ tagId: 't_other' }] })
    const r = await reviewSuggestions(db, { workspaceId: WID, userDocId: UID, tagIds: ['t_ship'], action: 'apply' })
    expect(r).toEqual({ outcome: 'already_handled', processed: [] })
    expect(sets).toHaveLength(0)
    expect(recordTagSuggestionEvents).not.toHaveBeenCalled()
  })

  it('🔴 只處理「真的還在待審」的那幾顆：不在待審裡的不可以順手貼上', async () => {
    // 兩個客服同時開著同一位，後按的那位不該重複貼標
    const { db, sets } = makeDb({ workspaceId: WID, pending: [{ tagId: 't_ship' }] })
    const r = await reviewSuggestions(db, {
      workspaceId: WID, userDocId: UID, tagIds: ['t_ship', 't_already_gone'], action: 'apply',
    })
    expect(r.processed).toEqual(['t_ship'])
    expect(addTagsToUser).toHaveBeenCalledWith(UID, ['t_ship'], 'ai', 'ai-tag-suggest', WID)
    // 底帳也只能記真的處理掉的那一顆，否則分子灌水
    expect(recordTagSuggestionEvents).toHaveBeenCalledWith(db, WID, 'applied', UID, ['t_ship'], { operatorId: null })
    expect(sets[0].pending).toEqual([])
  })
})
