/**
 * 上下架影響預覽（`C-182` 續：把「按下去之後會怎樣」講出來）。
 *
 * 為什麼這件事值得一支測試：上下架的影響**不在這條流程身上，在別條身上**——
 * 新開的這條可能把另一條的觸發詞整個包住，而客人不會回報這種事
 * （他們收到的是「別的回覆」不是「沒回覆」）。
 *
 * 釘住的：
 * 1. 開一條會蓋台的流程，要講出它會蓋掉誰。
 * 2. 停掉一條會蓋台的流程，要講出誰會活過來。
 * 3. 開了也輪不到（自己被敏感詞或別條蓋住）要先講——那種情況「開了等於沒開」。
 * 4. ⛔ 不另寫一套判定：影響是拿異常中心同一支分析器跑前後兩次比出來的。
 */
import { describe, expect, it } from 'vitest'
import {
  previewScriptToggleImpact,
  toReachabilityScriptsWithDisabled,
  type ScriptForReachability,
} from './ai-script-reachability'

/** 造一條腳本：一個 trigger 節點＋關鍵字 */
function script(id: string, name: string, keywords: string[], enabled: boolean, priority = 0): ScriptForReachability {
  return {
    id,
    name,
    enabled,
    priority,
    rootNodeId: 'n1',
    nodes: [{ id: 'n1', type: 'trigger', keywords, matchMode: 'keyword' } as any],
  }
}

describe('上下架影響預覽', () => {
  it('開一條觸發詞更寬的流程：講出它會把誰蓋掉', () => {
    const scripts = [
      script('a', '出貨查詢', ['出貨'], true),
      script('b', '全部攔截', ['出'], false), // 「出」包住「出貨」
    ]

    const impact = previewScriptToggleImpact(scripts, { id: 'b', enabled: true })

    expect(impact.newlyBlocked.map(i => i.scriptName)).toEqual(['出貨查詢'])
    expect(impact.newlyBlocked[0]?.detail).toContain('全部攔截')
    expect(impact.newlyFreed).toEqual([])
    expect(impact.selfStillBlocked).toBeNull()
  })

  it('停掉那條蓋台的：講出誰會活過來', () => {
    const scripts = [
      script('a', '出貨查詢', ['出貨'], true),
      script('b', '全部攔截', ['出'], true),
    ]

    const impact = previewScriptToggleImpact(scripts, { id: 'b', enabled: false })

    expect(impact.newlyFreed.map(i => i.scriptName)).toEqual(['出貨查詢'])
    expect(impact.newlyBlocked).toEqual([])
  })

  it('🔴 開了也輪不到要先講出來（開了等於沒開）', () => {
    const scripts = [
      script('a', '全部攔截', ['出'], true),
      script('b', '出貨查詢', ['出貨'], false),
    ]

    const impact = previewScriptToggleImpact(scripts, { id: 'b', enabled: true })

    expect(impact.selfStillBlocked?.scriptName).toBe('出貨查詢')
    expect(impact.selfStillBlocked?.detail).toContain('全部攔截')
  })

  it('停用的時候不問「它自己輪不輪得到」——那不是問題，是你的選擇', () => {
    const scripts = [script('a', '出貨查詢', [], true)] // 沒有觸發詞＝本來就輪不到
    expect(previewScriptToggleImpact(scripts, { id: 'a', enabled: false }).selfStillBlocked).toBeNull()
  })

  it('🔴 用「編輯中還沒存檔」的觸發詞算：放寬觸發詞＋同時啟用，最需要這個警告', () => {
    const scripts = [
      script('a', '出貨查詢', ['出貨'], true),
      script('b', '全部攔截', ['退貨'], false), // 資料庫裡還是舊的窄關鍵字
    ]
    // 使用者在編輯器裡把它放寬成「出」並同時啟用，還沒存檔
    const broadened = [{ id: 'n1', type: 'trigger', keywords: ['出'], matchMode: 'keyword' } as any]

    const stale = previewScriptToggleImpact(scripts, { id: 'b', enabled: true })
    expect(stale.newlyBlocked).toEqual([]) // 拿舊內容算＝看不到任何影響（就是那個 bug）

    const fresh = previewScriptToggleImpact(scripts, { id: 'b', enabled: true, nodes: broadened, rootNodeId: 'n1' })
    expect(fresh.newlyBlocked.map(i => i.scriptName)).toEqual(['出貨查詢'])
  })

  it('互不相干的流程：沒有影響就是沒有影響（⛔不要硬生出一句警告）', () => {
    const scripts = [
      script('a', '出貨查詢', ['出貨'], true),
      script('b', '退貨流程', ['退貨'], false),
    ]

    const impact = previewScriptToggleImpact(scripts, { id: 'b', enabled: true })

    expect(impact.newlyBlocked).toEqual([])
    expect(impact.newlyFreed).toEqual([])
    expect(impact.selfStillBlocked).toBeNull()
  })

  it('敏感情境詞蓋住的也算：開了照樣輪不到', () => {
    const scripts = [script('a', '退款流程', ['退款'], false)]

    const impact = previewScriptToggleImpact(scripts, { id: 'a', enabled: true }, { sensitiveTopics: ['退款'] })

    expect(impact.selfStillBlocked?.reason).toBe('sensitiveTopic')
  })

  it('⛔ 轉換時要留住停用的那些：濾掉的話目標流程根本不在清單裡', () => {
    const rows = [
      { id: 'a', name: '開著的', enabled: true, rootNodeId: 'n1', nodes: [] },
      { id: 'b', name: '關著的', enabled: false, rootNodeId: 'n1', nodes: [] },
    ]
    expect(toReachabilityScriptsWithDisabled(rows).map(s => s.id)).toEqual(['a', 'b'])
  })
})
