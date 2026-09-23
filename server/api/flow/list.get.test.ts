import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 模組清單的兩件事（`E-23`）：
 *
 * ① `?fields=picker` 只回選單要的欄位——五個頁面只是要長一個「跳到哪個模組」的下拉選單，
 *    整份回去是 133 KB（含每個模組的每一則訊息）。
 * ② 系統模組齊全時**不要再逐筆確認一次**：原本每次列清單前都先 `doc().get()` 兩趟，
 *    等於每次都白等兩趟跨洋往返才開始真正的查詢。
 *
 * ⛔ 不帶參數時必須照舊回整份（機器人模組那頁的側欄點一下就要直接編輯，吃的是 `messages`）。
 */

const WS = 'ws1'

vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn(), listDocs: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireWorkspaceAccess: vi.fn(async () => ({ workspaceId: WS, role: 'owner' })),
}))
vi.mock('~~/server/utils/workspace-system-modules', async () => {
  const actual = await vi.importActual<typeof import('~~/server/utils/workspace-system-modules')>(
    '~~/server/utils/workspace-system-modules',
  )
  return { ...actual, seedWorkspaceSystemModules: vi.fn(async () => []) }
})

let currentQuery: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getQuery', () => currentQuery)
vi.stubGlobal('createError', (o: { statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'e'), o))

const { default: handler } = await import('./list.get')
const { listDocs, getDb } = await import('~~/server/utils/firebase')
const { seedWorkspaceSystemModules } = await import('~~/server/utils/workspace-system-modules')

/** 一個模組文件；`messages` 就是那個佔了 133 KB 的東西 */
const flow = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  workspaceId: WS,
  name: `模組 ${id}`,
  isActive: true,
  createdAt: { toMillis: () => 1 },
  messages: [{ type: 'text', text: '很長的訊息內容'.repeat(200) }],
  triggers: ['關鍵字'],
  ...extra,
})

const ALL = [
  flow(`${WS}_welcome`, { isSystem: true, moduleType: 'welcome' }),
  flow(`${WS}_live_agent`, { isSystem: true, moduleType: 'live_agent' }),
  flow('flow-a'),
  flow('flow-b'),
]

/** 假 listDocs：記下有沒有被投影，並照投影裁欄位（＝正式 Firestore 的行為） */
function stubListDocs(rows = ALL) {
  const selects: string[][] = []
  vi.mocked(listDocs).mockImplementation((async (_col: string, queryFn?: (ref: unknown) => unknown) => {
    let selected: string[] = []
    const q: any = {
      where: () => q,
      orderBy: () => q,
      select: (...f: string[]) => { selected = f; selects.push(f); return q },
    }
    queryFn?.(q)
    if (!selected.length) return rows
    return rows.map((r) => {
      const out: Record<string, unknown> = { id: r.id }
      for (const f of selected) if (f in r) out[f] = (r as Record<string, unknown>)[f]
      return out
    })
  }) as never)
  return selects
}

