/**
 * AI 讀對話貼標建議（ai-tag-suggest.ts）。
 * 釘的是兩條鐵律：
 *   1. ⛔ 模型不生 ID——回來的 tagId 只留白名單（候選集合）內的，幻覺 id、重複 id 全丟。
 *   2. prompt 只給「還能建議的候選」，且逐字稿把店家的話標開（店家的話不能當貼標依據）。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__' },
  Timestamp: { fromMillis: (ms: number) => ({ __ms: ms }) },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('./gemini', () => ({ generateJson: vi.fn(), runWithLlmBudget: vi.fn() }))
vi.mock('./ai-settings', () => ({ getAiSettings: vi.fn() }))
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn() }))
vi.mock('./inactive-tag', () => ({ INACTIVE_TAG_CODE: 'sys_inactive' }))

import { filterSuggestible, buildSuggestPrompt } from './ai-tag-suggest'

describe('filterSuggestible：模型不生 ID 的最後防線', () => {
  const candidates = new Set(['t1', 't2', 't3'])

  it('清單外的 id（模型幻覺）一律丟棄', () => {
    expect(filterSuggestible(['t1', 'made-up', 't2'], candidates)).toEqual(['t1', 't2'])
  })

  it('同一個 id 回兩次只留一個', () => {
    expect(filterSuggestible(['t1', 't1', 't1'], candidates)).toEqual(['t1'])
  })

  it('超過上限截斷（一場最多 3 個，避免一場對話貼滿全身）', () => {
    expect(filterSuggestible(['t1', 't2', 't3'], candidates, 2)).toEqual(['t1', 't2'])
  })

  it('空值與空白 id 不會混進來', () => {
    expect(filterSuggestible(['', '  ', 't2'], candidates)).toEqual(['t2'])
  })

  it('模型全回幻覺 → 空陣列（寧可沒建議，不可錯建議）', () => {
    expect(filterSuggestible(['x', 'y'], candidates)).toEqual([])
  })
})

describe('buildSuggestPrompt', () => {
  const catalog = [
    { id: 't1', name: '送禮客群', description: '會買禮盒送人的客人' },
    { id: 't2', name: 'VIP', description: '' },
  ]
  const transcript = [
    { role: 'customer' as const, text: '請問禮盒可以代寄嗎' },
    { role: 'shop' as const, text: '可以的，結帳時填收件人就好' },
  ]

  it('候選標籤帶 id 與名稱；客/店逐字稿標開（店家的話不能當依據，prompt 有講）', () => {
    const p = buildSuggestPrompt(catalog, transcript)
    expect(p).toContain('id: t1｜名稱: 送禮客群')
    expect(p).toContain('id: t2｜名稱: VIP')
    expect(p).toContain('客: 請問禮盒可以代寄嗎')
    expect(p).toContain('店: 可以的，結帳時填收件人就好')
    expect(p).toContain('店家（店:）說的話不能當依據')
    expect(p).toContain('只能從清單中選')
  })

  it('沒有說明的標籤不會多出空的「說明:」段', () => {
    const p = buildSuggestPrompt(catalog, transcript)
    expect(p).not.toContain('id: t2｜名稱: VIP｜說明:')
  })
})
