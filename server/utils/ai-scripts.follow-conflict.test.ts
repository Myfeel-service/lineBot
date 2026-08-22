/**
 * 「一個工作區只能有一條啟用中的加好友腳本」存檔防呆（C-56）。
 * follow 事件沒有內容可分流，兩條並存＝客人一加好友被兩條各接一次，
 * 所以 create / put 存檔時要用這支找衝突、找到就 409。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({ FieldValue: {} }))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('./tagging', () => ({ addTagsToUser: vi.fn() }))

import { findEnabledFollowScriptConflict } from './ai-scripts'
import { normalizeScriptInput } from './ai-script-validation'

const WS = 'ws1'

function followDoc(name: string) {
  return {
    workspaceId: WS, name, enabled: true, priority: 50, rootNodeId: 't',
    nodes: [
      { id: 't', type: 'trigger', triggerEvent: 'follow', keywords: [], priority: 50, next: 'r' },
      { id: 'r', type: 'reply', text: '歡迎', thenHandoff: false },
    ],
  }
}

function messageDoc(name: string) {
  return {
    workspaceId: WS, name, enabled: true, priority: 50, rootNodeId: 't',
    nodes: [
      { id: 't', type: 'trigger', keywords: ['退貨'], priority: 50, next: 'r' },
      { id: 'r', type: 'reply', text: 'ok', thenHandoff: false },
    ],
  }
}

function fakeDb(docs: Array<{ id: string; data: Record<string, unknown> }>) {
  const q: any = {
    where: vi.fn(() => q),
    get: vi.fn(async () => ({ docs: docs.map(d => ({ id: d.id, data: () => d.data })) })),
  }
  return { collection: vi.fn(() => q) } as any
}

describe('findEnabledFollowScriptConflict', () => {
  it('已有另一條啟用中的加好友腳本 → 回它的名字（存檔端據此 409）', async () => {
    const db = fakeDb([{ id: 'a', data: followDoc('歡迎新朋友') }, { id: 'b', data: messageDoc('退換貨') }])
    expect(await findEnabledFollowScriptConflict(WS, undefined, db)).toEqual({ id: 'a', name: '歡迎新朋友' })
  })

  it('改的是同一條（excludeScriptId）→ 不算衝突，自己當然可以存自己', async () => {
    const db = fakeDb([{ id: 'a', data: followDoc('歡迎新朋友') }])
    expect(await findEnabledFollowScriptConflict(WS, 'a', db)).toBeNull()
  })

  it('只有訊息型腳本 → 沒有衝突', async () => {
    const db = fakeDb([{ id: 'b', data: messageDoc('退換貨') }, { id: 'c', data: messageDoc('預約') }])
    expect(await findEnabledFollowScriptConflict(WS, undefined, db)).toBeNull()
  })
})

describe('normalizeScriptInput：follow 觸發的存檔收斂', () => {
  it('follow 腳本存檔時清空關鍵字/範例/anyText（殘留值會污染「誰蓋住誰」的健康檢查）', () => {
    const input = normalizeScriptInput({
      name: '歡迎', enabled: true, priority: 50, rootNodeId: 't',
      nodes: [
        // 模擬編輯器從「關鍵字 anyText」切到「加好友時」後直接存檔的最髒狀態
        { id: 't', type: 'trigger', triggerEvent: 'follow', matchMode: 'semantic', keywordMatch: 'anyText', keywords: ['退貨'], examples: ['嗨'], priority: 50, next: 'r', cooldownMs: 60_000 },
        { id: 'r', type: 'reply', text: '歡迎', thenHandoff: false },
      ],
    })
    const trig = input.nodes.find(n => n.type === 'trigger') as any
    expect(trig.triggerEvent).toBe('follow')
    expect(trig.keywords).toEqual([])
    expect(trig.examples).toBeUndefined()
    expect(trig.keywordMatch).toBe('any') // anyText 殘留被重設，別留一顆「攔截全部」的地雷
    expect(trig.cooldownMs).toBe(60_000) // 冷卻保留：封鎖又解除的防重複要用
  })

  it('沒標 follow 的觸發不受影響（關鍵字照收）', () => {
    const input = normalizeScriptInput({
      name: '退換貨', enabled: true, priority: 50, rootNodeId: 't',
      nodes: [
        { id: 't', type: 'trigger', keywords: ['退貨'], priority: 50, next: 'r' },
        { id: 'r', type: 'reply', text: 'ok', thenHandoff: false },
      ],
    })
    const trig = input.nodes.find(n => n.type === 'trigger') as any
    expect(trig.triggerEvent).toBeUndefined()
    expect(trig.keywords).toEqual(['退貨'])
  })
})
