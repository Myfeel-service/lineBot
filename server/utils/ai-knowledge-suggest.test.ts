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

import { buildClusters, countDraftBlanks, type GapItem } from './ai-knowledge-suggest'

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
