import { describe, it, expect } from 'vitest'
import { classifyMinorChange } from './ai-knowledge-autoapply'
import type { DiffResult, DiffEntry } from './ai-knowledge-resync'

/** 快速組 DiffEntry:kind=modified 的新舊卡 */
function mod(id: string, opts: { oldTitle?: string; newTitle?: string; manuallyEdited?: boolean } = {}): DiffEntry {
  const oldTitle = opts.oldTitle ?? `卡片${id}`
  const newTitle = opts.newTitle ?? oldTitle
  return {
    id: `mod:${id}`,
    kind: 'modified',
    defaultAction: opts.manuallyEdited ? 'keep_old' : 'use_new',
    oldChunk: { id, title: oldTitle, content: `舊內容${id}`, tags: [], manuallyEdited: opts.manuallyEdited ?? false },
    newChunk: { title: newTitle, content: `新內容${id}`, tags: ['t'], questions: ['問法'] },
  }
}

function same(id: string): DiffEntry {
  return {
    id: `same:${id}`,
    kind: 'unchanged',
    defaultAction: 'keep_old',
    oldChunk: { id, title: `卡片${id}`, content: `內容${id}`, tags: [], manuallyEdited: false },
    newChunk: { title: `卡片${id}`, content: `內容${id}`, tags: [] },
  }
}

function makeDiff(entries: DiffEntry[]): DiffResult {
  return {
    entries,
    summary: {
      added: entries.filter(e => e.kind === 'new').length,
      modified: entries.filter(e => e.kind === 'modified').length,
      removed: entries.filter(e => e.kind === 'removed').length,
      unchanged: entries.filter(e => e.kind === 'unchanged').length,
    },
  }
}

const CHARS = { oldTotalChars: 1000, newTotalChars: 1000 }

describe('classifyMinorChange', () => {
  it('標題精確配對的小改(1/10 張)→ auto,帶出要套用的卡', () => {
    const diff = makeDiff([mod('a'), ...Array.from({ length: 9 }, (_, i) => same(`s${i}`))])
    const v = classifyMinorChange(diff, CHARS)
    expect(v.kind).toBe('auto')
    expect(v.toApply).toHaveLength(1)
    expect(v.toApply[0]).toMatchObject({ chunkId: 'a', content: '新內容a' })
  })

  it('有新增或移除 → manual(結構變化留人工)', () => {
    const withNew = makeDiff([
      mod('a'),
      same('s1'),
      { id: 'new:0', kind: 'new', defaultAction: 'add_new', newChunk: { title: '新卡', content: 'x', tags: [] } },
    ])
    expect(classifyMinorChange(withNew, CHARS).kind).toBe('manual')

    const withRemoved = makeDiff([
      same('s1'),
      { id: 'rem:z', kind: 'removed', defaultAction: 'delete_old', oldChunk: { id: 'z', title: '舊卡', content: 'x', tags: [], manuallyEdited: false } },
    ])
    expect(classifyMinorChange(withRemoved, CHARS).kind).toBe('manual')
  })

  it('涉及手編卡 → manual(整源退人工,不只跳過那張)', () => {
    const diff = makeDiff([mod('a', { manuallyEdited: true }), ...Array.from({ length: 9 }, (_, i) => same(`s${i}`))])
    const v = classifyMinorChange(diff, CHARS)
    expect(v.kind).toBe('manual')
    expect(v.reason).toContain('手動編輯')
  })

  it('標題有變(第二輪內容配對)→ manual', () => {
    const diff = makeDiff([mod('a', { oldTitle: '運費說明', newTitle: '運費與配送說明' }), ...Array.from({ length: 9 }, (_, i) => same(`s${i}`))])
    expect(classifyMinorChange(diff, CHARS).kind).toBe('manual')
  })

  it('變動比例 > 30% → manual', () => {
    const diff = makeDiff([mod('a'), mod('b'), same('s1'), same('s2')]) // 2/4 = 50%
    const v = classifyMinorChange(diff, CHARS)
    expect(v.kind).toBe('manual')
    expect(v.reason).toContain('比例')
    // 邊界:3/10 = 30% 不超過 → auto
    const boundary = makeDiff([mod('a'), mod('b'), mod('c'), ...Array.from({ length: 7 }, (_, i) => same(`s${i}`))])
    expect(classifyMinorChange(boundary, CHARS).kind).toBe('auto')
  })

  it('小來源(<4 張卡)改用絕對張數:改 1 張 → auto、改 2 張 → manual', () => {
    // 單卡來源改 1 張 = 100%,比例規則會讓它永遠過不了(卻已付一次重切卡的錢)
    expect(classifyMinorChange(makeDiff([mod('a')]), CHARS).kind).toBe('auto')
    expect(classifyMinorChange(makeDiff([mod('a'), same('s1')]), CHARS).kind).toBe('auto')
    const two = classifyMinorChange(makeDiff([mod('a'), mod('b'), same('s1')]), CHARS)
    expect(two.kind).toBe('manual')
    expect(two.reason).toContain('同時變動')
  })

  it('變動涉及已停用/已過期的卡 → manual(不可讓過期促銷卡無聲復活)', () => {
    const diff = makeDiff([mod('expired'), ...Array.from({ length: 9 }, (_, i) => same(`s${i}`))])
    const v = classifyMinorChange(diff, { ...CHARS, disabledChunkIds: new Set(['expired']) })
    expect(v.kind).toBe('manual')
    expect(v.reason).toContain('停用')
    // 停用的是「其他沒變動的卡」時不影響自動套用
    const ok = classifyMinorChange(diff, { ...CHARS, disabledChunkIds: new Set(['s0']) })
    expect(ok.kind).toBe('auto')
  })

  it('重切結果不合規(超長內容)→ manual,不寫進知識庫', () => {
    const entry = mod('a')
    entry.newChunk!.content = 'x'.repeat(6000) // validateChunkInput 上限 5000
    const diff = makeDiff([entry, ...Array.from({ length: 9 }, (_, i) => same(`s${i}`))])
    const v = classifyMinorChange(diff, CHARS)
    expect(v.kind).toBe('manual')
    expect(v.reason).toContain('不合規')
  })

  it('新內容長度暴跌(<50%)→ manual(疑似抓取不完整)', () => {
    const diff = makeDiff([mod('a'), ...Array.from({ length: 9 }, (_, i) => same(`s${i}`))])
    const v = classifyMinorChange(diff, { oldTotalChars: 1000, newTotalChars: 400 })
    expect(v.kind).toBe('manual')
    expect(v.reason).toContain('縮水')
  })

  it('重切後全部 unchanged → noop(不通知不標記)', () => {
    const diff = makeDiff([same('s1'), same('s2')])
    expect(classifyMinorChange(diff, CHARS).kind).toBe('noop')
  })

  it('新卡沒有 questions 時傳 undefined(保留既有問法)', () => {
    const entry = mod('a')
    entry.newChunk!.questions = []
    const diff = makeDiff([entry, ...Array.from({ length: 9 }, (_, i) => same(`s${i}`))])
    const v = classifyMinorChange(diff, CHARS)
    expect(v.kind).toBe('auto')
    expect(v.toApply[0]!.questions).toBeUndefined()
  })
})

