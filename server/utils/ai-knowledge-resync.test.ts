import { describe, expect, it } from 'vitest'
import { applyCosmeticVerdicts, computeDiff, contentSimilarity, normalizeForCompare, pickCosmeticCandidates } from './ai-knowledge-resync'

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

// ═══════════════════════════════════════════════════════════════════
//  C-40 穩定鍵配對（第 0 輪：卡片內容裡的「連結：」網址）
//  病灶：募資首頁品項換檔期改名（「義比壓壓 義式自動…」→「義式半自動…」），
//  標題對不上、內容差異又過不了 0.6 → 判成「新增＋移除」→ 縮水保護把移除預設
//  改保留 → 同一台商品兩張卡越滾越多。連結是比標題穩得多的身分。
// ═══════════════════════════════════════════════════════════════════

describe('extractCardLink', () => {
  it('抽出唯一的連結行並正規化（去 query/hash、去尾斜線、host 小寫）', async () => {
    const { extractCardLink } = await import('./ai-knowledge-resync')
    expect(extractCardLink('重點：X\n\n說明文字。\n連結：https://WWW.Myfeel-tw.com/projects/BZ-CCM806/?utm=x#top'))
      .toBe('www.myfeel-tw.com/projects/BZ-CCM806')
  })
  it('沒有連結行、或不只一條 → null（多連結的卡身分不明，不能拿來配對）', async () => {
    const { extractCardLink } = await import('./ai-knowledge-resync')
    expect(extractCardLink('沒有連結的內容')).toBe(null)
    expect(extractCardLink('連結：https://a.com/x\n連結：https://a.com/y')).toBe(null)
    expect(extractCardLink('連結：不是網址')).toBe(null)
  })
})

describe('computeDiff 第 0 輪：連結穩定鍵', () => {
  it('品項改名＋文案重寫但連結相同 → 判「修改」，不是「新增＋移除」（C-40 的病）', () => {
    const olds = [oldChunk('c1',
      'Balzano 義比壓壓 義式自動雙膠囊3合1咖啡機',
      '重點：品牌：Balzano 百佳諾｜暱稱：義比壓壓\n\n這台咖啡機支援咖啡粉與兩種膠囊，早鳥價三千九，加贈奶泡器與濾杯組合，總集資已突破三百萬。\n連結：https://www.myfeel-tw.com/projects/BZ-CCM806',
    )]
    const news = [newChunk(
      'Balzano 義式半自動雙膠囊3合1咖啡機',
      '重點：品牌：Balzano\n\n義式半自動咖啡機，一台搞定咖啡粉與大小膠囊。\n連結：https://www.myfeel-tw.com/projects/BZ-CCM806',
    )]
    // 前提確認：標題不同、內容相似度過不了第二輪門檻——沒有第 0 輪就會變 add+remove
    expect(contentSimilarity(olds[0]!.content, news[0]!.content)).toBeLessThan(0.6)
    const r = computeDiff(olds, news)
    expect(r.summary).toEqual({ added: 0, modified: 1, removed: 0, unchanged: 0 })
  })

  it('同一產品頁多張卡共用連結 → 連結不唯一不配對，照走標題輪（不亂點鴛鴦）', () => {
    const link = '\n連結：https://www.myfeel-tw.com/projects/HD5225'
    const olds = [
      oldChunk('c1', '保固說明', `保固兩年。${link}`),
      oldChunk('c2', '運費說明', `滿千免運。${link}`),
    ]
    const news = [
      newChunk('保固說明', `保固兩年。${link}`),
      newChunk('運費說明', `滿千免運。${link}`),
    ]
    const r = computeDiff(olds, news)
    // 標題輪照樣全配上：兩張都未變
    expect(r.summary).toEqual({ added: 0, modified: 0, removed: 0, unchanged: 2 })
  })
})

