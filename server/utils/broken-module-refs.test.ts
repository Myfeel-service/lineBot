import { beforeEach, describe, expect, it, vi } from 'vitest'
import { collectModuleRefs, findBrokenModuleRefs, invalidateBrokenModuleRefsCache, replaceModuleRefs, scanModuleGraph } from './broken-module-refs'

const WS = 'ws1'

describe('collectModuleRefs(深掃任意結構找模組引用)', () => {
  it('認得已編碼的 postback 字串(圖文選單存這個)', () => {
    const areas = [{ action: { type: 'postback', data: 'triggerModule=mod-a&tags=t1,t2' } }]
    expect([...collectModuleRefs(areas)]).toEqual(['mod-a'])
  })

  it('認得未編碼的動作物件(模組訊息存這個)', () => {
    const messages = [{ actions: [{ type: 'module', moduleId: 'mod-b' }] }]
    expect([...collectModuleRefs(messages)]).toEqual(['mod-b'])
  })

  it('藏在深層結構裡也要找到(輪播欄/imagemap 區塊/quick reply)', () => {
    const messages = [{
      type: 'flex',
      contents: {
        type: 'carousel',
        columns: [
          { footer: { contents: [{ action: { type: 'module', moduleId: 'deep-1' } }] } },
          { areas: [{ action: { type: 'postback', data: 'triggerModule=deep-2' } }] },
        ],
      },
      quickReply: { items: [{ action: { type: 'module', moduleId: 'deep-3' } }] },
    }]
    expect([...collectModuleRefs(messages)].sort()).toEqual(['deep-1', 'deep-2', 'deep-3'])
  })

  it('沒有模組引用就回空,不會把別種 action 誤認', () => {
    const areas = [
      { action: { type: 'uri', uri: 'https://example.com' } },
      { action: { type: 'postback', data: 'switchMenu=menu-1' } },
      { action: { type: 'message', text: '你好' } },
    ]
    expect([...collectModuleRefs(areas)]).toEqual([])
  })

  it('空的 moduleId 不算引用', () => {
    expect([...collectModuleRefs([{ action: { type: 'module', moduleId: '  ' } }])]).toEqual([])
    expect([...collectModuleRefs(['triggerModule='])]).toEqual([])
  })

  it('null / undefined / 數字不會炸', () => {
    expect([...collectModuleRefs(null)]).toEqual([])
    expect([...collectModuleRefs(undefined)]).toEqual([])
    expect([...collectModuleRefs([1, true, null, { a: undefined }])]).toEqual([])
  })
})

/** 假 Firestore：四個被掃的集合各回一批文件 */
function makeDb(flows: any[], menus: any[], scripts: any[] = [], campaigns: any[] = []) {
  const byCol: Record<string, any[]> = { flows, richmenus: menus, scripts, leadCampaigns: campaigns }
  const toDocs = (arr: any[]) => arr.map(x => ({ id: x.id, data: () => x }))
  return {
    collection: (col: string) => ({
      where: () => ({
        get: vi.fn(async () => ({
          docs: toDocs(byCol[col] ?? []),
        })),
      }),
    }),
  } as any
}

