import { describe, it, expect } from 'vitest'
import { SCRIPT_TEMPLATES } from './ai-script-templates'
import {
  collectSkipLabel,
  cosineSimilarity,
  extractCollectValue,
  matchesScriptKeywords,
  matchesScriptTrigger,
  matchesSemanticTrigger,
  outgoingNodeIds,
  validateScriptDoc,
  type ScriptDoc,
  type ScriptNode,
} from './ai-script'

function buildScript(trigger: Partial<ScriptNode> & { id: string; type: 'trigger' }): Pick<ScriptDoc, 'nodes' | 'rootNodeId' | 'enabled'> {
  return {
    enabled: true,
    rootNodeId: trigger.id,
    nodes: [
      { keywords: [], priority: 50, next: 'r1', ...trigger } as ScriptNode,
      { id: 'r1', type: 'reply', text: 'ok', thenHandoff: false },
    ],
  }
}

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors and 0 for orthogonal', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
  })
  it('is scale-invariant (handles non-normalized vectors)', () => {
    expect(cosineSimilarity([1, 1], [3, 3])).toBeCloseTo(1)
  })
  it('guards against empty / mismatched lengths', () => {
    expect(cosineSimilarity([], [1])).toBe(0)
    expect(cosineSimilarity([1, 2], [1])).toBe(0)
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0)
  })
})

describe('matchesScriptTrigger (keyword)', () => {
  it('matches substring case-insensitively', () => {
    const s = buildScript({ id: 't1', type: 'trigger', keywords: ['退貨'] })
    expect(matchesScriptTrigger(s, '我想要退貨')).toBe(true)
    expect(matchesScriptTrigger(s, '你好嗎')).toBe(false)
  })
  it('never matches when trigger is in semantic mode', () => {
    const s = buildScript({ id: 't1', type: 'trigger', matchMode: 'semantic', keywords: ['退貨'], examples: ['退貨'] })
    expect(matchesScriptTrigger(s, '我想要退貨')).toBe(false)
  })
  it('does not match a disabled script', () => {
    const s = { ...buildScript({ id: 't1', type: 'trigger', keywords: ['退貨'] }), enabled: false }
    expect(matchesScriptTrigger(s, '退貨')).toBe(false)
  })
})

describe('matchesScriptKeywords (mode-agnostic fast-path)', () => {
  it('matches keywords even in semantic mode (keywords = definite triggers)', () => {
    const s = buildScript({ id: 't1', type: 'trigger', matchMode: 'semantic', keywords: ['預約'], examples: ['想約個時間'] })
    // matchesScriptTrigger 會因 semantic 模式回 false；matchesScriptKeywords 仍命中 keyword
    expect(matchesScriptTrigger(s, '我要預約')).toBe(false)
    expect(matchesScriptKeywords(s, '我要預約')).toBe(true)
    expect(matchesScriptKeywords(s, '今天天氣好')).toBe(false)
  })
})

describe('matchesSemanticTrigger', () => {
  // 向量包一層 { values }（與 Firestore 友善的儲存結構一致）
  const emb = [1, 0, 0]
  const semantic = buildScript({
    id: 't1', type: 'trigger', matchMode: 'semantic', examples: ['我要退貨'], exampleEmbeddings: [{ values: emb }],
  })
  it('returns the similarity when above threshold', () => {
    expect(matchesSemanticTrigger(semantic, [1, 0, 0], 0.8)).toBeCloseTo(1)
  })
  it('returns 0 when below threshold', () => {
    expect(matchesSemanticTrigger(semantic, [0, 1, 0], 0.8)).toBe(0)
  })
  it('returns 0 for keyword-mode triggers', () => {
    const kw = buildScript({ id: 't1', type: 'trigger', keywords: ['退貨'] })
    expect(matchesSemanticTrigger(kw, [1, 0, 0], 0.8)).toBe(0)
  })
})

