import { describe, expect, it, vi } from 'vitest'
import { findAcrossPages } from './find-across-pages'

/**
 * `C-237`：這一組存在的理由是**實機守門員驗不到這段**。
 * 正式庫那五個集合每一個都不到 30 筆（一頁就載完），所以「一直往下翻」那個迴圈
 * 在真後台上**一次都沒被執行過**——只靠實機驗就是假綠燈。
 */

/** 假清單：每頁 pageSize 筆，`loadMore` 才會把下一頁併進來 */
function makeList(total: number, pageSize = 30) {
  const all = Array.from({ length: total }, (_, i) => ({ id: `id-${i}`, name: `第 ${i} 筆` }))
  let loaded = Math.min(pageSize, total)
  return {
    all,
    peek: () => all.slice(0, loaded),
    hasMore: () => loaded < total,
    loadMore: vi.fn(async () => { loaded = Math.min(loaded + pageSize, total) }),
    loadedCount: () => loaded,
  }
}

describe('findAcrossPages', () => {
  it('第一頁就有 → 不多翻任何一頁', async () => {
    const list = makeList(100)
    const res = await findAcrossPages({ ...list, match: i => i.id === 'id-5' })
    expect(res.status).toBe('found')
    expect(list.loadMore).not.toHaveBeenCalled()
  })

  it('⭐ 在第四頁 → 會一路翻到找到（正式庫資料太少，只有這裡驗得到）', async () => {
    const list = makeList(200)
    const res = await findAcrossPages({ ...list, match: i => i.id === 'id-95' })
    expect(res).toMatchObject({ status: 'found', item: { id: 'id-95' } })
    expect(list.loadMore).toHaveBeenCalledTimes(3) // 30 → 60 → 90 → 120
  })

  it('整份翻完都沒有 → absent（這時才可以說「可能被刪掉了」）', async () => {
    const list = makeList(75)
    const res = await findAcrossPages({ ...list, match: i => i.id === '不存在' })
    expect(res.status).toBe('absent')
    expect(list.loadedCount()).toBe(75)
  })

  it('⛔ 翻到上限還沒翻完 → gave-up，**不可以**變成 absent', async () => {
    const list = makeList(10_000)
    const res = await findAcrossPages({ ...list, match: i => i.id === '不存在', maxPages: 3 })
    expect(res).toMatchObject({ status: 'gave-up', pagesLoaded: 3, reason: 'max-pages' })
    // 這一行紅掉＝有人把上限拿掉了，一個打錯的 id 會把整個集合一頁一頁全抓下來
    expect(list.loadMore).toHaveBeenCalledTimes(3)
  })

  it('⛔ 說還有、載了卻沒變多 → gave-up，不可以無限轉下去', async () => {
    let calls = 0
    const res = await findAcrossPages({
      peek: () => [{ id: 'a' }],
      match: i => i.id === 'b',
      hasMore: () => true, // 後端一直說「還有」
      loadMore: async () => { calls += 1 }, // 但一筆都沒多
    })
    expect(res).toMatchObject({ status: 'gave-up', reason: 'no-progress' })
    expect(calls).toBe(1)
  })

  it('空清單也不會炸', async () => {
    const res = await findAcrossPages({
      peek: () => [] as { id: string }[],
      match: () => true,
      hasMore: () => false,
      loadMore: async () => {},
    })
    expect(res.status).toBe('absent')
  })
})
