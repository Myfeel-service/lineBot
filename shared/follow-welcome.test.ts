import { describe, expect, it } from 'vitest'
import {
  FOLLOW_WELCOME_UNSET_TEXT,
  buildFollowWelcomeScript,
  followWelcomeRow,
  validateFollowWelcome,
} from './follow-welcome'
import { scriptTriggerEvent, validateScriptDoc } from './types/ai-script'

describe('followWelcomeRow — 三態要分得開', () => {
  it('有一條啟用中的：講「正在用哪一條」', () => {
    const row = followWelcomeRow([{ enabled: true, name: '新朋友歡迎', triggerEvent: 'follow' }])
    expect(row.state).toBe('active')
    expect(row.meta).toContain('新朋友歡迎')
    expect(row.chipText).toBe('啟用')
  })

  it('⛔ 設了但停用：不可以講成「沒設定」（內容還在，他只要打開就好）', () => {
    const row = followWelcomeRow([{ enabled: false, name: '舊歡迎', triggerEvent: 'follow' }])
    expect(row.state).toBe('disabled')
    expect(row.meta).toContain('停用中')
    expect(row.meta).not.toContain('還沒設定')
    expect(row.chipTone).toBe('warning')
  })

  it('一條都沒有：要講出後果，不是只說「無」', () => {
    const row = followWelcomeRow([
      { enabled: true, name: '查訂單', triggerEvent: 'message' },
      { enabled: true, name: '退貨', triggerEvent: undefined },
    ])
    expect(row.state).toBe('unset')
    expect(row.meta).toBe(FOLLOW_WELCOME_UNSET_TEXT)
    expect(row.meta).toContain('不會收到任何訊息')
  })

  it('空清單也是「沒設定」，不會炸', () => {
    expect(followWelcomeRow([]).state).toBe('unset')
  })

  it('⛔ 啟用的優先於停用的（兩條都在時要講正在跑的那條）', () => {
    const row = followWelcomeRow([
      { enabled: false, name: '舊的', triggerEvent: 'follow' },
      { enabled: true, name: '新的', triggerEvent: 'follow' },
    ])
    expect(row.state).toBe('active')
    expect(row.meta).toContain('新的')
  })
})

describe('validateFollowWelcome', () => {
  it('選了模組才放行', () => {
    expect(validateFollowWelcome({ kind: 'module', moduleId: 'm1' })).toBeNull()
    expect(validateFollowWelcome({ kind: 'module', moduleId: '  ' })).toContain('模組')
  })

  it('打了字才放行', () => {
    expect(validateFollowWelcome({ kind: 'text', text: '歡迎！' })).toBeNull()
    expect(validateFollowWelcome({ kind: 'text', text: '   ' })).toContain('文字')
  })
})

describe('buildFollowWelcomeScript', () => {
  const ids = { triggerId: 't1', replyId: 'r1' }

  it('送模組：組出 觸發(follow) → module，而且 module 是終點', () => {
    const { nodes, rootNodeId } = buildFollowWelcomeScript({ kind: 'module', moduleId: 'm1' }, ids)
    expect(rootNodeId).toBe('t1')
    expect(nodes.map(n => n.type)).toEqual(['trigger', 'module'])
    expect(scriptTriggerEvent({ nodes, rootNodeId })).toBe('follow')
    expect((nodes[1] as any).moduleId).toBe('m1')
    expect((nodes[1] as any).next).toBeUndefined()
  })

  it('回文字：組出 觸發(follow) → reply，預設不轉真人', () => {
    const { nodes } = buildFollowWelcomeScript({ kind: 'text', text: ' 謝謝加入！ ' }, ids)
    expect(nodes.map(n => n.type)).toEqual(['trigger', 'reply'])
    expect((nodes[1] as any).text).toBe('謝謝加入！')
    expect((nodes[1] as any).thenHandoff).toBe(false)
  })

  it('⛔ 觸發節點的 keywords／examples 要留空（follow 時它們沒有意義）', () => {
    const { nodes } = buildFollowWelcomeScript({ kind: 'module', moduleId: 'm1' }, ids)
    expect((nodes[0] as any).keywords).toEqual([])
    expect((nodes[0] as any).examples).toEqual([])
  })

  it('⛔ 組出來的東西必須通過後端那支驗證（不然按了建立才失敗）', () => {
    for (const reply of [
      { kind: 'module', moduleId: 'm1' } as const,
      { kind: 'text', text: '哈囉' } as const,
    ]) {
      const { nodes, rootNodeId } = buildFollowWelcomeScript(reply, ids)
      expect(validateScriptDoc({ name: '加好友歡迎', nodes, rootNodeId })).toBeNull()
    }
  })
})