describe('findBrokenModuleRefs(空按鈕靜態檢查)', () => {
  beforeEach(() => { invalidateBrokenModuleRefsCache(WS) })

  it('指向已停用的模組 → 報 inactive', async () => {
    const db = makeDb(
      [{ id: 'mod-a', name: '舊活動', isActive: false }],
      [{ id: 'menu-1', name: '主選單', areas: [{ action: { data: 'triggerModule=mod-a' } }] }],
    )
    const broken = await findBrokenModuleRefs(db, WS)
    expect(broken).toEqual([{
      moduleId: 'mod-a', sourceLabel: '主選單', sourceKind: 'richmenu', reason: 'inactive',
    }])
  })

  it('指向已刪除的模組 → 報 missing', async () => {
    const db = makeDb(
      [],
      [{ id: 'menu-1', name: '主選單', areas: [{ action: { data: 'triggerModule=gone' } }] }],
    )
    const broken = await findBrokenModuleRefs(db, WS)
    expect(broken[0]!.reason).toBe('missing')
  })

  it('模組正常啟用 → 沒有異常', async () => {
    const db = makeDb(
      [{ id: 'mod-a', name: '常見問題', isActive: true }],
      [{ id: 'menu-1', name: '主選單', areas: [{ action: { data: 'triggerModule=mod-a' } }] }],
    )
    expect(await findBrokenModuleRefs(db, WS)).toEqual([])
  })

  it('模組訊息裡的按鈕也會查(不只圖文選單)', async () => {
    const db = makeDb(
      [
        { id: 'mod-a', name: '產品卡', isActive: true, messages: [{ actions: [{ type: 'module', moduleId: 'mod-b' }] }] },
        { id: 'mod-b', name: '規格說明', isActive: false },
      ],
      [],
    )
    const broken = await findBrokenModuleRefs(db, WS)
    expect(broken).toHaveLength(1)
    expect(broken[0]).toMatchObject({ moduleId: 'mod-b', sourceLabel: '產品卡', sourceKind: 'flow' })
  })

  it('同一個壞模組被兩處引用 → 各報一筆(要修的地方不只一個)', async () => {
    const db = makeDb(
      [{ id: 'mod-x', name: '壞的', isActive: false }],
      [
        { id: 'm1', name: '選單A', areas: [{ action: { data: 'triggerModule=mod-x' } }] },
        { id: 'm2', name: '選單B', areas: [{ action: { data: 'triggerModule=mod-x' } }] },
      ],
    )
    const broken = await findBrokenModuleRefs(db, WS)
    expect(broken.map(b => b.sourceLabel).sort()).toEqual(['選單A', '選單B'])
  })

  it('同一處重複引用同一個壞模組 → 只報一筆(不要洗版)', async () => {
    const db = makeDb(
      [{ id: 'mod-x', name: '壞的', isActive: false }],
      [{
        id: 'm1',
        name: '選單A',
        areas: [
          { action: { data: 'triggerModule=mod-x' } },
          { action: { data: 'triggerModule=mod-x' } },
        ],
      }],
    )
    expect(await findBrokenModuleRefs(db, WS)).toHaveLength(1)
  })

  it('模組指回自己不算壞(編輯中可能短暫出現)', async () => {
    const db = makeDb(
      [{ id: 'mod-a', name: '自我引用', isActive: false, messages: [{ actions: [{ type: 'module', moduleId: 'mod-a' }] }] }],
      [],
    )
    expect(await findBrokenModuleRefs(db, WS)).toEqual([])
  })

  it('isActive 未設定視為停用(與 getFlowByModuleId 同一把尺)', async () => {
    const db = makeDb(
      [{ id: 'mod-a', name: '沒設旗標' }],
      [{ id: 'menu-1', name: '主選單', areas: [{ action: { data: 'triggerModule=mod-a' } }] }],
    )
    expect(await findBrokenModuleRefs(db, WS)).toHaveLength(1)
  })

  it('腳本的「機器人模組」步驟指向壞模組也會查(停用中的腳本不算)', async () => {
    const db = makeDb(
      [{ id: 'mod-a', name: '壞的', isActive: false }],
      [],
      [
        { id: 's1', name: '查詢運費', enabled: true, nodes: [
          { id: 't', type: 'trigger', keywords: ['運費'], next: 'm' },
          { id: 'm', type: 'module', moduleId: 'mod-a' },
        ] },
        { id: 's2', name: '停用的腳本', enabled: false, nodes: [
          { id: 'm', type: 'module', moduleId: 'mod-a' },
        ] },
      ],
    )
    const broken = await findBrokenModuleRefs(db, WS)
    expect(broken).toEqual([{
      moduleId: 'mod-a', sourceLabel: '查詢運費', sourceKind: 'script', reason: 'inactive',
    }])
  })

  it('活動指向已刪模組也會查(頂層 moduleId)', async () => {
    const db = makeDb([], [], [], [{ id: 'c1', name: '週年慶', isActive: true, moduleId: 'gone' }])
    const broken = await findBrokenModuleRefs(db, WS)
    expect(broken).toEqual([{
      moduleId: 'gone', sourceLabel: '週年慶', sourceKind: 'campaign', reason: 'missing',
    }])
  })

  it('第二次呼叫走快取,不再打資料庫(這支端點會被輪詢)', async () => {
    const flows = [{ id: 'mod-a', name: '壞的', isActive: false }]
    const menus = [{ id: 'm1', name: '選單A', areas: [{ action: { data: 'triggerModule=mod-a' } }] }]
    let getCalls = 0
    const db = {
      collection: (col: string) => ({
        where: () => ({
          get: vi.fn(async () => {
            getCalls++
            const rows = col === 'flows' ? flows : col === 'richmenus' ? menus : []
            return { docs: rows.map(x => ({ id: x.id, data: () => x })) }
          }),
        }),
      }),
    } as any

    // 一輪掃四個集合（flows / richmenus / scripts / leadCampaigns）
    await findBrokenModuleRefs(db, WS)
    expect(getCalls).toBe(4)
    await findBrokenModuleRefs(db, WS)
    expect(getCalls).toBe(4)

    // 存檔後要能立刻反映
    invalidateBrokenModuleRefsCache(WS)
    await findBrokenModuleRefs(db, WS)
    expect(getCalls).toBe(8)
  })
})