/**
 * `C-157`：排程自動套用也要吃同一套摺疊。
 * 以前只有手動「重新同步」有，於是每天在跑、會自己改卡片又會發通知的這一條，
 * 反而在跟重切雜訊硬碰硬——不是被假移除逼回人工（發通知煩人），
 * 就是把只換了措辭的卡整批重寫（重算 embedding＝真的花錢）。
 */
describe('classifyMinorChange 吃摺疊旗標（C-157）', () => {
  const mk = (kind: string, id: string, extra: Record<string, unknown> = {}): any => ({
    id, kind, defaultAction: 'use_new',
    oldChunk: { id, title: 't' + id, content: '舊內容'.repeat(5), tags: [], manuallyEdited: false, manuallyEditedAtMs: 0 },
    newChunk: { title: 't' + id, content: '新內容'.repeat(5), tags: [], questions: [] },
    ...extra,
  })
  const sum = (o: Record<string, number>) => ({ added: 0, modified: 0, removed: 0, unchanged: 0, ...o })

  it('🔴 「移除」其實還在網頁上 → 不算結構有變，不該被退回人工去煩店家', () => {
    const diff: any = {
      entries: [mk('removed', 'r1', { stillOnPage: true }), mk('unchanged', 'u1')],
      summary: sum({ removed: 1, unchanged: 1 }),
    }
    const v = classifyMinorChange(diff, { oldTotalChars: 100, newTotalChars: 100 })
    expect(v.kind).not.toBe('manual')
  })

  it('真的被網頁刪掉的照樣退回人工（這道守門不能被弄丟）', () => {
    const diff: any = {
      entries: [mk('removed', 'r1'), mk('unchanged', 'u1')],
      summary: sum({ removed: 1, unchanged: 1 }),
    }
    expect(classifyMinorChange(diff, { oldTotalChars: 100, newTotalChars: 100 }).kind).toBe('manual')
  })

  it('🔴 全部只是換句話說 → noop（不重寫、不重算 embedding，而且會推進版本記號）', () => {
    const diff: any = {
      entries: [mk('modified', 'm1', { cosmetic: true }), mk('modified', 'm2', { cosmetic: true })],
      summary: sum({ modified: 2 }),
    }
    expect(classifyMinorChange(diff, { oldTotalChars: 100, newTotalChars: 100 }).kind).toBe('noop')
  })

  it('比例判定只算「真的要改的」——七張換句話說＋一張真改，不該被當成改版', () => {
    const entries = [
      ...Array.from({ length: 7 }, (_, i) => mk('modified', `c${i}`, { cosmetic: true })),
      mk('modified', 'real'),
      ...Array.from({ length: 4 }, (_, i) => mk('unchanged', `u${i}`)),
    ]
    const diff: any = { entries, summary: sum({ modified: 8, unchanged: 4 }) }
    const v = classifyMinorChange(diff, { oldTotalChars: 1000, newTotalChars: 1000 })
    expect(v.kind).toBe('auto')
    expect(v.toApply.map(c => c.chunkId)).toEqual(['real']) // 只重寫那一張
  })
})