describe('extractCollectValue', () => {
  it('any: stores the whole trimmed message', () => {
    expect(extractCollectValue({ format: 'any' }, '  你好  ')).toEqual({ ok: true, value: '你好' })
    expect(extractCollectValue({}, '隨便打')).toEqual({ ok: true, value: '隨便打' })
  })
  it('phone: extracts digits from a sentence, strips dashes/spaces', () => {
    expect(extractCollectValue({ format: 'phone' }, '我的電話是0912345678啦')).toEqual({ ok: true, value: '0912345678' })
    expect(extractCollectValue({ format: 'phone' }, '市話 02-12345678')).toEqual({ ok: true, value: '0212345678' })
    expect(extractCollectValue({ format: 'phone' }, '沒有電話')).toEqual({ ok: false, value: '' })
  })
  it('phone: rejects a too-long digit run instead of truncating a fake phone', () => {
    expect(extractCollectValue({ format: 'phone' }, '0912345678901234')).toEqual({ ok: false, value: '' })
    expect(extractCollectValue({ format: 'phone' }, '99990912345678')).toEqual({ ok: false, value: '' })
  })
  it('email: extracts the address', () => {
    expect(extractCollectValue({ format: 'email' }, '寄到 a@b.com 謝謝')).toEqual({ ok: true, value: 'a@b.com' })
    expect(extractCollectValue({ format: 'email' }, 'no email here')).toEqual({ ok: false, value: '' })
  })
  it('number: extracts the first run of digits', () => {
    expect(extractCollectValue({ format: 'number' }, '數量大概 25 個')).toEqual({ ok: true, value: '25' })
  })
  it('custom: uses the pattern; falls back to any when pattern is invalid', () => {
    expect(extractCollectValue({ format: 'alphanumeric' }, '我的編號是A123456喔')).toEqual({ ok: true, value: 'A123456' })
    expect(extractCollectValue({ format: 'alphanumeric' }, '編號 12345')).toEqual({ ok: true, value: '12345' })
    expect(extractCollectValue({ format: 'alphanumeric' }, '我不知道耶')).toEqual({ ok: false, value: '' })
    expect(extractCollectValue({ format: 'alphanumericSymbol' }, '單號是 OD-2024/001 謝謝')).toEqual({ ok: true, value: 'OD-2024/001' })
    expect(extractCollectValue({ format: 'alphanumericSymbol' }, '編號是A123。')).toEqual({ ok: true, value: 'A123' })
    expect(extractCollectValue({ format: 'alphanumericSymbol' }, 'AB_12#3')).toEqual({ ok: true, value: 'AB_12#3' })
    expect(extractCollectValue({ format: 'alphanumericSymbol' }, '沒有單號')).toEqual({ ok: false, value: '' })
    expect(extractCollectValue({ format: 'custom', pattern: '[A-Za-z]\\d{3,}' }, '我的編號是 A123 啦')).toEqual({ ok: true, value: 'A123' })
    expect(extractCollectValue({ format: 'custom', pattern: '[A-Za-z]\\d{3,}' }, '沒有編號')).toEqual({ ok: false, value: '' })
    // 壞掉的正則 → 不擋、原樣存
    expect(extractCollectValue({ format: 'custom', pattern: '[' }, '原樣')).toEqual({ ok: true, value: '原樣' })
  })
})

