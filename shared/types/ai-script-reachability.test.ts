/**
 * 「這條腳本永遠輪不到」靜態分析。
 * 判定一律取強條件(每個觸發詞都被蓋掉才算)——這裡的測試重點有一半是**不該報**的情況:
 * 異常中心報一次假的,使用者就會學會忽略它。
 */
import { describe, it, expect } from 'vitest'
import { findUnreachableScripts, type ScriptForReachability } from './ai-script-reachability'
import type { ScriptNode } from './ai-script'

function script(over: Partial<ScriptForReachability> & { id: string; keywords?: string[]; examples?: string[] }): ScriptForReachability {
  const { keywords = ['退貨'], examples = [], ...rest } = over
  const nodes: ScriptNode[] = [
    { id: 't', type: 'trigger', matchMode: 'semantic', keywords, examples, priority: 50, next: 'r' },
    { id: 'r', type: 'reply', text: 'ok', thenHandoff: false },
  ]
  return { name: '退換貨', enabled: true, priority: 50, rootNodeId: 't', nodes, ...rest }
}

describe('findUnreachableScripts', () => {
  it('沒有任何觸發詞和範例 → 報「沒東西能啟動它」', () => {
    const r = findUnreachableScripts([script({ id: 's1', keywords: [], examples: [] })])
    expect(r).toHaveLength(1)
    expect(r[0]!.reason).toBe('noTrigger')
  })

  it('只有語意範例、沒有關鍵字 → 不報（走意圖路由，擋不掉整條路）', () => {
    expect(findUnreachableScripts([script({ id: 's1', keywords: [], examples: ['我要退貨'] })])).toEqual([])
  })

  it('停用的腳本不報（停用是刻意的，不是異常）', () => {
    expect(findUnreachableScripts([script({ id: 's1', enabled: false, keywords: [] })])).toEqual([])
  })

  describe('自動回覆規則擋在前面', () => {
    it('containsAny 的 token 是觸發詞的子字串 → 每則都先被規則接走', () => {
      const r = findUnreachableScripts(
        [script({ id: 's1', keywords: ['退貨', '換貨'] })],
        { rules: [{ name: '售後服務', matchType: 'containsAny', keyword: '退,換' }] },
      )
      expect(r[0]!.reason).toBe('autoReplyRule')
      expect(r[0]!.detail).toContain('售後服務')
    })

    it('只蓋到部分觸發詞 → 不報（另一個詞還是進得來）', () => {
      const r = findUnreachableScripts(
        [script({ id: 's1', keywords: ['退貨', '換貨'] })],
        { rules: [{ name: '退貨說明', matchType: 'containsAny', keyword: '退貨' }] },
      )
      expect(r).toEqual([])
    })

    it('exact 規則只搶走「整句就是那個詞」→ 詞不同就不算蓋台', () => {
      const rules = [{ name: '用戶', matchType: 'exact' as const, keyword: '用戶' }]
      expect(findUnreachableScripts([script({ id: 's1', keywords: ['退貨'] })], { rules })).toEqual([])
      const same = findUnreachableScripts([script({ id: 's1', keywords: ['用戶'] })], { rules })
      expect(same[0]!.reason).toBe('autoReplyRule')
    })

    it('containsAll 要觸發詞含全部 token 才算必定被搶', () => {
      const rules = [{ name: '退貨查詢', matchType: 'containsAll' as const, keyword: '退貨,查詢' }]
      expect(findUnreachableScripts([script({ id: 's1', keywords: ['退貨'] })], { rules })).toEqual([])
      expect(findUnreachableScripts([script({ id: 's1', keywords: ['退貨查詢單'] })], { rules })[0]!.reason).toBe('autoReplyRule')
    })

    it('anyText 規則刻意不在這裡報（已有 anyTextBlocking 那一項）', () => {
      const r = findUnreachableScripts(
        [script({ id: 's1' })],
        { rules: [{ name: '兜底', matchType: 'anyText', keyword: '' }] },
      )
      expect(r).toEqual([])
    })
  })

  it('觸發詞都含敏感情境詞 → 安全層先攔走，腳本永遠不啟動', () => {
    const r = findUnreachableScripts(
      [script({ id: 's1', name: '退款流程', keywords: ['我要申訴', '申訴流程'] })],
      { sensitiveTopics: ['申訴', '律師'] },
    )
    expect(r[0]!.reason).toBe('sensitiveTopic')
    expect(r[0]!.detail).toContain('申訴')
  })

  it('只有部分觸發詞撞敏感詞 → 不報', () => {
    const r = findUnreachableScripts(
      [script({ id: 's1', keywords: ['申訴', '退貨'] })],
      { sensitiveTopics: ['申訴'] },
    )
    expect(r).toEqual([])
  })

  describe('被另一條腳本包住', () => {
    const broad = script({ id: 'broad', name: '查詢訂單', keywords: ['訂單'] })

    it('關鍵字更寬、優先度不低的腳本會先接走', () => {
      const narrow = script({ id: 'narrow', name: '訂單改地址', keywords: ['訂單地址', '改訂單地址'] })
      const r = findUnreachableScripts([broad, narrow])
      expect(r).toHaveLength(1)
      expect(r[0]!.scriptId).toBe('narrow')
      expect(r[0]!.detail).toContain('查詢訂單')
    })

    it('自己優先度較高 → 不報（它才是先被挑到的那個）', () => {
      const narrow = script({ id: 'narrow', keywords: ['訂單地址'], priority: 90 })
      expect(findUnreachableScripts([broad, narrow])).toEqual([])
    })

    it('關鍵字沒有互相包住 → 不報', () => {
      const other = script({ id: 'other', keywords: ['退貨'] })
      expect(findUnreachableScripts([broad, other])).toEqual([])
    })
  })

  it('同一條腳本只回第一個成立的原因，不會一次噴四張卡', () => {
    const r = findUnreachableScripts(
      [script({ id: 's1', keywords: ['申訴'] })],
      { sensitiveTopics: ['申訴'], rules: [{ name: '兜底', matchType: 'containsAny', keyword: '申訴' }] },
    )
    expect(r).toHaveLength(1)
    expect(r[0]!.reason).toBe('sensitiveTopic')
  })

  it('線上 MYFEEL 現況（3 條啟用、規則都停用）→ 乾淨無異常', () => {
    const live = [
      script({ id: 'a', name: '更改地址', keywords: ['地址錯誤', '更改地址', '改地址', '換地址'] }),
      script({ id: 'b', name: '新增備註', keywords: ['新增備註', '備註', '要備註'] }),
      script({ id: 'c', name: '查詢訂單', keywords: ['訂單', '查詢', '進度'] }),
    ]
    expect(findUnreachableScripts(live, { rules: [], sensitiveTopics: ['自殺', '提告', '律師'] })).toEqual([])
  })
})
