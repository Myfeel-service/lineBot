import { describe, expect, it, vi } from 'vitest'
import { scanConfigReferences } from './config-references'
import { encodeTriggerModule } from '~~/shared/action-schema'

/**
 * 假 Firestore：六個被掃的集合各回一批文件。
 * `failing` 裡的集合會丟例外——那條路是本檔最重要的一組斷言（三態）。
 */
function makeDb(
  data: Partial<Record<string, any[]>>,
  failing: string[] = [],
) {
  return {
    collection: (col: string) => ({
      where: () => ({
        limit: () => ({
          get: vi.fn(async () => {
            if (failing.includes(col)) throw new Error(`boom: ${col}`)
            return { docs: (data[col] ?? []).map(x => ({ id: x.id, data: () => x })) }
          }),
        }),
      }),
    }),
  } as any
}

let seq = 0
const freshWs = () => `ws-${++seq}` // ⛔ 每個 case 用不同 workspaceId，否則會吃到上一個 case 的快取

/** 取某個 id 的引用清單；查無回空陣列（讓斷言在「根本沒記到」時就失敗，而不是型別錯誤） */
const refsOf = (index: Record<string, { kind: string; label: string; inactive?: boolean }[]>, id: string) =>
  index[id] ?? []

describe('scanConfigReferences', () => {
  it('模組：自動回應與圖文選單指向它，兩筆都要列出來', async () => {
    const ws = freshWs()
    const db = makeDb({
      flows: [{ id: 'm1', workspaceId: ws, name: '查詢訂單', isActive: true, messages: [] }],
      richmenus: [{ id: 'r1', workspaceId: ws, name: '主選單', areas: [{ action: { data: encodeTriggerModule('m1') } }] }],
      scripts: [{ id: 's1', workspaceId: ws, name: '關鍵字：訂單', nodes: [{ type: 'module', moduleId: 'm1' }] }],
    })
    const index = await scanConfigReferences(db, ws)
    expect(refsOf(index.modules, 'm1').map(r => r.kind).sort()).toEqual(['richmenu', 'script'])
    expect(refsOf(index.modules, 'm1').find(r => r.kind === 'script')?.label).toBe('關鍵字：訂單')
    expect(index.failedKinds).toEqual([])
  })

  it('⛔ 模組指回自己不算「有人會叫出它」', async () => {
    const ws = freshWs()
    const db = makeDb({
      flows: [{
        id: 'm1',
        workspaceId: ws,
        name: '自我引用',
        messages: [{ actions: [{ type: 'module', moduleId: 'm1' }] }],
      }],
    })
    const index = await scanConfigReferences(db, ws)
    expect(index.modules.m1).toBeUndefined()
  })

  it('標籤：模組按鈕貼的、活動貼的、推播拿去挑人的，都要算', async () => {
    const ws = freshWs()
    const db = makeDb({
      flows: [{
        id: 'm1',
        workspaceId: ws,
        name: '歡迎',
        messages: [{ actions: [{ type: 'message', tagging: { enabled: true, addTagIds: ['t1'] } }] }],
      }],
      leadCampaigns: [{ id: 'c1', workspaceId: ws, name: '問卷', isActive: true, tagIds: ['t1', 't2'] }],
      broadcasts: [{ id: 'b1', workspaceId: ws, name: '開賣', status: 'draft', audienceSource: { type: 'tags', tagIds: ['t2'] } }],
    })
    const index = await scanConfigReferences(db, ws)
    expect(refsOf(index.tags, 't1').map(r => r.kind).sort()).toEqual(['campaign', 'flow'])
    expect(refsOf(index.tags, 't2').map(r => r.kind).sort()).toEqual(['broadcast', 'campaign'])
  })

  it('停用中的設定要標 inactive（不是濾掉——回頭按發送的人還是會用到）', async () => {
    const ws = freshWs()
    const db = makeDb({
      leadCampaigns: [{ id: 'c1', workspaceId: ws, name: '舊活動', isActive: false, tagIds: ['t1'] }],
      broadcasts: [{ id: 'b1', workspaceId: ws, name: '已發完', status: 'completed', audienceSource: { type: 'tags', tagIds: ['t1'] } }],
    })
    const index = await scanConfigReferences(db, ws)
    expect(refsOf(index.tags, 't1')).toHaveLength(2)
    expect(refsOf(index.tags, 't1').every(r => r.inactive)).toBe(true)
  })

  it('`C-422` ⑥ 關掉的自動回應、活動、取消的推播標 closed（帶不了客人進來）；⛔ 發完的推播、停用的模組不標（按鈕已經在客人聊天室）', async () => {
    const ws = freshWs()
    const to = (id: string) => [{ type: 'module', moduleId: id }]
    const db = makeDb({
      flows: [{ id: 'f-off', workspaceId: ws, name: '停用的模組', isActive: false, messages: [{ actions: to('m1') }] }],
      scripts: [{ id: 's-off', workspaceId: ws, name: '關掉的自動回應', enabled: false, nodes: to('m1') }],
      leadCampaigns: [{ id: 'c-off', workspaceId: ws, name: '關掉的活動', isActive: false, moduleId: 'm1', action: to('m1') }],
      broadcasts: [
        { id: 'b-sent', workspaceId: ws, name: '發完了', status: 'completed', content: to('m1') },
        { id: 'b-cancel', workspaceId: ws, name: '取消了', status: 'cancelled', content: to('m1') },
        { id: 'b-failed', workspaceId: ws, name: '失敗（可能送出一部分）', status: 'failed', content: to('m1') },
      ],
    })
    const index = await scanConfigReferences(db, ws)
    const closed = Object.fromEntries(refsOf(index.modules, 'm1').map(r => [(r as any).id, !!(r as any).closed]))
    expect(closed).toEqual({ 'f-off': false, 's-off': true, 'c-off': true, 'b-sent': false, 'b-cancel': true, 'b-failed': false })
  })

  it('`C-422` ② 舊版圖文訊息：模組只存 id，上面的按鈕要算成「那個模組叫得出它」', async () => {
    const ws = freshWs()
    const db = makeDb({
      flows: [{ id: 'f1', workspaceId: ws, name: '商品目錄', messages: [{ type: 'richMessageRef', richMessageId: 'rm1' }] }],
      richMessages: [{ id: 'rm1', workspaceId: ws, actions: [{ slot: 'A', type: 'module', moduleId: 'm-detail' }, { slot: 'B', type: 'uri', uri: 'https://a' }] }],
    })
    const index = await scanConfigReferences(db, ws)
    expect(refsOf(index.modules, 'm-detail').map(r => (r as any).id)).toEqual(['f1'])
    expect(index.failedKinds).toEqual([])
  })

  it('⛔ `C-422` ② 對照組：圖文訊息那份查不到＝用到它的那一類講不準，進 failedKinds（不可以講成走不到）', async () => {
    const ws = freshWs()
    const db = makeDb({
      flows: [{ id: 'f1', workspaceId: ws, name: '商品目錄', messages: [{ type: 'richMessageRef', richMessageId: 'rm1' }] }],
    }, ['richMessages'])
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const index = await scanConfigReferences(db, ws)
    err.mockRestore()
    expect(index.failedKinds).toEqual(['flow'])
  })

  it('圖文訊息查不到、但沒有人用舊版圖文訊息＝不影響（照常算）', async () => {
    const ws = freshWs()
    const db = makeDb({ flows: [{ id: 'f1', workspaceId: ws, name: 'A', messages: [{ actions: [{ type: 'module', moduleId: 'm1' }] }] }] }, ['richMessages'])
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const index = await scanConfigReferences(db, ws)
    err.mockRestore()
    expect(index.failedKinds).toEqual([])
    expect(refsOf(index.modules, 'm1')).toHaveLength(1)
  })

  it('⛔ 三態：某一類查不到要進 failedKinds，不可以當成「沒有人用」', async () => {
    const ws = freshWs()
    const db = makeDb(
      { flows: [{ id: 'm1', workspaceId: ws, name: 'A', messages: [] }] },
      ['richmenus', 'leadCampaigns'],
    )
    const index = await scanConfigReferences(db, ws)
    expect(index.failedKinds.sort()).toEqual(['campaign', 'richmenu'])
  })

  it('全部查不到時，六類都要進 failedKinds（畫面才講得出「這次什麼都沒查到」）', async () => {
    const ws = freshWs()
    const db = makeDb({}, ['flows', 'richmenus', 'scripts', 'leadCampaigns', 'broadcasts', 'supportPresets'])
    const index = await scanConfigReferences(db, ws)
    expect(index.failedKinds).toHaveLength(6)
    expect(index.modules).toEqual({})
  })

  it('同一個來源對同一個目標只記一次（一張選單兩格指向同一個模組）', async () => {
    const ws = freshWs()
    const db = makeDb({
      richmenus: [{
        id: 'r1',
        workspaceId: ws,
        name: '主選單',
        areas: [
          { action: { data: encodeTriggerModule('m1') } },
          { action: { data: encodeTriggerModule('m1') } },
        ],
      }],
    })
    const index = await scanConfigReferences(db, ws)
    expect(refsOf(index.modules, 'm1')).toHaveLength(1)
  })

  it('快取：同一個工作區連問兩次只掃一輪；帶 skipCache 會重掃', async () => {
    const ws = freshWs()
    let calls = 0
    const db = {
      collection: () => ({
        where: () => ({
          limit: () => ({
            get: vi.fn(async () => { calls += 1; return { docs: [] } }),
          }),
        }),
      }),
    } as any
    await scanConfigReferences(db, ws)
    const afterFirst = calls
    await scanConfigReferences(db, ws)
    expect(calls).toBe(afterFirst) // 第二次全走快取
    await scanConfigReferences(db, ws, { skipCache: true })
    expect(calls).toBe(afterFirst * 2)
  })
})
