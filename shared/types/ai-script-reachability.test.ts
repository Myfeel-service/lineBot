/**
 * 「這條腳本永遠輪不到」靜態分析。
 * 判定一律取強條件(每個觸發詞都被蓋掉才算)——這裡的測試重點有一半是**不該報**的情況:
 * 異常中心報一次假的,使用者就會學會忽略它。
 */
import { describe, it, expect } from 'vitest'
import {
  findUnreachableScripts,
  toReachabilityScripts,
  type ScriptForReachability,
} from './ai-script-reachability'
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

  it('同一條腳本只回第一個成立的原因，不會一次噴兩張卡', () => {
    const broad = script({ id: 'broad', name: '申訴總表', keywords: ['申訴'] })
    const narrow = script({ id: 's1', keywords: ['申訴流程'] })
    const r = findUnreachableScripts([broad, narrow], { sensitiveTopics: ['申訴'] })
      .filter(i => i.scriptId === 's1')
    expect(r).toHaveLength(1)
    expect(r[0]!.reason).toBe('sensitiveTopic')
  })

  it('線上 MYFEEL 現況（3 條啟用、規則都停用）→ 乾淨無異常', () => {
    const live = [
      script({ id: 'a', name: '更改地址', keywords: ['地址錯誤', '更改地址', '改地址', '換地址'] }),
      script({ id: 'b', name: '新增備註', keywords: ['新增備註', '備註', '要備註'] }),
      script({ id: 'c', name: '查詢訂單', keywords: ['訂單', '查詢', '進度'] }),
    ]
    expect(findUnreachableScripts(live, { sensitiveTopics: ['自殺', '提告', '律師'] })).toEqual([])
  })
})

/**
 * 這兩支是異常中心、腳本編輯器、自動回覆編輯器**共用**的入口正規化。
 * 三個地方各自手寫一遍的時候，總有一天會出現「這裡說會被蓋掉、那裡說不會」——
 * 所以這裡鎖的是那把尺本身：什麼算「啟用中」。
 */
describe('toReachabilityScripts', () => {
  it('只留啟用中的腳本（停用是刻意的，不算異常）', () => {
    const rows = toReachabilityScripts([
      { id: 'a', name: '啟用', enabled: true, rootNodeId: 't', nodes: [], priority: 50 },
      { id: 'b', name: '停用', enabled: false, rootNodeId: 't', nodes: [], priority: 50 },
      { id: 'c', name: '沒寫 enabled', rootNodeId: 't', nodes: [] },
    ])
    expect(rows.map(s => s.id)).toEqual(['a'])
  })

  it('缺 nodes/priority 不會炸，補成可分析的形狀', () => {
    const [row] = toReachabilityScripts([{ id: 'a', enabled: true }])
    expect(row).toEqual({ id: 'a', name: '', nodes: [], rootNodeId: '', enabled: true, priority: 0 })
  })
})
