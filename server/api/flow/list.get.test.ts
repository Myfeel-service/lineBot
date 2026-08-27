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
const { listDocs } = await import('~~/server/utils/firebase')
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
})
