import { describe, expect, it } from 'vitest'
import { FOREGROUND_QUIET_MS, MAX_BACKGROUND_AGE_MS, pickStaleJobs } from './ai-preview-job-runner'

/**
 * 排程接手推進匯入工作（`D-50` 簡化 3）的挑選規則。
 *
 * 為什麼這支特別要測：**不推**有五種理由，在紀錄上必須分得出來——
 * 有人在看（正常）／做完沒人收（不該花錢）／太舊（讓清理程式收掉）／
 * 排程追不上（要加量）／資料壞了（要有人去查）。
 * 併成一個「跳過 N 份」的話，排程其實完全沒在動也看不出來（本專案的沉默死亡已發生三次）。
 */
describe('pickStaleJobs', () => {
  const NOW = 1_700_000_000_000
  /** 一份「該推」的工作：開了背景推進、前景很久沒動、還不算舊 */
  const eligible = (id: string, over: Partial<Parameters<typeof pickStaleJobs>[0][number]> = {}) => ({
    id,
    workspaceId: 'w1',
    leaseUntil: 0,
    backgroundAdvance: true,
    updatedAtMs: NOW - 5 * 60_000,
    createdAtMs: NOW - 10 * 60_000,
    ...over,
  })

  it('該推的就推，並回報份數', () => {
    const r = pickStaleJobs([eligible('a'), eligible('b')], NOW, 5)
    expect(r.stale).toEqual([
      { jobId: 'a', workspaceId: 'w1' },
      { jobId: 'b', workspaceId: 'w1' },
    ])
    expect(r).toMatchObject({ leased: 0, deferred: 0, unusable: 0, notEligible: 0, tooOld: 0 })
  })

  it('⛔ 使用者正在輪詢的那份不碰（搶了就是同一段切兩次、收兩次錢）', () => {
    const r = pickStaleJobs(
      [eligible('watching', { leaseUntil: NOW + 60_000 }), eligible('idle')],
      NOW,
      5,
    )
    expect(r.stale).toEqual([{ jobId: 'idle', workspaceId: 'w1' }])
    expect(r.leased).toBe(1)
  })

  /**
   * ⛔ 這條是「別只看租約」的守門測試。前景每推完一步就把 leaseUntil 寫回 0，
   * 前端要等 1.2 秒才發下一次輪詢——只看租約的話，落在那個空檔的排程會把
   * 「使用者正盯著看的那份」當成沒人管，leased 統計也會說謊。
   */
  it('租約是 0 但前景剛剛才寫入過 → 仍算「有人在看」', () => {
    const r = pickStaleJobs(
      [eligible('just-polled', { leaseUntil: 0, updatedAtMs: NOW - (FOREGROUND_QUIET_MS - 1000) })],
      NOW,
      5,
    )
    expect(r.stale).toEqual([])
    expect(r.leased).toBe(1)
  })

  /**
   * ⛔ 做完沒有人收的工作不可以推：整站匯入的每一頁與重新同步都是這種，
   * 推完等於付了完整的 OCR／AI 費用再把結果丟掉。
   */
  it('沒開背景推進的（整站每頁／重新同步）算 notEligible，不碰', () => {
    const r = pickStaleJobs(
      [eligible('single'), eligible('site-page', { backgroundAdvance: false })],
      NOW,
      5,
    )
    expect(r.stale).toEqual([{ jobId: 'single', workspaceId: 'w1' }])
    expect(r.notEligible).toBe(1)
  })

  /**
   * ⛔ 年齡上限不可以拿掉：清理程式看到「processing 且 30 分鐘內有寫入」就會延命一小時，
   * 而排程每推一步都會寫入——沒有這道上限，被放棄的工作會被一直推、一直延命，永不過期。
   */
  it('太舊的不再推（讓清理程式收掉）', () => {
    const r = pickStaleJobs(
      [eligible('old', { createdAtMs: NOW - MAX_BACKGROUND_AGE_MS - 1000 })],
      NOW,
      5,
    )
    expect(r.stale).toEqual([])
    expect(r.tooOld).toBe(1)
  })

  it('最久沒被推的先推（不然每輪都挑到同樣那幾份，其餘永遠排不到）', () => {
    const r = pickStaleJobs(
      [
        eligible('fresh', { updatedAtMs: NOW - 60_000 }),
        eligible('stalest', { updatedAtMs: NOW - 30 * 60_000 }),
        eligible('middle', { updatedAtMs: NOW - 10 * 60_000 }),
      ],
      NOW,
      2,
    )
    expect(r.stale.map(s => s.jobId)).toEqual(['stalest', 'middle'])
    expect(r.deferred).toBe(1)
  })

  it('超過本輪上限的份數要算進 deferred（不可以靜靜消失）', () => {
    const jobs = ['a', 'b', 'c', 'd'].map(id => eligible(id))
    const r = pickStaleJobs(jobs, NOW, 2)
    expect(r.stale.length).toBe(2)
    expect(r.deferred).toBe(2)
  })

  /**
   * ⛔ 上限要用 continue 不是 break：break 的話後面那幾份連分類都沒看過，
   *    deferred 會少算。壞資料**刻意排在上限之後**——排在前面的話兩種寫法結果相同，
   *    這條測試就守不到它想守的東西（第一版就是這樣寫的，破壞性驗證時沒紅才發現）。
   */
  it('上限之後的份數仍要逐一分類（壞資料不會被上限藏起來）', () => {
    const r = pickStaleJobs(
      [
        eligible('a', { updatedAtMs: NOW - 40 * 60_000 }),
        eligible('b', { updatedAtMs: NOW - 30 * 60_000 }),
        eligible('c', { updatedAtMs: NOW - 20 * 60_000 }),
        { id: 'broken', workspaceId: undefined, backgroundAdvance: true },
      ],
      NOW,
      2,
    )
    expect(r.stale.map(s => s.jobId)).toEqual(['a', 'b'])
    expect(r.unusable).toBe(1)
    expect(r.deferred).toBe(1)
  })

  it('沒有工作要推時，所有計數都是 0（跟「追不上」長得不一樣）', () => {
    expect(pickStaleJobs([], NOW, 2)).toEqual({
      stale: [], leased: 0, deferred: 0, unusable: 0, notEligible: 0, tooOld: 0,
    })
  })
})
