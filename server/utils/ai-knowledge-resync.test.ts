import { describe, expect, it } from 'vitest'
import { computeDiff, contentSimilarity, normalizeForCompare } from './ai-knowledge-resync'

const oldChunk = (id: string, title: string, content: string, manual = false) => ({
  id,
  title,
  content,
  tags: [] as string[],
  manuallyEditedAtMs: manual ? 1 : 0,
})
const newChunk = (title: string, content: string) => ({ title, content, tags: [] as string[] })

describe('contentSimilarity', () => {
  it('相同內容 = 1，完全不同 ≈ 0', () => {
    expect(contentSimilarity('滿千免運，離島另計', '滿千免運，離島另計')).toBe(1)
    expect(contentSimilarity('滿千免運，離島另計', 'abcdefg')).toBe(0)
  })

  it('小幅改寫仍維持高相似度', () => {
    const a = '本店滿一千元即享免運優惠，離島地區運費另外計算，預購商品出貨後約三到五個工作天送達。'
    const b = '本店滿一千元即享免運優惠，離島地區運費另計，預購商品出貨後約五到七個工作天送達。'
    expect(contentSimilarity(a, b)).toBeGreaterThan(0.6)
  })
})

describe('normalizeForCompare', () => {
  it('全半形標點與空白不算差異', () => {
    expect(normalizeForCompare('重點：溫控｜範圍：50 到 99 度'))
      .toBe(normalizeForCompare('重點:溫控|範圍:50到99度'))
    expect(normalizeForCompare('特製濾杯、精準量匙')).toBe(normalizeForCompare('特製濾杯，精準量匙'))
  })

  it('數字改了仍然是不同內容（不能把改價默默吃掉）', () => {
    expect(normalizeForCompare('範圍：50 到 99 度')).not.toBe(normalizeForCompare('範圍：50 到 95 度'))
  })
})

describe('computeDiff 只有排版差異 → unchanged', () => {
  it('全形冒號 / 空白位置不同不算「修改」', () => {
    const { summary } = computeDiff(
      [oldChunk('c1', '運費說明', '重點：門檻：滿 1000 元｜離島：另計\n滿千免運。')],
      [newChunk('運費說明', '重點:門檻:滿1000元|離島:另計\n滿千免運。')],
    )
    expect(summary).toEqual({ added: 0, modified: 0, removed: 0, unchanged: 1 })
  })

  it('標題的標點不同也要配得上（不能變成 removed + new）', () => {
    const content = '本店滿一千元即享免運優惠，離島地區運費另外計算。'
    const { summary } = computeDiff(
      [oldChunk('c1', '運費說明：離島', content)],
      [newChunk('運費說明:離島', content)],
    )
    expect(summary).toEqual({ added: 0, modified: 0, removed: 0, unchanged: 1 })
  })

  it('第二輪配到的卡若內容其實一樣，只報標題變動而不是憑空生出修改內容', () => {
    const content = '本店滿一千元即享免運優惠，離島地區運費另外計算，預購商品約三到五天送達。'
    const { entries, summary } = computeDiff(
      [oldChunk('c1', '運費說明', content)],
      [newChunk('運費與配送說明', content)],
    )
    expect(summary).toEqual({ added: 0, modified: 1, removed: 0, unchanged: 0 })
    expect(entries[0]!.titleChanged).toBe(true)
    expect(entries[0]!.numbersChanged).toBe(false)
  })
})

describe('computeDiff 數字變動標記', () => {
  it('規格數字改了 → numbersChanged + 列出舊新數字', () => {
    const { entries, summary } = computeDiff(
      [oldChunk('c1', '溫控', '可以在 50 到 99 度之間精準設定水溫，避免焦苦。')],
      [newChunk('溫控', '可以在 50 到 95 度之間精準設定水溫，避免焦苦。')],
    )
    expect(summary.modified).toBe(1)
    expect(entries[0]!.numbersChanged).toBe(true)
    expect(entries[0]!.numberChanges).toEqual({ removed: ['99'], added: ['95'] })
    expect(entries[0]!.defaultAction).toBe('use_new') // 網頁才是事實來源，不替使用者默默保留舊版
  })

  it('純換句話說（數字沒動）→ numbersChanged=false', () => {
    const { entries } = computeDiff(
      [oldChunk('c1', '配件', '隨機附贈特製濾杯、精準量匙，讓您開箱後立即開始沖煮，享受專業且到位的儀式感。')],
      [newChunk('配件', '隨機附贈特製濾杯、精準量匙，讓使用者開箱後立即開始沖煮咖啡，享受專業級的手沖體驗。')],
    )
    expect(entries[0]!.kind).toBe('modified')
    expect(entries[0]!.numbersChanged).toBe(false)
    expect(entries[0]!.numberChanges).toBeUndefined()
  })

  it('千分位與全形數字視為同一個數字（不誤報改價）', () => {
    const { entries } = computeDiff(
      [oldChunk('c1', '運費', '滿 1,000 元免運，離島另計。')],
      [newChunk('運費', '滿 １０００ 元免運，離島另外計算。')],
    )
    expect(entries[0]!.kind).toBe('modified') // 文字確實改了（另計 → 另外計算）
    expect(entries[0]!.numbersChanged).toBe(false) // 但價格沒變
  })
})

describe('computeDiff 第二輪配對', () => {
  it('title 微調但內容幾乎相同 → modified 而非 removed+new', () => {
    const content = '本店滿一千元即享免運優惠，離島地區運費另外計算，預購商品約三到五天送達。'
    const { entries, summary } = computeDiff(
      [oldChunk('c1', '運費說明', content)],
      [newChunk('運費與配送說明', `${content}超商取貨另有折扣。`)],
    )
    expect(summary).toEqual({ added: 0, modified: 1, removed: 0, unchanged: 0 })
    expect(entries[0]!.kind).toBe('modified')
    expect(entries[0]!.oldChunk!.id).toBe('c1')
    expect(entries[0]!.newChunk!.title).toBe('運費與配送說明')
  })

  it('內容真的不同 → 維持 removed + new', () => {
    const { summary } = computeDiff(
      [oldChunk('c1', '運費說明', '滿千免運，離島另計，約三到五天送達。')],
      [newChunk('退換貨政策', '七天鑑賞期內可退換，需保持包裝完整，客製化商品不適用。')],
    )
    expect(summary).toEqual({ added: 1, modified: 0, removed: 1, unchanged: 0 })
  })

  it('title 完全相同仍走第一輪（unchanged / modified）', () => {
    const { summary } = computeDiff(
      [oldChunk('c1', '運費說明', '滿千免運。'), oldChunk('c2', '退換貨', '七天鑑賞期。')],
      [newChunk('運費說明', '滿千免運。'), newChunk('退換貨', '七天鑑賞期，客製品除外。')],
    )
    expect(summary).toEqual({ added: 0, modified: 1, removed: 0, unchanged: 1 })
  })

  it('手動編輯過的舊卡不參與第二輪 → 保守地出 removed(keep_old) + new(add_new)', () => {
    const content = '本店滿一千元即享免運優惠，離島地區運費另外計算，預購商品約三到五天送達。'
    const { entries, summary } = computeDiff(
      [oldChunk('c1', '運費說明', content, /* manual */ true)],
      [newChunk('運費與配送', content)],
    )
    expect(summary).toEqual({ added: 1, modified: 0, removed: 1, unchanged: 0 })
    const removed = entries.find(e => e.kind === 'removed')!
    expect(removed.defaultAction).toBe('keep_old')
    const added = entries.find(e => e.kind === 'new')!
    expect(added.defaultAction).toBe('add_new')
  })
})
