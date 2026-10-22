import { describe, expect, it } from 'vitest'
import { diffPageLines } from '~~/shared/page-line-diff'
import { COSMETIC_JUDGE_SYSTEM, applyCosmeticVerdicts, computeDiff, contentSimilarity, contentStillOnPage, countDivergentKeeps, gateDiffByPageChanges, markRemovedStillOnPage, normalizeForCompare, pickCosmeticCandidates } from './ai-knowledge-resync'

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

describe('C-367：型號不拆成數字、提幾次不算、網址裡的不算', () => {
  const changesOf = (oldC: string, newC: string) => {
    const { entries } = computeDiff([oldChunk('c1', '卡', oldC)], [newChunk('卡', newC)])
    return { changed: entries[0]!.numbersChanged, changes: entries[0]!.numberChanges }
  }

  // 2026-10-21 MYFEEL 首頁那次重新同步的三條原文（只換句話說，卻被標「數字有變」）
  it('吸塵器：型號寫兩次變一次＝沒變（舊版報「少了 9、9」）', () => {
    expect(changesOf(
      '重點：品牌：SHARP｜特色：靜音、無線｜型號：EC-SR9TW-W、EC-SR9TW-B｜類型：吸塵器\n\nSHARP靜音無線吸塵器，型號有EC-SR9TW-W和EC-SR9TW-B，主打靜音和無線設計。\n連結：https://www.myfeel-tw.com/projects/EC-SR9TW',
      '重點：品牌：SHARP｜型號：EC-SR9TW-W/EC-SR9TW-B｜特色：靜音、無線\n\nSHARP「噓塵器」靜音無線吸塵器提供白色和黑色兩種選擇。\n連結：https://www.myfeel-tw.com/projects/EC-SR9TW',
    ).changed).toBe(false)
  })
  it('空氣清淨機：型號後面直接接中文也整串認（舊版報「少了 201、0」）', () => {
    expect(changesOf(
      '重點：品牌：LG｜功能：空氣清淨、藍牙音響、無線充電｜型號：AS201SHU0\nLG小蘑菇AeroSpeaker空氣清淨機，型號為AS201SHU0，結合了潔淨空氣、藍牙音響和無線充電三種功能。\n連結：https://www.myfeel-tw.com/projects/aerospeaker',
      '重點：品牌：LG｜型號：AS201SHU0｜特色：潔淨空氣、藍牙音響、無線充電、小蘑菇造型\n\nLG「小蘑菇」AeroSpeaker空氣清淨機結合了潔淨空氣、藍牙音響和無線充電功能。\n連結：https://www.myfeel-tw.com/projects/aerospeaker',
    ).changed).toBe(false)
  })
  it('顯微鏡：網址裡本來就有的型號，新版多寫一次不算（舊版報「多了 3、01」）', () => {
    expect(changesOf(
      '重點：品牌：Anyty｜特色：攜帶式、數位｜功能：探索微觀世界\nAnyty攜帶式數位顯微鏡，讓使用者能用『魔法放大鏡』共同探索微觀世界的樂趣。\n連結：https://www.myfeel-tw.com/projects/3R-MJL01',
      '重點：品牌：Anyty｜型號：3R-MJL01｜特色：攜帶式、數位顯微鏡\n\nAnyty攜帶式數位顯微鏡，又稱「魔法放大鏡」，可用於探索微觀世界。\n連結：https://www.myfeel-tw.com/projects/3R-MJL01',
    ).changed).toBe(false)
  })

  // 真的改了的照樣要抓到（拿掉型號規則、改成全部只看有沒有，這幾條就會漏）
  it.each([
    ['容量 6L', '容量 12L', ['6'], ['12']],
    ['售價 1,000 元', '售價 1,200 元', ['1000'], ['1200']],
    ['A 方案 500 元、B 方案 800 元、C 方案 800 元', 'A 方案 500 元、B 方案 500 元、C 方案 800 元', ['800'], ['500']],
    ['濾網型號 FZ-F30HFE', '濾網型號 FZ-F50HFE', ['FZ-F30HFE'], ['FZ-F50HFE']],
    ['適用 HD5225', '適用 HD7000', ['HD5225'], ['HD7000']],
    ['保固 1 年、7 天鑑賞期', '保固 2 年、7 天鑑賞期', ['1'], ['2']],
    ['３ 天內出貨', '5 天內出貨', ['3'], ['5']],
  ])('%s → %s 照樣標數字有變', (o, n, removed, added) => {
    expect(changesOf(o, n)).toEqual({ changed: true, changes: { removed, added } })
  })

  it('網址裡的數字不算（網址另外靠連結配對）', () => {
    expect(changesOf(
      '保固一年。\n連結：https://example.com/p/2024',
      '保固一年，售後找客服。\n連結：https://example.com/p/2025',
    ).changed).toBe(false)
  })

  it('⚠️ 刻意留著的：同一個數字講兩次改成一次，還是算數字有變', () => {
    // 要解就得改成「數字也只看有沒有」，那 B 方案 800 改 500 那條就會漏掉
    expect(changesOf('保固 1 年，保固期 1 年內免費維修', '保固 1 年內免費維修').changed).toBe(true)
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
    const { folded } = applyCosmeticVerdicts(candidates, ['same_meaning', 'unsure', 'changed'])
    expect(folded).toBe(1)
    expect(diff.entries[0]).toMatchObject({ cosmetic: true, defaultAction: 'keep_old' })
    expect(diff.entries[1].cosmetic).toBeUndefined()
    expect(diff.entries[1].defaultAction).toBe('use_new')
    expect(diff.entries[2].cosmetic).toBeUndefined()
  })

  it('🔴 保險：就算呼叫端送錯候選，數字有變的也不准摺', () => {
    const diff = mkDiff([mod('a', true)])
    const { folded } = applyCosmeticVerdicts(diff.entries, ['same_meaning'])
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

/**
 * `C-146`：`C-144` 的意思判官引入的三個回歸（2026-09-04 code review，三個獨立角度都指到第一條）。
 *
 * 共同的病根：「意思沒變、保留原卡」被下游當成「使用者刻意保留了與網頁不同的內容」。
 */
describe('C-146：意思判官的三個回歸', () => {
  const mkModified = (id: string, extra: Record<string, unknown> = {}): any => ({
    id, kind: 'modified', defaultAction: 'use_new', numbersChanged: false, titleChanged: false,
    oldChunk: { id, title: 't', content: '舊', tags: [], manuallyEdited: false },
    newChunk: { title: 't', content: '新', tags: [], questions: [] },
    ...extra,
  })

  it('🔴 摺疊掉的「換句話說」不算「保留了與網頁不同的內容」——算了就永遠推不進指紋', () => {
    // 這正是 C-144 的動機案例：BOYA FAQ 8 條 modified 全是措辭差異。
    // 舊行為＝8 條都算 divergent → fingerprintSafe=false → contentHash 不推進
    // → 排程下一輪又標「有變動」→ 每次重新同步再燒一次完整重切＋判官，永遠到不了「已是最新」。
    const entries = Array.from({ length: 8 }, (_, i) => mkModified(`m${i}`, { cosmetic: true, defaultAction: 'keep_old' }))
    const decisions = Object.fromEntries(entries.map(e => [e.id, 'keep_old']))
    const exempt = new Set(entries.map(e => e.id)) // 伺服器自己算出來的那份
    expect(countDivergentKeeps(entries, decisions, exempt)).toBe(0)
  })

  it('沒被判成措辭差異的 modified 保留原卡，照樣要算（C-44 的原意不能被弄丟）', () => {
    const entries = [mkModified('a'), mkModified('b', { cosmetic: true, defaultAction: 'keep_old' })]
    expect(countDivergentKeeps(entries, { a: 'keep_old', b: 'keep_old' }, new Set(['b']))).toBe(1)
  })

  /**
   * ⚠️ 這條原本守的是「標題變了就不送判」（`C-146` 的守門②）。
   * `C-155` 把**標題也送進判官**之後那道守門刪掉了——刪掉才對：重切本來就常順手改標題
   *（「運費說明」→「運費與配送說明」），排除掉等於把這個功能自己的主場關在門外。
   * 型號那一關改由 prompt 規則 3 ＋ 數字紅線把守，所以這條改成守「標題有真的被送進去」。
   */
  it('🔴 標題一定要送進判官（型號住在標題裡，看不到標題就會把型號修正判成「意思一樣」）', () => {
    const diff: any = {
      entries: [mkModified('title-changed', { titleChanged: true })],
      summary: { added: 0, modified: 1, removed: 0, unchanged: 0 },
    }
    // 標題變了的照樣是候選（不再被排除）
    expect(pickCosmeticCandidates(diff).map((e: any) => e.id)).toEqual(['title-changed'])
    // 而 prompt 裡必須有「標題型號不同一律 changed」這條規則
    expect(COSMETIC_JUDGE_SYSTEM).toContain('標題裡的型號')
    expect(COSMETIC_JUDGE_SYSTEM).toContain('6L vs 12L')
  })

  it('🔴 內容長到會被截斷的不可以送判——判官看不到後半段，卻會回「意思一樣」', () => {
    // 兩份內容前 800 字一模一樣、差異在第 900 字（例如網頁後面補了一句條件）：
    // 判官收到的兩段完全相同 → same_meaning → 真的新增內容被摺疊藏起來。
    const long = 'x'.repeat(900)
    const diff: any = {
      entries: [
        mkModified('too-long', {
          oldChunk: { id: 'too-long', title: 't', content: long, tags: [], manuallyEdited: false },
          newChunk: { title: 't', content: `${long}（新增：本活動九月結束）`, tags: [], questions: [] },
        }),
        mkModified('short'),
      ],
      summary: { added: 0, modified: 2, removed: 0, unchanged: 0 },
    }
    expect(pickCosmeticCandidates(diff).map((e: any) => e.id)).toEqual(['short'])
  })
})


/**
 * `C-153`：可豁免項目只認伺服器自己存的那份。
 * 以前直接讀 body 上的 `cosmetic`，等於把「永久推進指紋」的決定權交給瀏覽器——
 * 而指紋一推進，這次保留的差異就再也沒有人看得到（正是 C-44 註解明令禁止的後果）。
 */
describe('countDivergentKeeps 只信伺服器端的豁免清單（C-153）', () => {
  const mod = (id: string, extra: Record<string, unknown> = {}): any => ({
    id, kind: 'modified', defaultAction: 'keep_old', numbersChanged: false, titleChanged: false, ...extra,
  })

  it('🔴 body 上標了 cosmetic，但伺服器沒認可 → 照算（不可以被前端騙走指紋）', () => {
    const entries = [mod('a', { cosmetic: true }), mod('b', { cosmetic: true })]
    const decisions = { a: 'keep_old', b: 'keep_old' }
    // 不傳豁免清單＝伺服器沒有認可任何一項
    expect(countDivergentKeeps(entries, decisions)).toBe(2)
    // 只認可 a
    expect(countDivergentKeeps(entries, decisions, new Set(['a']))).toBe(1)
  })

  it('伺服器認可、使用者也維持預設保留 → 豁免（迴圈才不會回來）', () => {
    const entries = [mod('a'), mod('b')]
    expect(countDivergentKeeps(entries, { a: 'keep_old', b: 'keep_old' }, new Set(['a', 'b']))).toBe(0)
  })

  it('伺服器認可，但使用者自己改成用新版 → 本來就不算 divergent', () => {
    const entries = [mod('a')]
    expect(countDivergentKeeps(entries, { a: 'use_new' }, new Set(['a']))).toBe(0)
  })
})

/**
 * `C-154`：「移除」其實只是換了分法——確定性檢查（零 LLM）。
 * 案例取自 2026-09-04 BOYA FAQ 那次：diff report 移除 18／新增 1／修改 8，
 * 而「樂器收音」那兩張舊卡的內容**明明還在網頁上**，只因這次重切合併成一塊而沒對上。
 */
describe('contentStillOnPage / markRemovedStillOnPage（C-154）', () => {
  const PAGE = [
    'BOYA mini2 常見問題',
    'Q：可以用來收樂器的聲音嗎？',
    'A：可以。BOYA mini2 支援樂器收音，建議搭配防風毛套並將增益調低，避免破音。',
    'Q：保固多久？',
    'A：在 MYFEEL 集資期間下單可享 2 年保固，無需特別登錄保固資訊。',
  ].join('\n')

  it('🔴 舊卡內容還在網頁上 → 認得出來（這是雜訊的大宗）', () => {
    const card = '重點：樂器收音\n\nBOYA mini2 支援樂器收音，建議搭配防風毛套並將增益調低，避免破音。'
    expect(contentStillOnPage(card, PAGE)).toBe(true)
  })

  it('排版差異不影響（全形標點、空白都正規化過）', () => {
    const card = 'BOYA mini2 支援樂器收音 ， 建議搭配防風毛套並將增益調低 ，避免破音。'
    expect(contentStillOnPage(card, PAGE)).toBe(true)
  })

  it('🔴 網頁上真的沒有了 → 不可以摺疊（那是真的被刪掉）', () => {
    const card = '重點：舊活動\n\n本次早鳥優惠已於六月底結束，恕不接受補登記或事後折抵。'
    expect(contentStillOnPage(card, PAGE)).toBe(false)
  })

  it('⛔ 內容太短抓不到夠長的片段 → 回 false（短句在長網頁裡必然命中，回 true 會把真刪除藏起來）', () => {
    expect(contentStillOnPage('可以。', PAGE)).toBe(false)
    expect(contentStillOnPage('', PAGE)).toBe(false)
  })

  it('標記時：手動編輯過的不摺疊（人特別在意那幾張）', () => {
    const mkRemoved = (id: string, content: string, manuallyEdited: boolean): any => ({
      id, kind: 'removed', defaultAction: 'delete_old',
      oldChunk: { id, title: 't', content, tags: [], manuallyEdited },
    })
    const kept = 'BOYA mini2 支援樂器收音，建議搭配防風毛套並將增益調低，避免破音。'
    const diff: any = {
      entries: [mkRemoved('auto', kept, false), mkRemoved('manual', kept, true)],
      summary: { added: 0, modified: 0, removed: 2, unchanged: 0 },
    }
    expect(markRemovedStillOnPage(diff, PAGE).marked).toBe(1)
    expect(diff.entries[0]).toMatchObject({ stillOnPage: true, defaultAction: 'keep_old' })
    expect(diff.entries[1].stillOnPage).toBeUndefined()
    expect(diff.entries[1].defaultAction).toBe('delete_old')
  })

  it('⛔ 網頁全文抓不到（空字串）→ 一筆都不摺疊，不可以當成「全都還在」', () => {
    const diff: any = {
      entries: [{ id: 'a', kind: 'removed', defaultAction: 'delete_old', oldChunk: { id: 'a', title: 't', content: 'BOYA mini2 支援樂器收音，建議搭配防風毛套並將增益調低。', tags: [], manuallyEdited: false } }],
      summary: { added: 0, modified: 0, removed: 1, unchanged: 0 },
    }
    expect(markRemovedStillOnPage(diff, '   ').marked).toBe(0)
    expect(diff.entries[0].stillOnPage).toBeUndefined()
  })
})

/**
 * `C-368`：只採用跟網頁改了的那幾行有關的變動。
 * 案例照 2026-10-21 MYFEEL 首頁那次：首頁換了一批主打（多 1 個商品、少 1 個），
 * AI 重寫整份之後，沒動的商品變成「修改」、頁尾多寫了一條——這兩種都要收起來。
 */
describe('gateDiffByPageChanges（C-368）', () => {
  const line = (name: string, slug: string) =>
    `${name} 人數達標解鎖更多獎勵！ NT$ 0 9,895,800 / 每月 9,896 % 10 天 即將上市 0 432 人支持 / 每月 10 天（https://www.myfeel-tw.com/projects/${slug}）`
  const FOOTER = '來瞭解\n關於我們（https://www.myfeel-tw.com/aboutUs）\n隱私權保護條款（https://www.myfeel-tw.com/privacy）'
  const card = (name: string, slug: string, body: string) =>
    `重點：品牌：${name}\n\n${body}\n連結：https://www.myfeel-tw.com/projects/${slug}`
  const BASE = [line('SHARP 靜音無線吸塵器 EC-SR9TW', 'EC-SR9TW'), line('DEAR.min 不落枕記憶枕', 'dearminpillow'), FOOTER].join('\n')
  const NOW = [line('SHARP 靜音無線吸塵器 EC-SR9TW', 'EC-SR9TW'), line('SHARP 乾淨方MAX 清淨除濕機', 'DW-UX22FT'), FOOTER].join('\n')

  const run = () => {
    const diff = computeDiff(
      [
        oldChunk('sharp', 'SHARP 靜音無線吸塵器', card('SHARP', 'EC-SR9TW', 'SHARP靜音無線吸塵器，主打靜音和無線設計。')),
        oldChunk('dear', 'DEAR.min 記憶枕', card('DEAR.min', 'dearminpillow', 'DEAR.min 不落枕零壓可調節深睡記憶枕。')),
      ],
      [
        newChunk('SHARP 靜音無線吸塵器 EC-SR9TW', card('SHARP', 'EC-SR9TW', 'SHARP「噓塵器」靜音無線吸塵器提供兩種顏色。')),
        newChunk('SHARP 乾淨方MAX 清淨除濕機', card('SHARP', 'DW-UX22FT', '這是 SHARP 的最新機種「乾淨方MAX」雙氣流智慧變頻美學清淨除濕機。')),
        newChunk('MYFEEL關於我們', '您可以透過「關於我們」頁面了解MYFEEL的相關資訊。\n連結：https://www.myfeel-tw.com/aboutUs'),
      ],
    )
    const gate = gateDiffByPageChanges(diff, diffPageLines(BASE, NOW, { ignoreNumbers: true }))
    const byTitle = (t: string) => diff.entries.find(e => (e.newChunk?.title ?? e.oldChunk?.title) === t)!
    return { diff, gate, byTitle }
  }

  it('網頁上沒動的商品：AI 換句話說的「修改」收起來、保留原本的', () => {
    const { byTitle } = run()
    expect(byTitle('SHARP 靜音無線吸塵器 EC-SR9TW')).toMatchObject({ kind: 'modified', pageUnchanged: true, defaultAction: 'keep_old' })
  })
  it('網頁多了的商品：照新增、不收', () => {
    const { byTitle } = run()
    const e = byTitle('SHARP 乾淨方MAX 清淨除濕機')
    expect(e.kind).toBe('new')
    expect(e.pageUnchanged).toBeUndefined()
    expect(e.defaultAction).toBe('add_new')
  })
  it('網頁少了的商品：照移除、不收', () => {
    const { byTitle } = run()
    const e = byTitle('DEAR.min 記憶枕')
    expect(e.kind).toBe('removed')
    expect(e.pageUnchanged).toBeUndefined()
    expect(e.defaultAction).toBe('delete_old')
  })
  it('頁尾沒動、AI 這次多寫的那條：略過', () => {
    const { byTitle } = run()
    expect(byTitle('MYFEEL關於我們')).toMatchObject({ kind: 'new', pageUnchanged: true, defaultAction: 'skip' })
  })
  it('改了的兩行都有人認領＝沒有對不到的', () => {
    const { gate } = run()
    expect(gate.uncertain).toBe(0)
    expect(gate.lines.map(l => [l.side, l.status])).toEqual([['removed', 'claimed'], ['added', 'claimed']])
    expect(gate.folded).toBe(2)
  })

  it('沒有連結的說明頁：改了的那一題用文字認，其他換句話說的收起來', () => {
    const base = 'Q：運費怎麼算？\nA：單筆訂單滿 1000 元免運，未滿酌收 100 元運費。\nQ：多久出貨？\nA：付款後三個工作天內出貨，假日不出貨。'
    const now = base.replace('滿 1000 元免運，未滿酌收 100 元', '滿 1500 元免運，未滿酌收 120 元')
    const diff = computeDiff(
      [
        oldChunk('ship', '運費', '重點：免運門檻：1000 元｜運費：100 元\n\n單筆訂單滿 1000 元免運，未滿酌收 100 元運費。'),
        oldChunk('when', '出貨時間', '付款後三個工作天內出貨，假日不出貨。'),
      ],
      [
        newChunk('運費', '重點：免運門檻：1500 元｜運費：120 元\n\n單筆訂單滿 1500 元免運，未滿酌收 120 元運費。'),
        newChunk('出貨時間', '付款完成後，我們會在三個工作天內出貨，假日不出貨喔。'),
      ],
    )
    const gate = gateDiffByPageChanges(diff, diffPageLines(base, now, { ignoreNumbers: false }))
    expect(diff.entries.find(e => e.oldChunk?.id === 'ship')).toMatchObject({ kind: 'modified', numbersChanged: true })
    expect(diff.entries.find(e => e.oldChunk?.id === 'ship')!.pageUnchanged).toBeUndefined()
    expect(diff.entries.find(e => e.oldChunk?.id === 'when')).toMatchObject({ kind: 'modified', pageUnchanged: true, defaultAction: 'keep_old' })
    expect(gate.uncertain).toBe(0)
  })

  it('⛔ 數字紅線：網頁行看不出（數字會跳的網址抹掉了數字），卡上數字變了照樣不收', () => {
    const diff = computeDiff(
      [oldChunk('p', '價格', '早鳥價 3990 元。')],
      [newChunk('價格', '早鳥價 4290 元。')],
    )
    gateDiffByPageChanges(diff, diffPageLines('早鳥價 3990 元', '早鳥價 4290 元', { ignoreNumbers: true }))
    expect(diff.entries[0]).toMatchObject({ kind: 'modified', numbersChanged: true })
    expect(diff.entries[0]!.pageUnchanged).toBeUndefined()
  })

  it('⛔ 改了的一行對不到任何知識、又跟某條沾到邊＝對不到，要問（不默默略過）', () => {
    const base = '本店提供七天鑑賞期，商品需保持完整包裝，退貨請先聯絡客服。'
    const now = '本店提供七天鑑賞期，拆封後的耳機類商品恕不退貨，退貨請先聯絡客服。'
    const diff = computeDiff(
      [oldChunk('ret', '退貨', '我們提供七天鑑賞期，退貨前請先聯絡客服。')],
      [newChunk('退貨', '我們提供七天鑑賞期，退貨前請先聯絡客服。')],
    )
    const gate = gateDiffByPageChanges(diff, diffPageLines(base, now, { ignoreNumbers: false }))
    expect(gate.uncertain).toBeGreaterThan(0)
  })

  // 2026-10-21 BOYA FAQ 真的請 AI 重新整理一次量到的兩件事
  it('FAQ 多一題：問句那一行短、跟內文重疊不夠，靠 AI 寫的問法認得出是同一題', () => {
    const base = 'Q：保固多久？\nA：集資期間下單享 2 年保固。'
    const now = `${base}\nQ：可以分期付款嗎？\nA：可以，結帳時選擇信用卡分期，支援 3 期 0 利率，單筆滿 3000 元才能分期。`
    const diff = computeDiff(
      [oldChunk('w', '保固', '集資期間下單享 2 年保固。')],
      [
        newChunk('保固', '集資期間下單享 2 年保固。'),
        { title: '平台分期付款', content: '重點：期數：3期0利率\n\n在平台結帳時可以選信用卡分期，支援3期0利率，單筆滿3000元可分期。', tags: [], questions: ['平台可以分期付款嗎？'] },
      ],
    )
    const gate = gateDiffByPageChanges(diff, diffPageLines(base, now, { ignoreNumbers: false }))
    expect(gate.uncertain).toBe(0)
    expect(gate.lines.map(l => l.status)).toEqual(['claimed', 'claimed'])
  })

  it('問句旁邊那一行對到了＝問句也算同一題（AI 沒寫問法時）', () => {
    const base = '付款方式'
    const now = `${base}\nQ：可以分期付款嗎？\nA：可以，結帳時選擇信用卡分期，支援 3 期 0 利率，單筆滿 3000 元才能分期。`
    // 問句跟這條知識沾到一點邊（可以／分期付款）、但不到六成——沒有「緊挨著答句」這條就會變成「對不到」
    const diff = computeDiff([], [newChunk('分期', '結帳時可以用信用卡分期付款，支援 3 期 0 利率，單筆滿 3000 元才能分期。')])
    const gate = gateDiffByPageChanges(diff, diffPageLines(base, now, { ignoreNumbers: false }))
    expect(gate.lines.map(l => l.status)).toEqual(['claimed', 'claimed'])
    expect(gate.uncertain).toBe(0)
  })

  it('⛔ 長的一段沾到邊卻沒人認領，不跟著旁邊那行算：照樣要問', () => {
    const base = '付款方式'
    const long = 'A：分期付款需於結帳時選擇合作銀行之信用卡，並依各銀行規定之期數與手續費計算，部分商品恕不適用分期。'
    const now = `${base}\n${long}\nQ：可以用 Apple Pay 嗎？`
    const diff = computeDiff([], [
      newChunk('Apple Pay', '可以用 Apple Pay 付款。'),
      // 跟那一段只重疊三成多：沾到邊、但不夠算是它
      newChunk('付款', '分期付款需於結帳時選擇信用卡，期數依銀行規定。'),
    ])
    const gate = gateDiffByPageChanges(diff, diffPageLines(base, now, { ignoreNumbers: false }))
    expect(gate.lines.find(l => l.display === long)!.status).toBe('uncertain')
  })

  it('數字不會跳的網址：網頁那一題沒改，AI 這次少寫一次型號／規格（「數字有變」）照樣收起來', () => {
    const page = 'Q：可以收樂器嗎？\nA：可以，BOYA mini2 支援 48kHz/24-bit 高解析錄音。\nQ：保固多久？\nA：享 2 年保固。'
    const diff = computeDiff(
      [oldChunk('m', '樂器收音', '重點：音質：48kHz\n\nBOYA mini2 支援 48kHz/24-bit 高解析錄音。'), oldChunk('w', '保固', '享 2 年保固。')],
      [newChunk('樂器收音', '支援48kHz/24-bit高解析錄音。'), newChunk('保固', '享 3 年保固。')],
    )
    gateDiffByPageChanges(diff, diffPageLines(page, page.replace('2 年', '3 年'), { ignoreNumbers: false }))
    expect(diff.entries.find(e => e.oldChunk?.id === 'm')).toMatchObject({ numbersChanged: true, pageUnchanged: true })
    expect(diff.entries.find(e => e.oldChunk?.id === 'w')!.pageUnchanged).toBeUndefined()
  })

  it('改了的一行從來沒人寫成知識（頁尾版權年份這種）＝可以安心略過', () => {
    const diff = computeDiff([oldChunk('a', '運費', '滿千免運。')], [newChunk('運費', '滿千免運。')])
    const gate = gateDiffByPageChanges(diff, diffPageLines('All rights reserved ⓒ MYFEEL Inc. 2025', 'All rights reserved ⓒ MYFEEL Inc. 2026', { ignoreNumbers: false }))
    expect(gate.lines.map(l => l.status)).toEqual(['uncovered', 'uncovered'])
    expect(gate.uncertain).toBe(0)
  })

  it('頁尾選單改名、連到同一頁（沒人寫成知識）＝同一行改了一點，照樣略過', () => {
    const diff = computeDiff([oldChunk('a', '運費', '滿千免運。')], [newChunk('運費', '滿千免運。')])
    const gate = gateDiffByPageChanges(diff, diffPageLines('關於我們（https://shop.example.tw/about）', '認識小舖（https://shop.example.tw/about）', { ignoreNumbers: false }))
    expect(gate.lines.map(l => l.status)).toEqual(['uncovered', 'uncovered'])
    expect(gate.uncertain).toBe(0)
  })

  /**
   * `C-379`：網頁新冒出來一行、AI 沒寫進任何一條（切卡漏掉、或被當成「現在的狀態」略過）——
   * 以前跟每一條都不像就當頁尾略過，排程照樣把基準推到這一版，之後比網頁再也看不到這一行。
   */
  it('⛔ 網頁新冒出來一行、AI 沒寫成任何一條（漏掉的新商品）→ 對不到、要問', () => {
    const diff = computeDiff(
      [oldChunk('sharp', 'SHARP 靜音無線吸塵器', card('SHARP', 'EC-SR9TW', 'SHARP靜音無線吸塵器，主打靜音和無線設計。'))],
      [newChunk('SHARP 靜音無線吸塵器', card('SHARP', 'EC-SR9TW', 'SHARP靜音無線吸塵器，主打靜音和無線設計。'))],
    )
    const gate = gateDiffByPageChanges(diff, diffPageLines(
      line('SHARP 靜音無線吸塵器 EC-SR9TW', 'EC-SR9TW'),
      [line('SHARP 靜音無線吸塵器 EC-SR9TW', 'EC-SR9TW'), line('Giaretti 珈樂堤 小滑手全自動義式咖啡機', 'GL-5680')].join('\n'),
      { ignoreNumbers: true },
    ))
    expect(gate.lines).toEqual([expect.objectContaining({ side: 'added', status: 'uncertain' })])
    expect(gate.uncertain).toBe(1)
  })

  it('⛔ 新商品那行跟下架那行長得一樣（同一個格式、只差名字和連結）也不算「同一行改了一點」', () => {
    const diff = computeDiff([oldChunk('a', '運費', '滿千免運。')], [newChunk('運費', '滿千免運。')])
    // 名字短的時候，兩行的字有七成以上一樣（全是「人數達標解鎖更多獎勵…人支持」）
    const gate = gateDiffByPageChanges(diff, diffPageLines(
      line('AROMIC 香氛機', 'aromic'),
      line('NWT 除濕機', 'WDH-16EF'),
      { ignoreNumbers: true },
    ))
    expect(gate.lines.map(l => [l.side, l.status])).toEqual([['removed', 'uncovered'], ['added', 'uncertain']])
  })

  /**
   * `C-379`：連結只認「只有一條知識帶著它」的。網址的 ?id= 會被拿掉，`product?id=1` 跟 `product?id=2`
   * 是同一條——以前改一行就把帶這條連結的全部認走，一條都收不起來，AI 重寫的版本整批套上去。
   */
  it('⛔ 好幾條知識共用的連結（?id= 被拿掉）不拿來認：網頁沒改的那幾條照樣收起來', () => {
    // 列表頁一個商品一行：名字、特色、價錢、連結
    const p = (name: string, id: number, feature: string, price: number) => `${name} ${feature} 售價 ${price} 元（https://shop.example.tw/product?id=${id}）`
    const c = (name: string, id: number, price: number, body: string) => `重點：品名：${name}｜售價：${price} 元\n\n${body}\n連結：https://shop.example.tw/product?id=${id}`
    const diff = computeDiff(
      [
        oldChunk('a', '保溫杯', c('保溫杯', 1, 590, '316 不鏽鋼保溫杯，保冷 12 小時。')),
        oldChunk('b', '手沖壺', c('手沖壺', 2, 1280, '細口手沖壺，容量 600ml。')),
      ],
      [
        newChunk('保溫杯', c('保溫杯', 1, 690, '316 不鏽鋼保溫杯，保冷 12 小時。')),
        newChunk('手沖壺', c('手沖壺', 2, 1280, '這是一把細口設計的手沖壺，容量為 600ml。')),
      ],
    )
    const gate = gateDiffByPageChanges(diff, diffPageLines(
      [p('保溫杯', 1, '316 不鏽鋼保溫杯，保冷 12 小時', 590), p('手沖壺', 2, '細口手沖壺，容量 600ml', 1280)].join('\n'),
      [p('保溫杯', 1, '316 不鏽鋼保溫杯，保冷 12 小時', 690), p('手沖壺', 2, '細口手沖壺，容量 600ml', 1280)].join('\n'),
      { ignoreNumbers: false },
    ))
    expect(diff.entries.find(e => e.oldChunk?.id === 'a')!.pageUnchanged).toBeUndefined()
    // 手沖壺那行網頁沒改：AI 換句話說的那版收起來，原本的不動
    expect(diff.entries.find(e => e.oldChunk?.id === 'b')).toMatchObject({ kind: 'modified', pageUnchanged: true, defaultAction: 'keep_old' })
    expect(gate.uncertain).toBe(0)
  })

  it('⛔ 共用的連結認不出是哪一條、文字也對不上 → 不當頁尾略過，要問', () => {
    const diff = computeDiff(
      [oldChunk('a', '門市', '台北門市在信義區。\n連結：https://shop.example.tw/'), oldChunk('b', '客服', '客服時間週一到週五。\n連結：https://shop.example.tw/')],
      [newChunk('門市', '台北門市在信義區。\n連結：https://shop.example.tw/'), newChunk('客服', '客服時間週一到週五。\n連結：https://shop.example.tw/')],
    )
    const gate = gateDiffByPageChanges(diff, diffPageLines('', '雙十一全館八折（https://shop.example.tw/）', { ignoreNumbers: false }))
    expect(gate.lines).toEqual([expect.objectContaining({ side: 'added', status: 'uncertain' })])
  })
})
