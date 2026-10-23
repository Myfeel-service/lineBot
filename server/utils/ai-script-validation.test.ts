/**
 * 存檔前的收斂：「這些交給 AI 回答，不要接」那一格（`C-395`）。
 * 看字那種（`D-148`）畫面上也有這格、比對也認得，以前存檔時只留給看意思那種——填了、存了、重新整理就不見。
 */
import { describe, it, expect } from 'vitest'
import { normalizeScriptInput } from './ai-script-validation'

function triggerOf(trigger: Record<string, unknown>) {
  const input = normalizeScriptInput({
    name: '退貨', enabled: true, priority: 50, rootNodeId: 't',
    nodes: [
      { id: 't', type: 'trigger', priority: 50, next: 'r', ...trigger },
      { id: 'r', type: 'reply', text: 'ok', thenHandoff: false },
    ],
  })
  return input.nodes.find(n => n.type === 'trigger') as any
}

describe('normalizeScriptInput：不要接（excludes）', () => {
  it('看字那種（訊息裡有這些字就接）：不要接照收', () => {
    const t = triggerOf({ matchMode: 'keyword', keywordMatch: 'any', keywords: ['退貨'], excludes: [' 不想退貨 ', ''] })
    expect(t.excludes).toEqual(['不想退貨'])
  })

  it('看字那種（每個字都要有）：不要接照收', () => {
    expect(triggerOf({ keywordMatch: 'all', keywords: ['退貨', '訂單'], excludes: ['不想退貨'] }).excludes).toEqual(['不想退貨'])
  })

  it('一模一樣才接、客人輸入任何內容：不要接用不到，存檔時清掉', () => {
    expect(triggerOf({ keywordMatch: 'exact', keywords: ['退貨'], excludes: ['不想退貨'] }).excludes).toBeUndefined()
    expect(triggerOf({ keywordMatch: 'anyText', keywords: [], excludes: ['不想退貨'] }).excludes).toBeUndefined()
  })

  it('看意思那種：照舊收', () => {
    expect(triggerOf({ matchMode: 'semantic', examples: ['我要退貨'], excludes: ['什麼時候出貨'] }).excludes).toEqual(['什麼時候出貨'])
  })

  it('沒填：不寫這格（Firestore 不收 undefined）', () => {
    expect('excludes' in triggerOf({ keywordMatch: 'any', keywords: ['退貨'], excludes: ['  '] })).toBe(false)
  })
})