describe('SCRIPT_TEMPLATES', () => {
  it('every built-in template passes validateScriptDoc', () => {
    for (const tpl of SCRIPT_TEMPLATES) {
      const err = validateScriptDoc({ name: tpl.label, nodes: tpl.nodes, rootNodeId: tpl.rootNodeId })
      expect(err, `template "${tpl.key}" should be valid but got: ${err}`).toBeNull()
    }
  })
  it('templates have unique keys', () => {
    const keys = SCRIPT_TEMPLATES.map(t => t.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('action nodes (tag / saveLead)', () => {
  const base = { name: 's', rootNodeId: 't1' }
  function trigger(next: string): ScriptNode {
    return { id: 't1', type: 'trigger', keywords: ['hi'], priority: 50, next }
  }
  function collect(id: string, fieldName: string, next: string): ScriptNode {
    return { id, type: 'collect', question: 'q', fieldName, expireMs: 60000, format: 'any', next }
  }
  it('outgoingNodeIds: tag/saveLead expose their single next', () => {
    expect(outgoingNodeIds({ id: 'g', type: 'tag', addTagIds: ['x'], next: 'r1' })).toEqual(['r1'])
    expect(outgoingNodeIds({ id: 's', type: 'saveLead', fieldMap: [{ fromField: 'a', attrKey: 'b' }], next: 'r1' })).toEqual(['r1'])
  })
  it('accepts a valid tag + saveLead chain (saveLead source matches a collect field)', () => {
    const nodes: ScriptNode[] = [
      trigger('c1'),
      collect('c1', 'order_id', 'g1'),
      { id: 'g1', type: 'tag', addTagIds: ['vip'], next: 's1' },
      { id: 's1', type: 'saveLead', fieldMap: [{ fromField: 'order_id', attrKey: '訂單編號' }], next: 'r1' },
      { id: 'r1', type: 'reply', text: 'ok', thenHandoff: false },
    ]
    expect(validateScriptDoc({ ...base, nodes })).toBeNull()
  })
  it('rejects a tag node with no tags', () => {
    const nodes: ScriptNode[] = [
      trigger('g1'),
      { id: 'g1', type: 'tag', addTagIds: [], next: 'r1' },
      { id: 'r1', type: 'reply', text: 'ok', thenHandoff: false },
    ]
    expect(validateScriptDoc({ ...base, nodes })).toMatch(/標籤/)
  })
  it('rejects a saveLead with an incomplete field mapping', () => {
    const nodes: ScriptNode[] = [
      trigger('c1'),
      collect('c1', 'order_id', 's1'),
      { id: 's1', type: 'saveLead', fieldMap: [{ fromField: 'order_id', attrKey: '' }], next: 'r1' },
      { id: 'r1', type: 'reply', text: 'ok', thenHandoff: false },
    ]
    expect(validateScriptDoc({ ...base, nodes })).toMatch(/來源欄位與屬性名/)
  })
  it('rejects a saveLead whose source field has no matching collect node (typo / wrong order)', () => {
    const nodes: ScriptNode[] = [
      trigger('c1'),
      collect('c1', 'order_id', 's1'),
      { id: 's1', type: 'saveLead', fieldMap: [{ fromField: 'oder_id', attrKey: '訂單編號' }], next: 'r1' },
      { id: 'r1', type: 'reply', text: 'ok', thenHandoff: false },
    ]
    expect(validateScriptDoc({ ...base, nodes })).toMatch(/沒有對應的收集步驟/)
  })
})

describe('collect 跳過出口（skipLabel / skipNext）', () => {
  const base = { name: 's', rootNodeId: 't1' }
  const trigger = (next: string): ScriptNode => ({ id: 't1', type: 'trigger', keywords: ['hi'], priority: 50, next })
  const reply = (id: string): ScriptNode => ({ id, type: 'reply', text: 'ok', thenHandoff: false })
  const collectWithSkip = (skip: { skipLabel?: string; skipNext?: string }): ScriptNode => ({
    id: 'c1', type: 'collect', question: 'q', fieldName: 'order_id', expireMs: 60000, format: 'alphanumericSymbol', next: 'r1', ...skip,
  })

  it('outgoingNodeIds 把 skipNext 算進出口（可達性檢查看得到跳過路線）', () => {
    expect(outgoingNodeIds(collectWithSkip({ skipLabel: '沒有', skipNext: 'r2' }))).toEqual(['r1', 'r2'])
    expect(outgoingNodeIds(collectWithSkip({}))).toEqual(['r1'])
  })

  it('collectSkipLabel：skipLabel/skipNext 成對才算有設，單邊或空白視為沒設', () => {
    expect(collectSkipLabel({ skipLabel: '我沒有訂單編號', skipNext: 'x' })).toBe('我沒有訂單編號')
    expect(collectSkipLabel({ skipLabel: ' 我沒有訂單編號 ', skipNext: 'x' })).toBe('我沒有訂單編號')
    expect(collectSkipLabel({ skipLabel: '我沒有訂單編號' })).toBe('')
    expect(collectSkipLabel({ skipNext: 'x' })).toBe('')
    expect(collectSkipLabel({ skipLabel: '  ', skipNext: 'x' })).toBe('')
  })

  it('接受成對且指向存在步驟的跳過出口（例：沒編號 → 改問 Email）', () => {
    const nodes: ScriptNode[] = [
      trigger('c1'),
      collectWithSkip({ skipLabel: '我沒有訂單編號', skipNext: 'c2' }),
      { id: 'c2', type: 'collect', question: 'email?', fieldName: 'email', expireMs: 60000, format: 'email', next: 'r1' },
      reply('r1'),
    ]
    expect(validateScriptDoc({ ...base, nodes })).toBeNull()
  })

  it('有按鈕文字沒指定去向 → 擋（按了會是死路）', () => {
    const nodes: ScriptNode[] = [trigger('c1'), collectWithSkip({ skipLabel: '我沒有訂單編號' }), reply('r1')]
    expect(validateScriptDoc({ ...base, nodes })).toMatch(/還沒指定要跳到哪一步/)
  })

  it('有去向沒按鈕文字 → 擋（客人看不到入口）', () => {
    const nodes: ScriptNode[] = [trigger('c1'), collectWithSkip({ skipNext: 'r1' }), reply('r1')]
    expect(validateScriptDoc({ ...base, nodes })).toMatch(/請填寫按鈕文字/)
  })

  it('skipNext 指到不存在的步驟 → 擋', () => {
    const nodes: ScriptNode[] = [trigger('c1'), collectWithSkip({ skipLabel: '沒有', skipNext: 'ghost' }), reply('r1')]
    expect(validateScriptDoc({ ...base, nodes })).toMatch(/不存在的步驟/)
  })

  it('skipLabel 撞「找真人」求助詞 → 擋（逃生門會先攔走，永遠到不了 skipNext）', () => {
    const nodes: ScriptNode[] = [trigger('c1'), collectWithSkip({ skipLabel: '找真人', skipNext: 'r1' }), reply('r1')]
    expect(validateScriptDoc({ ...base, nodes })).toMatch(/求助詞/)
  })
})

describe('validateScriptDoc：觸發條件 + 自訂格式', () => {
  const base = { name: '退貨', rootNodeId: 't1' }
  it('keyword mode requires at least one keyword', () => {
    const nodes: ScriptNode[] = [
      { id: 't1', type: 'trigger', keywords: [], priority: 50, next: 'r1' },
      { id: 'r1', type: 'reply', text: 'ok', thenHandoff: false },
    ]
    expect(validateScriptDoc({ ...base, nodes })).toMatch(/關鍵字/)
  })
  it('semantic mode requires at least one example, not keywords', () => {
    const noExample: ScriptNode[] = [
      { id: 't1', type: 'trigger', matchMode: 'semantic', keywords: [], examples: [], priority: 50, next: 'r1' },
      { id: 'r1', type: 'reply', text: 'ok', thenHandoff: false },
    ]
    expect(validateScriptDoc({ ...base, nodes: noExample })).toMatch(/範例/)

    const withExample: ScriptNode[] = [
      { id: 't1', type: 'trigger', matchMode: 'semantic', keywords: [], examples: ['我要退貨'], priority: 50, next: 'r1' },
      { id: 'r1', type: 'reply', text: 'ok', thenHandoff: false },
    ]
    expect(validateScriptDoc({ ...base, nodes: withExample })).toBeNull()
  })
  it('custom collect format requires a non-empty pattern', () => {
    const emptyPattern: ScriptNode[] = [
      { id: 't1', type: 'trigger', keywords: ['退貨'], priority: 50, next: 'c1' },
      { id: 'c1', type: 'collect', question: '編號', fieldName: 'id', expireMs: 60000, format: 'custom', pattern: '  ', next: 'r1' },
      { id: 'r1', type: 'reply', text: 'ok', thenHandoff: false },
    ]
    expect(validateScriptDoc({ ...base, nodes: emptyPattern })).toMatch(/正則/)

    const withPattern: ScriptNode[] = [
      { id: 't1', type: 'trigger', keywords: ['退貨'], priority: 50, next: 'c1' },
      { id: 'c1', type: 'collect', question: '編號', fieldName: 'id', expireMs: 60000, format: 'custom', pattern: '[A-Za-z]\\d+', next: 'r1' },
      { id: 'r1', type: 'reply', text: 'ok', thenHandoff: false },
    ]
    expect(validateScriptDoc({ ...base, nodes: withPattern })).toBeNull()
  })
})

describe('validateScriptDoc：圖驗證（分支 / 快速回覆 / 循環）', () => {
  const base = { name: 's', rootNodeId: 't1' }
  function trigger(next: string): ScriptNode {
    return { id: 't1', type: 'trigger', keywords: ['hi'], priority: 50, next }
  }

  it('rejects a non-interactive branch cycle even when hidden behind a collect node', () => {
    const nodes: ScriptNode[] = [
      trigger('c0'),
      // collect 填了 f，分支條件合法；但 b1 ⇄ b2 是純非互動環，runtime 從 c0.next 開走會無限跳轉
      { id: 'c0', type: 'collect', question: 'q', fieldName: 'f', expireMs: 60000, format: 'any', next: 'b1' },
      { id: 'b1', type: 'branch', cases: [{ op: 'exists', field: 'f', next: 'b2' }], defaultNext: 'r1' },
      { id: 'b2', type: 'branch', cases: [{ op: 'exists', field: 'f', next: 'b1' }], defaultNext: 'r1' },
      { id: 'r1', type: 'reply', text: 'ok', thenHandoff: false },
    ]
    expect(validateScriptDoc({ ...base, nodes })).toMatch(/死循環/)
  })

  it('allows a re-ask loop that passes through an interactive (collect) node', () => {
    const nodes: ScriptNode[] = [
      trigger('c1'),
      { id: 'c1', type: 'collect', question: '電話?', fieldName: 'phone', expireMs: 60000, format: 'phone', next: 'b1' },
      // 電話有填到才往 reply，否則繞回 collect 重問——合法，因為 collect 會停等輸入
      { id: 'b1', type: 'branch', cases: [{ op: 'exists', field: 'phone', next: 'r1' }], defaultNext: 'c1' },
      { id: 'r1', type: 'reply', text: 'ok', thenHandoff: false },
    ]
    expect(validateScriptDoc({ ...base, nodes })).toBeNull()
  })

  it('rejects a quickReply with an empty question', () => {
    const nodes: ScriptNode[] = [
      trigger('q1'),
      { id: 'q1', type: 'quickReply', question: '  ', expireMs: 60000, options: [{ label: 'A', next: 'r1' }] },
      { id: 'r1', type: 'reply', text: 'ok', thenHandoff: false },
    ]
    expect(validateScriptDoc({ ...base, nodes })).toMatch(/問句/)
  })

  it('rejects duplicate quickReply option labels', () => {
    const nodes: ScriptNode[] = [
      trigger('q1'),
      { id: 'q1', type: 'quickReply', question: '選一個', expireMs: 60000, options: [{ label: '其他', next: 'r1' }, { label: '其他', next: 'r2' }] },
      { id: 'r1', type: 'reply', text: 'a', thenHandoff: false },
      { id: 'r2', type: 'reply', text: 'b', thenHandoff: false },
    ]
    expect(validateScriptDoc({ ...base, nodes })).toMatch(/重複的按鈕文字/)
  })

  it('rejects an orphan node (unreachable from trigger)', () => {
    const nodes: ScriptNode[] = [
      trigger('r1'),
      { id: 'r1', type: 'reply', text: 'ok', thenHandoff: false },
      { id: 'orphan', type: 'reply', text: '到不了', thenHandoff: false },
    ]
    expect(validateScriptDoc({ ...base, nodes })).toMatch(/接不到流程裡/)
  })
})
