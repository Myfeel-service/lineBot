/**
 * 知識缺口建議的純函式測試：聚類（同義問句合桶、不同主題分桶、按熱度排序）
 * 與草稿佔位符計數（採用端靠它擋「還有空格沒補」的草稿）。
 * 依賴 I/O 的掃描主流程由整合環境驗證，這裡不 mock Firestore。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('./gemini', () => ({
  embedQuery: vi.fn(),
  generateJson: vi.fn(),
  estimateTokens: (t: string) => Math.ceil(t.length / 4),
}))
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn() }))
vi.mock('./ai-handoff-notify', () => ({ notifyKnowledgeSourceEvent: vi.fn() }))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))

import { buildClusters, countDraftBlanks, excludeAnsweredFromCluster, splitSuggestionQueries, type GapItem } from './ai-knowledge-suggest'

function item(query: string, count: number, vector: number[], latestMs = 0): GapItem & { vector: number[] } {
  return { query, count, latestMs, chunkFreq: new Map(), vector }
}

describe('buildClusters', () => {
  it('同義問句（相似度過門檻）合進同一桶，不同主題分開', () => {
    const clusters = buildClusters([
      item('運費多少', 3, [1, 0]),
      item('請問運費怎麼算', 2, [0.995, 0.0999]), // cos ≈ 0.995 → 同桶
      item('可以退貨嗎', 4, [0, 1]), // 正交 → 另開桶
    ])
    expect(clusters).toHaveLength(2)
    // 按 totalCount 排序：運費桶 3+2=5 在前
    expect(clusters[0]!.totalCount).toBe(5)
    expect(clusters[0]!.items.map(i => i.query)).toContain('請問運費怎麼算')
    expect(clusters[1]!.items[0]!.query).toBe('可以退貨嗎')
  })

  it('相似度低於門檻的各自成桶（寧可切太細，不把不同主題混成一張卡）', () => {
    // cos([1,0],[0.7,0.714]) ≈ 0.7 < 0.83
    const clusters = buildClusters([
      item('a', 1, [1, 0]),
      item('b', 1, [0.7, 0.714]),
    ])
    expect(clusters).toHaveLength(2)
  })

  it('latestMs 取桶內最大值（給「最近一次被問」用）', () => {
    const clusters = buildClusters([
      item('運費多少', 1, [1, 0], 100),
      item('運費怎麼算', 1, [0.999, 0.04], 900),
    ])
    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.latestMs).toBe(900)
  })
})

describe('countDraftBlanks', () => {
  it('全形／半形冒號的佔位符都算', () => {
    expect(countDraftBlanks('運費【請填寫：金額】，海外【請填寫:是否供應】')).toBe(2)
  })
  it('沒有佔位符回 0', () => {
    expect(countDraftBlanks('運費全館滿千免運，未滿收 80 元。')).toBe(0)
  })
  it('沒閉合的「【請填寫」不算（避免誤擋正常內容）', () => {
    expect(countDraftBlanks('【請填寫但沒有結尾')).toBe(0)
  })
  it('LLM 漏寫冒號時也要算到（否則佔位符會溜過採用守門）', () => {
    expect(countDraftBlanks('運費【請填寫金額】')).toBe(1)
  })
})

// ── `C-311` 只採用其中幾題 ─────────────────────────────────────────
// 正式站實例：「小滑手」那組四題是同一個產品的不同問題，寫一條回答其中一題、按採用就整組消失。

const ORIGIN = '請問一下小滑手咖啡機是哪一國做的？'
const ESPRESSO = '小滑手只能沖義式咖啡嗎？'
const FROTH = '小滑手咖啡機 能萃取咖啡液的同時打奶泡嗎'
const SIZE = '小滑手咖啡機 寬/深/高各多少'
const GROUP = [ORIGIN, ESPRESSO, FROTH, SIZE]

describe('splitSuggestionQueries（勾了哪幾題 → 還剩什麼）', () => {
  const doc = {
    queries: GROUP,
    queryCounts: [3, 2, 1, 1],
    sampleQueries: GROUP,
    eventCount: 7,
    sampled: false,
  }

  it('只勾一題 → 剩三題照原順序、次數扣掉那一題的 3 次、名字退回剩下第一題的原句', () => {
    const { answered, remaining } = splitSuggestionQueries(doc, [ORIGIN])
    expect(answered).toEqual([ORIGIN])
    expect(remaining).toEqual({
      queries: [ESPRESSO, FROTH, SIZE],
      queryCounts: [2, 1, 1],
      sampleQueries: [ESPRESSO, FROTH, SIZE],
      eventCount: 4,
      sampled: false,
      answeredQueries: [ORIGIN],
      topic: ESPRESSO.slice(0, 12),
    })
  })

  it('全勾 → remaining 是 null（＝原本的整組採用）', () => {
    expect(splitSuggestionQueries(doc, [...GROUP].reverse())).toEqual({ answered: GROUP, remaining: null })
  })

  it('⛔ 勾的不在這一組（別的分頁已經回答掉了）→ 一題都不算', () => {
    const { answered, remaining } = splitSuggestionQueries(doc, ['別組的問題'])
    expect(answered).toEqual([])
    // 沒回答到任何一題：剩下的就是整組，次數不變
    expect(remaining?.queries).toEqual(GROUP)
    expect(remaining?.eventCount).toBe(7)
  })

  it('總數含 30 條以外沒存下來的題目：用扣的，不用剩下的加總（不然會少算）', () => {
    // 存著的四題加起來 7，總數 12＝另有 5 次落在沒存下來的題目
    const r = splitSuggestionQueries({ ...doc, eventCount: 12 }, [ORIGIN]).remaining!
    expect(r.eventCount).toBe(9)
  })

  it('舊資料沒有各題次數 → 剩 k 題就說「至少 k 次」', () => {
    const r = splitSuggestionQueries({ ...doc, queryCounts: undefined }, [ORIGIN]).remaining!
    expect(r.eventCount).toBe(3)
    expect(r.sampled).toBe(true)
    expect(r.queryCounts).toBeNull()
  })

  it('舊資料、但每題都只被問過 1 次（總數＝題數）→ 次數是確定的，不加「至少」', () => {
    const r = splitSuggestionQueries({ ...doc, queryCounts: undefined, eventCount: 4 }, [ORIGIN]).remaining!
    expect(r.eventCount).toBe(3)
    expect(r.sampled).toBe(false)
  })

  it('次數跟題目對不上（長度不同）→ 不硬扣，當成舊資料', () => {
    const r = splitSuggestionQueries({ ...doc, queryCounts: [3, 2] }, [ORIGIN]).remaining!
    expect(r.queryCounts).toBeNull()
    expect(r.sampled).toBe(true)
  })

  it('之前已經回答過的題目照樣記著（第二次部分採用不會把第一次的忘掉）', () => {
    const r = splitSuggestionQueries({ ...doc, answeredQueries: ['更早回答的'] }, [ORIGIN]).remaining!
    expect(r.answeredQueries).toEqual(['更早回答的', ORIGIN])
  })

  it('沒有 queries 的舊資料退回樣本句', () => {
    const { answered, remaining } = splitSuggestionQueries({ ...doc, queries: [], queryCounts: undefined }, [SIZE])
    expect(answered).toEqual([SIZE])
    expect(remaining?.queries).toEqual([ORIGIN, ESPRESSO, FROTH])
  })
})

describe('excludeAnsweredFromCluster（掃描比對完，拿掉回答過的題目）', () => {
  const cluster = {
    centroid: [1, 0],
    items: [
      { query: ORIGIN, count: 3, latestMs: 900, chunkFreq: new Map() },
      { query: ESPRESSO, count: 2, latestMs: 500, chunkFreq: new Map() },
      { query: SIZE, count: 1, latestMs: 100, chunkFreq: new Map() },
    ],
    totalCount: 6,
    latestMs: 900,
  }

  it('拿掉回答過的、次數與最近被問時間照剩下的重算，中心不動', () => {
    const r = excludeAnsweredFromCluster(cluster, [ORIGIN])
    expect(r.items.map(i => i.query)).toEqual([ESPRESSO, SIZE])
    expect(r.totalCount).toBe(3)
    expect(r.latestMs).toBe(500)
    expect(r.centroid).toBe(cluster.centroid)
  })

  it('沒有回答過的 → 原封不動', () => {
    expect(excludeAnsweredFromCluster(cluster, undefined)).toBe(cluster)
    expect(excludeAnsweredFromCluster(cluster, ['別組的'])).toBe(cluster)
  })
})