describe('countDivergentKeeps（C-44：保留了與網頁不同的內容才算）', () => {
  it('modified 保留/略過、removed 保留、new 略過 → 算；unchanged 保留、正常套用 → 不算', async () => {
    const { countDivergentKeeps } = await import('./ai-knowledge-resync')
    const entries = [
      { id: 'mod:1', kind: 'modified' as const },
      { id: 'same:2', kind: 'unchanged' as const },
      { id: 'rem:3', kind: 'removed' as const },
      { id: 'new:4', kind: 'new' as const },
      { id: 'mod:5', kind: 'modified' as const },
    ]
    expect(countDivergentKeeps(entries, {
      'mod:1': 'keep_old', // 算
      'same:2': 'keep_old', // 不算（本來就一樣）
      'rem:3': 'keep_old', // 算
      'new:4': 'skip', // 算
      'mod:5': 'use_new', // 不算（照網頁套了）
    })).toBe(3)
    expect(countDivergentKeeps(entries, {
      'mod:1': 'use_new',
      'same:2': 'keep_old',
      'rem:3': 'delete_old',
      'new:4': 'add_new',
      'mod:5': 'use_new',
    })).toBe(0)
    // 沒帶決定 → 套用端視同保留 → 照算
    expect(countDivergentKeeps([{ id: 'mod:9', kind: 'modified' as const }], {})).toBe(1)
  })
})

/**
 * `C-144`：措辭差異的意思判官（案例取自 2026-09-04 BOYA FAQ resync 的真實 diff——
 * 8 條 modified 全是措辭差異，字面相似度 0.53～0.94＝字串門檻判不動，只能 LLM 判意思、
 * 數字紅線用程式守）。
 */
describe('pickCosmeticCandidates / applyCosmeticVerdicts（C-144）', () => {
  const mkDiff = (entries: any[]): any => ({ entries, summary: { added: 0, modified: entries.length, removed: 0, unchanged: 0 } })
  const mod = (id: string, numbersChanged: boolean): any => ({
    id, kind: 'modified', defaultAction: 'use_new', numbersChanged,
    oldChunk: { id, title: 't', content: '舊', tags: [], manuallyEdited: false },
    newChunk: { title: 't', content: '新', tags: [], questions: [] },
  })

  it('🔴 數字有變的一律不送判（那是真變動，判官說什麼都不算數）', () => {
    const diff = mkDiff([mod('a', false), mod('b', true), mod('c', false)])
    const candidates = pickCosmeticCandidates(diff)
    expect(candidates.map((e: any) => e.id)).toEqual(['a', 'c'])
  })

  it('判官說 same_meaning → 摺疊＋預設保留原卡；unsure / changed 保持原樣', () => {
    const diff = mkDiff([mod('a', false), mod('b', false), mod('c', false)])
    const candidates = pickCosmeticCandidates(diff)
    const { folded } = applyCosmeticVerdicts(diff, candidates, ['same_meaning', 'unsure', 'changed'])
    expect(folded).toBe(1)
    expect(diff.entries[0]).toMatchObject({ cosmetic: true, defaultAction: 'keep_old' })
    expect(diff.entries[1].cosmetic).toBeUndefined()
    expect(diff.entries[1].defaultAction).toBe('use_new')
    expect(diff.entries[2].cosmetic).toBeUndefined()
  })

  it('🔴 保險：就算呼叫端送錯候選，數字有變的也不准摺', () => {
    const diff = mkDiff([mod('a', true)])
    const { folded } = applyCosmeticVerdicts(diff, diff.entries, ['same_meaning'])
    expect(folded).toBe(0)
    expect(diff.entries[0].cosmetic).toBeUndefined()
  })

  it('unchanged / new / removed 不是候選（只有 modified 需要判意思）', () => {
    const diff = mkDiff([
      { id: 'x', kind: 'unchanged', defaultAction: 'keep_old' },
      { id: 'y', kind: 'new', defaultAction: 'add_new' },
      mod('z', false),
    ])
    expect(pickCosmeticCandidates(diff).map((e: any) => e.id)).toEqual(['z'])
  })
})
