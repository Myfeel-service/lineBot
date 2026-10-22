import { describe, expect, it } from 'vitest'
import { pickScriptByKeyword, routeCandidates, sortByPriority } from './script-match'
import type { ScriptDoc, ScriptTriggerNode } from '~~/shared/types/ai-script'

/**
 * 一句話要交給哪一條自動回應（`D-138`）：正式回客人、測試對話頁、自動回應頁的試試看共用這一份。
 */
function row(id: string, trigger: Partial<ScriptTriggerNode>, priority = 50): ScriptDoc & { id: string } {
  return {
    id,
    workspaceId: 'w1',
    name: id,
    enabled: true,
    priority,
    rootNodeId: 't',
    nodes: [
      { id: 't', type: 'trigger', keywords: [], priority, next: 'r', ...trigger } as ScriptTriggerNode,
      { id: 'r', type: 'reply', text: 'ok', thenHandoff: false },
    ],
    createdAt: null as any,
    updatedAt: null as any,
  }
}

describe('pickScriptByKeyword', () => {
  it('「客人打特定的字」照比對方式比，講得出是哪個字', () => {
    const exact = row('抽獎', { matchMode: 'keyword', keywordMatch: 'exact', keywords: ['抽獎'] })
    expect(pickScriptByKeyword([exact], '抽獎')?.keyword).toBe('抽獎')
    expect(pickScriptByKeyword([exact], '我要抽獎')).toBeNull()
  })

  it('⛔「AI 判斷」那種不看字（`C-370`）：舊資料殘留的「訂單」不會把「保留訂單」直接接走，交給 AI 看意思', () => {
    const order = row('查詢訂單', { matchMode: 'semantic', keywords: ['訂單', '查詢', '進度'], examples: ['我想查訂單'] })
    expect(pickScriptByKeyword([order], '決定不退貨，請幫我保留訂單')).toBeNull()
    expect(pickScriptByKeyword([order], '我想查訂單')).toBeNull() // 連明確的也不看字：交給 AI 判斷
  })

  it('⛔「AI 判斷」那種殘留 anyText 也不會攔下所有訊息', () => {
    const odd = row('怪', { matchMode: 'semantic', keywordMatch: 'anyText', examples: ['我想查訂單'] })
    expect(pickScriptByKeyword([odd], '隨便打一句')).toBeNull()
  })

  it('加好友時那種任何文字都不接', () => {
    const follow = row('歡迎', { triggerEvent: 'follow', keywordMatch: 'anyText' })
    expect(pickScriptByKeyword([follow], '哈囉')).toBeNull()
  })

  it('照傳進來的順序（已依優先度排好）取第一條', () => {
    const a = row('a', { matchMode: 'keyword', keywords: ['退貨'] }, 80)
    const b = row('b', { matchMode: 'keyword', keywords: ['退'] }, 50)
    expect(pickScriptByKeyword([a, b], '我要退貨')?.script.id).toBe('a')
  })
})

describe('sortByPriority（正式與試試看共用的先後，`C-379`）', () => {
  it('優先度高的先；一樣高照文件編號大的先（同 Firestore orderBy priority desc 的隱含排法）', () => {
    const rows = [row('Aaa', {}, 50), row('Ccc', {}, 50), row('Bbb', {}, 80), row('Bzz', {}, 50)]
    expect(sortByPriority(rows).map(r => r.id)).toEqual(['Bbb', 'Ccc', 'Bzz', 'Aaa'])
  })

  it('不改傳進來的那一份', () => {
    const rows = [row('Aaa', {}, 50), row('Bbb', {}, 80)]
    sortByPriority(rows)
    expect(rows.map(r => r.id)).toEqual(['Aaa', 'Bbb'])
  })
})

describe('routeCandidates（交給 AI 判斷的候選）', () => {
  it('⛔ 只有「AI 判斷」那種；「客人打特定的字」那種不會被用意思挑走（`D-138`①）', () => {
    const kw = row('客服選單', { matchMode: 'keyword', keywords: ['客服選單'] })
    // 提示只給「客人會這樣講」與「不要接」：殘留的字（訂單）不再當提示（`C-370`）
    const meaning = row('查詢訂單', { matchMode: 'semantic', keywords: ['訂單'], examples: ['我想查訂單', '我的訂單進度'], excludes: ['什麼時候出貨'] })
    const follow = row('歡迎', { triggerEvent: 'follow', matchMode: 'semantic' })
    expect(routeCandidates([kw, meaning, follow])).toEqual([
      { id: '查詢訂單', name: '查詢訂單', hints: ['我想查訂單', '我的訂單進度'], excludes: ['什麼時候出貨'] },
    ])
  })

  it('沒有「AI 判斷」那種就是空的（呼叫端不叫路由）', () => {
    expect(routeCandidates([row('a', { matchMode: 'keyword', keywords: ['退貨'] })])).toEqual([])
  })
})