describe('模組清單（E-23）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    currentQuery = {}
    /**
     * `getDb` 只剩補建系統模組會用到。
     * ⚠️ 這裡刻意給一個「呼叫 `doc()` 就炸」的假物件：`D-86` 起清單自己就答得出
     * 「歡迎模組是不是空的」，⛔ 任何人再加回那趟額外讀取，測試會當場紅而不是安靜地多花一趟。
     */
    vi.mocked(getDb).mockReturnValue({
      collection: () => ({ doc: () => { throw new Error('不該再為了歡迎模組多讀一次文件') } }),
    } as never)
  })

  it('?fields=picker：回得了名稱與啟用狀態，但**不帶訊息內容**', async () => {
    stubListDocs()
    currentQuery = { fields: 'picker' }

    const list = await (handler as any)({} as never) as Record<string, unknown>[]

    expect(list).toHaveLength(4)
    // 選單要的欄位都在
    expect(list[0]!.id).toBe(`${WS}_welcome`)
    expect(list[0]!.name).toBe(`模組 ${WS}_welcome`)
    expect(list[0]!.isActive).toBe(true)
    // 這一行紅掉＝又把 133 KB 的訊息內容搬回前端了
    for (const item of list) expect(item.messages).toBeUndefined()
  })

  /**
   * `D-86`：下拉要標得出「這個模組還沒有內容」。
   * ⛔ 這一組的重點是「**數得出來、但內容不可以跟著回去**」——
   *    只驗 `messageCount` 而不驗 `messages` 不見了，就會漏掉「為了數一數把 133 KB 搬回前端」。
   */
  it('?fields=picker：回得出「幾則訊息」，但內容還是不准跟著回去', async () => {
    stubListDocs([
      flow('flow-a'), // fixture 預設一則
      flow('flow-空', { messages: [] }),
      flow('flow-兩則', { messages: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }),
      flow('flow-沒有這個欄位', { messages: undefined }),
    ])
    currentQuery = { fields: 'picker' }

    const list = await (handler as any)({} as never) as Record<string, unknown>[]
    const byId = Object.fromEntries(list.map(f => [f.id, f]))

    expect(byId['flow-a']!.messageCount).toBe(1)
    expect(byId['flow-空']!.messageCount).toBe(0)
    expect(byId['flow-兩則']!.messageCount).toBe(2)
    // 欄位根本不存在的舊資料也要有數字，⛔ 不可以是 undefined（下拉會判斷不出來而靜靜跳過）
    expect(byId['flow-沒有這個欄位']!.messageCount).toBe(0)
    for (const item of list) expect(item.messages).toBeUndefined()
  })

  it('沒帶參數時不加 messageCount（那頁吃的是 messages 本身，不要多長一個欄位出來）', async () => {
    stubListDocs()

    const list = await (handler as any)({} as never) as Record<string, unknown>[]

    expect(list[0]!.messageCount).toBeUndefined()
    expect(list[0]!.taggedUriButtons).toBeUndefined()
    expect(Array.isArray(list[0]!.messages)).toBe(true)
  })

  /**
   * `C-238`：推播編輯器要靠這個數字，才講得出「這顆網址按鈕的貼標在推播裡不會生效」。
   * ⛔ 一樣不可以把 `messages` 一起帶回去。
   */
  it('?fields=picker：數得出「開了貼標的網址按鈕」有幾顆', async () => {
    const tagged = { type: 'uri', uri: 'https://a.com', tagging: { enabled: true, addTagIds: ['t1'] } }
    stubListDocs([
      flow('flow-有貼標網址', { messages: [{ type: 'text', actions: [tagged] }] }),
      flow('flow-網址沒開貼標', { messages: [{ type: 'text', actions: [{ type: 'uri', uri: 'https://a.com' }] }] }),
      flow('flow-模組按鈕有貼標', { messages: [{ actions: [{ type: 'module', moduleId: 'm', tagging: { enabled: true, addTagIds: ['t1'] } }] }] }),
    ])
    currentQuery = { fields: 'picker' }

    const list = await (handler as any)({} as never) as Record<string, unknown>[]
    const byId = Object.fromEntries(list.map(f => [f.id, f]))

    expect(byId['flow-有貼標網址']!.taggedUriButtons).toBe(1)
    expect(byId['flow-網址沒開貼標']!.taggedUriButtons).toBe(0)
    // ⛔ 模組按鈕的貼標在推播裡是**有效**的，不可以一起算進來害它被誤警告
    expect(byId['flow-模組按鈕有貼標']!.taggedUriButtons).toBe(0)
    for (const item of list) expect(item.messages).toBeUndefined()
  })

  it('沒帶參數：照舊回整份（機器人模組那頁要吃 messages）', async () => {
    stubListDocs()

    const list = await (handler as any)({} as never) as Record<string, unknown>[]

    expect(Array.isArray((list[0] as any).messages)).toBe(true)
    // triggers 仍照原本的行為剝掉（stripFlowTriggers）
    expect(list[0]!.triggers).toBeUndefined()
  })

  it('系統模組齊全 → 不再多花往返去補建（只查一次清單）', async () => {
    const selects = stubListDocs()
    currentQuery = { fields: 'picker' }

    await (handler as any)({} as never)

    // 這一行紅掉＝又回到「每次列清單都先逐筆確認系統模組」的老路
    expect(seedWorkspaceSystemModules).not.toHaveBeenCalled()
    expect(selects).toHaveLength(1) // 清單只查一次
  })

  it('系統模組缺了 → 還是要補建（不能為了省往返把補建整個拿掉）', async () => {
    stubListDocs([flow('flow-a')]) // 兩個系統模組都不在
    currentQuery = { fields: 'picker' }

    await (handler as any)({} as never)

    expect(seedWorkspaceSystemModules).toHaveBeenCalledTimes(1)
  })

  // ── `D-23`：歡迎模組 2026-09-21 起不再補建，空的舊資料也不再列出來 ──────────
  it('⛔ 只缺「歡迎模組」不算缺 → 不可以再幫人補建一顆死模組', async () => {
    stubListDocs([flow(`${WS}_live_agent`, { isSystem: true, moduleType: 'live_agent' }), flow('flow-a')])
    currentQuery = {}

    await (handler as any)({} as never)

    // 這一行紅掉＝又會每次列清單都補建一顆沒有任何執行路徑的歡迎模組
    expect(seedWorkspaceSystemModules).not.toHaveBeenCalled()
  })

  it('空的舊「歡迎模組」不列出來（它沒有執行路徑，留著只會讓人白編內容）', async () => {
    stubListDocs([
      flow(`${WS}_welcome`, { isSystem: true, moduleType: 'welcome', messages: [] }),
      flow(`${WS}_live_agent`, { isSystem: true, moduleType: 'live_agent' }),
      flow('flow-a'),
    ])
    currentQuery = {}

    const res: any = await (handler as any)({} as never)
    const ids = (Array.isArray(res) ? res : res.items ?? []).map((f: any) => f.id)
    expect(ids).not.toContain(`${WS}_welcome`)
    expect(ids).toContain(`${WS}_live_agent`)
  })

  it('⛔ picker 模式也要藏（五個下拉都走 picker，不藏＝整個拿掉沒生效）', async () => {
    stubListDocs([
      flow(`${WS}_welcome`, { isSystem: true, moduleType: 'welcome', messages: [] }),
      flow(`${WS}_live_agent`, { isSystem: true, moduleType: 'live_agent' }),
    ])
    currentQuery = { fields: 'picker' }

    const res: any = await (handler as any)({} as never)
    const ids = (Array.isArray(res) ? res : res.items ?? []).map((f: any) => f.id)
    expect(ids).not.toContain(`${WS}_welcome`)
  })

  /**
   * ⛔ 對照組：picker 模式**不可以**為了判斷空不空再多讀一次那份文件。
   * `D-86` 起 `messages` 有投影進來，直接判斷得出來；再多讀一次就是白花一趟往返，
   * 而且會把「清單怎麼說」與「另外讀到什麼」變成兩本帳。
   */
  it('⛔ picker 模式不再為了歡迎模組多讀一次文件（清單裡就有答案）', async () => {
    const doc = vi.fn()
    vi.mocked(getDb).mockReturnValue({ collection: () => ({ doc }) } as never)
    stubListDocs([
      flow(`${WS}_welcome`, { isSystem: true, moduleType: 'welcome', messages: [] }),
      flow(`${WS}_live_agent`, { isSystem: true, moduleType: 'live_agent' }),
    ])
    currentQuery = { fields: 'picker' }

    await (handler as any)({} as never)

    expect(doc).not.toHaveBeenCalled()
  })

  it('⛔ 有內容的舊「歡迎模組」照舊列出來——藏起來就是讓人家的東西無聲消失', async () => {
    stubListDocs([
      flow(`${WS}_welcome`, { isSystem: true, moduleType: 'welcome' }), // fixture 預設帶一則訊息
      flow(`${WS}_live_agent`, { isSystem: true, moduleType: 'live_agent' }),
    ])
    currentQuery = {}

    const res: any = await (handler as any)({} as never)
    const ids = (Array.isArray(res) ? res : res.items ?? []).map((f: any) => f.id)
    expect(ids).toContain(`${WS}_welcome`)
  })
})
