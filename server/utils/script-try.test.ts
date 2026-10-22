import { describe, expect, it, vi } from 'vitest'
import type { ScriptDoc } from '~~/shared/types/ai-script'

/**
 * 自動回應頁「試試看」挑哪一條，要跟正式回客人一樣（`C-379`）：兩條用同一個字、優先度都一樣時，
 * 正式那邊照文件編號大的先（Firestore 同分隱含的排法），試試看以前把編輯中的那條排在後面、講反。
 */
vi.mock('./ai-scripts', () => ({ loadActiveScripts: vi.fn() }))
vi.mock('./ai-settings', () => ({ getAiSettings: vi.fn(async () => null) }))
vi.mock('./ai-answer', () => ({ routeMessage: vi.fn(async () => null) }))
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn(async () => {}) }))
vi.mock('./handler', () => ({ shipTimingGoesToAi: vi.fn(async () => false) }))

const { tryScriptRoute } = await import('./script-try')
const { loadActiveScripts } = await import('./ai-scripts')
const { sortByPriority } = await import('./script-match')

function returns(id: string, priority = 50): ScriptDoc & { id: string } {
  return {
    id,
    workspaceId: 'w1',
    name: id,
    enabled: true,
    priority,
    rootNodeId: 't',
    nodes: [
      { id: 't', type: 'trigger', matchMode: 'keyword', keywordMatch: 'any', keywords: ['退貨'], priority, next: 'r' },
      { id: 'r', type: 'reply', text: id, thenHandoff: false },
    ],
    createdAt: null as any,
    updatedAt: null as any,
  }
}

describe('試試看跟正式挑同一條', () => {
  it('同一個字、優先度一樣：正在編的是文件編號大的那條 → 試試看也說會走它', async () => {
    const stored = [returns('Bzz'), returns('Aaa')] // 正式那邊的順序：同分照編號大的先
    vi.mocked(loadActiveScripts).mockResolvedValue(sortByPriority(stored))
    const live = sortByPriority(stored)[0]!.id
    expect(live).toBe('Bzz')

    const r = await tryScriptRoute('w1', '我要退貨', returns('Bzz'))
    expect(r).toMatchObject({ kind: 'script', scriptId: 'Bzz', isDraft: true })
  })

  it('優先度高的照樣先（不管編號）', async () => {
    vi.mocked(loadActiveScripts).mockResolvedValue([returns('Aaa', 80)])
    const r = await tryScriptRoute('w1', '我要退貨', returns('Bzz', 50))
    expect(r).toMatchObject({ kind: 'script', scriptId: 'Aaa', isDraft: false })
  })
})
