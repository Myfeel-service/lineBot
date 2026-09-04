/**
 * 「一次審一顆標籤」的純邏輯（`D-61`）。
 * 釘的是兩件事：挑得對（含排序與截斷回報），以及結果講得清楚。
 */
import { describe, it, expect } from 'vitest'
import { bulkReviewOutcomeText, pendingWhenText, pickPendingForTag } from './tag-pending-review'

describe('pickPendingForTag：只挑這一顆的待審', () => {
  const docs = [
    { id: 'u1', pending: [{ tagId: 't_ship', reason: '問出貨', sessionId: 's1', suggestedAtMs: 300 }, { tagId: 't_invoice', reason: '問發票', suggestedAtMs: 100 }] },
    { id: 'u2', pending: [{ tagId: 't_ship', reason: '追進度', sessionId: 's2', suggestedAtMs: 100 }] },
    { id: 'u3', pending: [{ tagId: 't_invoice', reason: '要打統編', suggestedAtMs: 200 }] },
  ]

  it('別顆的建議不會混進來（先前點「待審 34 位」會看到 64 位就是這個病）', () => {
    const { rows } = pickPendingForTag(docs, 't_ship')
    expect(rows.map(r => r.userId)).toEqual(['u2', 'u1'])
  })

  it('最舊的排前面（等最久的先處理）', () => {
    const { rows } = pickPendingForTag(docs, 't_ship')
    expect(rows[0]!.suggestedAtMs).toBe(100)
    expect(rows[1]!.suggestedAtMs).toBe(300)
  })

  it('⛔ 沒有時間的舊資料沉到最後，不可以當成「1970 年＝最舊」霸佔清單頂端', () => {
    const { rows } = pickPendingForTag([
      { id: 'old', pending: [{ tagId: 't_ship', reason: '舊資料' }] },
      { id: 'u2', pending: [{ tagId: 't_ship', reason: '有時間', suggestedAtMs: 100 }] },
    ], 't_ship')
    expect(rows.map(r => r.userId)).toEqual(['u2', 'old'])
    expect(rows[1]!.suggestedAtMs).toBe(0) // 0＝畫面要寫「時間不明」
  })

  it('⛔ 撞到上限要說得出丟了幾條（靜靜截斷＝看起來就是「只有這麼多人在等」）', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      id: `u${i}`, pending: [{ tagId: 't_ship', reason: '', suggestedAtMs: i + 1 }],
    }))
    const { rows, dropped } = pickPendingForTag(many, 't_ship', 3)
    expect(rows).toHaveLength(3)
    expect(dropped).toBe(2)
  })

  it('沒有 sessionId 的舊資料回 null（畫面才不會給一個點了跑錯地方的連結）', () => {
    const { rows } = pickPendingForTag([{ id: 'u1', pending: [{ tagId: 't_ship', reason: 'x' }] }], 't_ship')
    expect(rows[0]!.sessionId).toBeNull()
  })

  it('壞掉／空的 pending 欄位不會炸（舊文件可能沒有這個欄位）', () => {
    const { rows, dropped } = pickPendingForTag(
      [{ id: 'u1', pending: null }, { id: 'u2' }],
      't_ship',
    )
    expect(rows).toEqual([])
    expect(dropped).toBe(0)
  })
})

describe('pendingWhenText：等多久了', () => {
  it('⛔ 沒記時間要講「時間不明」，不可以印成 1970 年', () => {
    expect(pendingWhenText(0)).toBe('時間不明')
    expect(pendingWhenText(Number.NaN)).toBe('時間不明')
  })

  it('⛔ 不印秒（小字裡的 :11 是純噪音）', () => {
    const out = pendingWhenText(Date.UTC(2026, 7, 26, 11, 30, 11), 'en-US')
    expect(out).not.toMatch(/:\d\d:\d\d/)
    expect(out).toMatch(/2026/)
  })
})

describe('bulkReviewOutcomeText：四種數字要分得出來', () => {
  it('全部成功就只講一句', () => {
    expect(bulkReviewOutcomeText('apply', { processed: 34, alreadyHandled: 0, notProcessed: 0, failed: 0 }))
      .toBe('已貼上標籤 34 位')
  })

  it('⛔ 別人先按掉的要講（不然勾 34 位成功 30 位，人會以為系統壞了）', () => {
    expect(bulkReviewOutcomeText('dismiss', { processed: 30, alreadyHandled: 4, notProcessed: 0, failed: 0 }))
      .toBe('已忽略 30 位；4 位已經被處理過（略過）')
  })

  it('撞到單次上限與失敗要分開講（下一步不一樣：一個再按一次、一個要查）', () => {
    expect(bulkReviewOutcomeText('apply', { processed: 100, alreadyHandled: 0, notProcessed: 16, failed: 2 }))
      .toBe('已貼上標籤 100 位；還有 16 位沒處理，再按一次；2 位失敗')
  })
})