describe('replaceModuleRefs(壞按鈕整批改指向，C-87)', () => {
  it('已編碼的 postback 字串：換 id、tags 原樣保留', () => {
    const areas = [{ action: { type: 'postback', data: 'triggerModule=dead&tags=t1,t2' } }]
    const r = replaceModuleRefs(areas, 'dead', 'alive')
    expect(r.changed).toBe(true)
    const data = (r.value as any)[0].action.data as string
    expect(data.startsWith('triggerModule=alive')).toBe(true)
    expect(data).toContain('tags=')
    // 改完要能被同一套 parser 讀回來——編碼器與解析器不成對就是新的壞按鈕
    expect([...collectModuleRefs(r.value)]).toEqual(['alive'])
  })

  it('未編碼的動作物件與深層結構都改得到（找得到的就要改得掉）', () => {
    const messages = [{
      contents: { columns: [{ footer: { contents: [{ action: { type: 'module', moduleId: 'dead' } }] } }] },
    }]
    const r = replaceModuleRefs(messages, 'dead', 'alive')
    expect(r.changed).toBe(true)
    expect([...collectModuleRefs(r.value)]).toEqual(['alive'])
  })

  it('沒有命中就原樣回傳（changed=false，呼叫端可跳過整筆寫入）', () => {
    const messages = [{ actions: [{ type: 'module', moduleId: 'other' }] }]
    const r = replaceModuleRefs(messages, 'dead', 'alive')
    expect(r.changed).toBe(false)
    expect(r.value).toBe(messages)
  })

  it('別的模組 id 不能被誤傷（只換完全相同的那顆）', () => {
    const mixed = [
      { action: { type: 'postback', data: 'triggerModule=dead' } },
      { action: { type: 'module', moduleId: 'dead-2' } },
    ]
    const r = replaceModuleRefs(mixed, 'dead', 'alive')
    expect(r.changed).toBe(true)
    expect([...collectModuleRefs(r.value)].sort()).toEqual(['alive', 'dead-2'])
  })
})

describe('scanModuleGraph：引用與模組清單來自同一次掃描（2026-08-27 review）', () => {
  it('modules 含全部模組（不截斷）且帶 isActive，refs 與它對得上', async () => {
    // 250 個模組：舊版 GET 另外查一趟帶 limit(200)，模組多的工作區會挑不到要指過去的那個
    const flows = Array.from({ length: 250 }, (_, i) => ({
      id: `mod-${i}`,
      // 最後一個模組指向一顆已刪除的模組 → 應該被報為壞掉
      data: (): Record<string, unknown> => ({
        workspaceId: WS,
        name: `模組${i}`,
        isActive: true,
        messages: i === 249 ? [{ actions: [{ type: 'module', moduleId: 'gone' }] }] : [],
      }),
    }))
    const db = {
      collection: (name: string) => ({
        where: () => ({
          get: async () => ({ docs: name === 'flows' ? flows : [] }),
          where: () => ({ get: async () => ({ docs: [] }) }),
          select: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }),
        }),
      }),
    } as any

    invalidateBrokenModuleRefsCache(WS)
    const scan = await scanModuleGraph(db, WS, { skipCache: true })
    expect(scan.modules).toHaveLength(250)
    expect(scan.modules.every(m => m.isActive)).toBe(true)
    expect(scan.refs.map(r => r.moduleId)).toEqual(['gone'])
    // 被指的模組查不到＝真的不存在，不是被 limit 切掉的
    expect(scan.modules.find(m => m.id === 'gone')).toBeUndefined()
  })
})
