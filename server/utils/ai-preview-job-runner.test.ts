import { describe, expect, it } from 'vitest'
import { pickStaleJobs } from './ai-preview-job-runner'

/**
 * 排程接手推進匯入工作（`D-50` 簡化 3）的挑選規則。
 *
 * 為什麼這支特別要測：三種「不推」的理由在畫面與紀錄上必須分得出來——
 * 「有人在看」是正常、「排程追不上」要加量、「資料壞了」要有人去查。
 * 併成一個「跳過 N 份」的話，排程其實完全沒在動也看不出來（本專案的沉默死亡已發生三次）。
 */
describe('pickStaleJobs', () => {
  const NOW = 1_700_000_000_000

  it('沒人持租約的才推，並回報份數', () => {
    const r = pickStaleJobs(
      [
        { id: 'a', workspaceId: 'w1', leaseUntil: 0 },
        { id: 'b', workspaceId: 'w1', leaseUntil: NOW - 1000 }, // 租約過期＝沒人在看
      ],
      NOW,
      5,
    )
    expect(r.stale).toEqual([
      { jobId: 'a', workspaceId: 'w1' },
      { jobId: 'b', workspaceId: 'w1' },
    ])
    expect(r).toMatchObject({ leased: 0, deferred: 0, unusable: 0 })
  })

  it('⛔ 使用者正在輪詢的那份不碰（搶了就是同一段切兩次、收兩次錢）', () => {
    const r = pickStaleJobs(
      [
        { id: 'watching', workspaceId: 'w1', leaseUntil: NOW + 60_000 },
        { id: 'idle', workspaceId: 'w1' },
      ],
      NOW,
      5,
    )
    expect(r.stale).toEqual([{ jobId: 'idle', workspaceId: 'w1' }])
    expect(r.leased).toBe(1)
  })

  it('超過本輪上限的份數要算進 deferred（不可以靜靜消失）', () => {
    const jobs = ['a', 'b', 'c', 'd'].map(id => ({ id, workspaceId: 'w1' }))
    const r = pickStaleJobs(jobs, NOW, 2)
    expect(r.stale.map(s => s.jobId)).toEqual(['a', 'b'])
    expect(r.deferred).toBe(2)
  })

  /**
   * ⛔ 上限要用 continue 不是 break：break 的話後面那幾份連「有沒有 workspaceId」
   *    都沒看過，unusable 會漏數、deferred 也會少算。
   */
  it('上限之後的份數仍要逐一分類（壞資料不會被上限藏起來）', () => {
    const r = pickStaleJobs(
      [
        { id: 'a', workspaceId: 'w1' },
        { id: 'b', workspaceId: 'w1' },
        // ⚠️ 壞的那份**刻意排在上限之後**：排在前面的話，break 與 continue 的結果一樣，
        //    這條測試就守不到它想守的東西（第一版就是這樣寫的，破壞性驗證時沒紅才發現）。
        { id: 'c', workspaceId: 'w1' },
        { id: 'broken', workspaceId: undefined },
      ],
      NOW,
      2,
    )
    expect(r.stale.map(s => s.jobId)).toEqual(['a', 'b'])
    expect(r.unusable).toBe(1)
    expect(r.deferred).toBe(1)
  })

  it('沒有工作要推時，三個計數都是 0（跟「追不上」長得不一樣）', () => {
    expect(pickStaleJobs([], NOW, 2)).toEqual({ stale: [], leased: 0, deferred: 0, unusable: 0 })
  })
})
