import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 「AI 發現的新標籤」按了建立／忽略之後留下什麼（`C-94`）。
 *
 * 老闆 2026-08-28：「是否把之前建議的紀錄保留、也保留之前決策是建立還是不要建立」。
 * 先前按完就整條蒸發——忽略只留下一個看不見的名字（`dismissedNames`），
 * 採用連「這顆標籤是 AI 提的」都看不出來。這組釘的是四件事：
 *   ① 紀錄與「從收件匣移除」寫在**同一個 transaction**（分兩次寫，中間掛掉就是
 *      提案不見了、也查不到誰處理過的黑洞）
 *   ② 紀錄裡**不可以有 `userDocIds`**（一條提案掛得到兩百多位客人 × 50 筆紀錄
 *      ＝把文件推向 1MB 上限，連 pending 都讀不出來）
 *   ③ 採用後要把標籤 id 與**實際貼上人數**補回去（實際可能少於提議人數）
 *   ④ 取消忽略只撤掉否決票、**不還原提案**（沒存名單，還原了按「建立」會貼 0 位）
 */

const WS = 'ws1'
const UID = 'uid-kevin'
const EMAIL = 'kevin@example.com'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__del__' },
}))
vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireWorkspaceAccess: vi.fn(async () => ({ uid: UID, workspaceId: WS, token: { email: EMAIL } })),
}))
vi.mock('~~/server/utils/tagging', () => ({ addTagsToUser: vi.fn() }))
vi.mock('uuid', () => ({ v4: () => 'new-tag-id' }))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { default: handler } = await import('./discovery.post')
const { getDb } = await import('~~/server/utils/firebase')
const { addTagsToUser } = await import('~~/server/utils/tagging')

const PROPOSAL = {
  id: 'p1',
  name: '在看除濕機',
  code: 'intent_dehumidifier',
  category: 'interest',
  criteria: '客人詢問、比較除濕機。只問維修的不算。',
  usage: '除濕機品類意向客',
  reason: '兩週內多位客人問到除濕機',
  userDocIds: ['ws1_u1', 'ws1_u2', 'ws1_u3', 'ws1_u4'],
  sampleNames: ['王小明', 'Amy'],
  proposedAtMs: 1_700_000_000_000,
}

/**
 * 迷你假 Firestore：`tagDiscovery/{ws}` 一份文件 ＋ `tags` 建立與唯一性查詢。
 * transaction 直接跑（單執行緒測試不需要真的併發），寫入累積回同一份 doc，
 * 這樣「第二個 transaction 讀得到第一個寫的東西」才測得出來。
 */
function makeDb(initial: Record<string, any> | null) {
  let doc: Record<string, any> | null = initial ? { ...initial } : null
  const tagWrites: Array<Record<string, any>> = []

  const docRef = {
    get: async () => ({ exists: !!doc, data: () => doc ?? undefined }),
    set: async (patch: Record<string, any>) => { doc = { ...(doc ?? {}), ...patch } },
  }

  const db: any = {
    collection: (name: string) => {
      if (name === 'tagDiscovery') return { doc: () => docRef }
      // tags：建立時先查 code 有沒有撞號（回空＝沒撞），再 set 一份新文件
      const q: any = { where: () => q, limit: () => q, get: async () => ({ empty: true }) }
      return Object.assign(q, {
        doc: () => ({ set: async (d: Record<string, any>) => { tagWrites.push(d) } }),
      })
    },
    runTransaction: async (fn: (tx: any) => Promise<any>) => fn({
      get: async (ref: any) => ref.get(),
      set: (ref: any, patch: Record<string, any>) => { void ref.set(patch) },
    }),
  }
  return { db, tagWrites, current: () => doc }
}

const call = (body: Record<string, unknown>) => (handler as any)({ __body: body })

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('readBody', async (e: any) => e.__body)
  vi.mocked(addTagsToUser).mockResolvedValue({ added: ['x'] } as any)
})

describe('忽略：留下決策紀錄，而且不是只留一個看不見的名字', () => {
  it('紀錄與「從收件匣移除」在同一次寫入完成，並記下是誰、何時、決定了什麼', async () => {
    const { db, current } = makeDb({ workspaceId: WS, pending: [PROPOSAL], dismissedNames: [] })
    vi.mocked(getDb).mockReturnValue(db)

    await call({ action: 'dismiss', proposalId: 'p1' })

    const doc = current()!
    expect(doc.pending).toEqual([])
    expect(doc.dismissedNames).toEqual(['在看除濕機'])
    expect(doc.history).toHaveLength(1)
    expect(doc.history[0]).toMatchObject({
      id: 'p1',
      name: '在看除濕機',
      action: 'dismiss',
      userCount: 4,
      decidedBy: UID,
      decidedByEmail: EMAIL,
      proposedAtMs: PROPOSAL.proposedAtMs,
    })
    expect(doc.history[0].decidedAtMs).toBeGreaterThan(0)
  })

  /** ⛔ 一條提案掛得到兩百多位客人；50 筆紀錄各帶一份名單就是把文件推向 1MB 上限 */
  it('⛔ 紀錄不可以帶客人名單（只留人數與幾個名字當證據）', async () => {
    const { db, current } = makeDb({ workspaceId: WS, pending: [PROPOSAL], dismissedNames: [] })
    vi.mocked(getDb).mockReturnValue(db)

    await call({ action: 'dismiss', proposalId: 'p1' })

    expect(current()!.history[0].userDocIds).toBeUndefined()
    expect(current()!.history[0].sampleNames).toEqual(['王小明', 'Amy'])
  })

  it('同事已經處理掉了 → 404，且不會憑空長出第二筆紀錄', async () => {
    const { db, current } = makeDb({ workspaceId: WS, pending: [], dismissedNames: [], history: [] })
    vi.mocked(getDb).mockReturnValue(db)

    await expect(call({ action: 'dismiss', proposalId: 'p1' })).rejects.toThrow('已被處理過')
    expect(current()!.history).toEqual([])
  })
})

describe('建立：紀錄要接上「後來真的發生了什麼」', () => {
  it('補回標籤 id 與實際貼上人數（⛔ 實際可能少於提議人數，不可以拿提議數充當）', async () => {
    // 四位裡有一位貼標失敗 → 實際只有 3 位
    vi.mocked(addTagsToUser)
      .mockResolvedValueOnce({ added: ['t'] } as any)
      .mockResolvedValueOnce({ added: ['t'] } as any)
      .mockResolvedValueOnce({ added: ['t'] } as any)
      .mockRejectedValueOnce(new Error('boom'))

    const { db, tagWrites, current } = makeDb({ workspaceId: WS, pending: [PROPOSAL], dismissedNames: [] })
    vi.mocked(getDb).mockReturnValue(db)

    const res: any = await call({ action: 'adopt', proposalId: 'p1' })

    expect(res.created.name).toBe('在看除濕機')
    expect(res.tagged).toBe(3)
    // 建立的標籤一律「AI 先建議」＝人工把關（同範本原則）
    expect(tagWrites[0]).toMatchObject({ name: '在看除濕機', aiMode: 'suggest', status: 'active' })

    const entry = current()!.history[0]
    expect(entry).toMatchObject({ action: 'adopt', tagId: 'new-tag-id', taggedCount: 3, userCount: 4 })
  })

  /** ⛔ 採用不進否決名單：標籤已經存在，重複防護靠 tags 集合本身 */
  it('採用不會把名字寫進「不再建議」名單', async () => {
    const { db, current } = makeDb({ workspaceId: WS, pending: [PROPOSAL], dismissedNames: [] })
    vi.mocked(getDb).mockReturnValue(db)

    await call({ action: 'adopt', proposalId: 'p1' })
    expect(current()!.dismissedNames).toEqual([])
  })
})

describe('取消忽略：撤回否決票，但不假裝建議回來了', () => {
  const dismissed = (over: Record<string, any> = {}) => ({
    workspaceId: WS,
    pending: [],
    dismissedNames: ['在看除濕機', '想送禮'],
    history: [{ id: 'p1', name: '在看除濕機', action: 'dismiss', decidedAtMs: 1, ...over }],
  })

  it('把名字從「不再建議」名單拿掉，讓下次掃描有機會再提', async () => {
    const { db, current } = makeDb(dismissed())
    vi.mocked(getDb).mockReturnValue(db)

    await call({ action: 'undo-dismiss', proposalId: 'p1' })

    expect(current()!.dismissedNames).toEqual(['想送禮'])
  })

  /** ⛔ 提案回不來（紀錄刻意不存名單）；放回收件匣的話按「建立」會幫 0 位客人貼上 */
  it('⛔ 不把提案塞回收件匣', async () => {
    const { db, current } = makeDb(dismissed())
    vi.mocked(getDb).mockReturnValue(db)

    await call({ action: 'undo-dismiss', proposalId: 'p1' })
    expect(current()!.pending).toEqual([])
  })

  /** 這個決定發生過、也被推翻過——兩件事都是紀錄的一部分 */
  it('紀錄不刪除，只蓋上「已取消」的時間', async () => {
    const { db, current } = makeDb(dismissed())
    vi.mocked(getDb).mockReturnValue(db)

    await call({ action: 'undo-dismiss', proposalId: 'p1' })

    expect(current()!.history).toHaveLength(1)
    expect(current()!.history[0].undoneAtMs).toBeGreaterThan(0)
  })

  it('名字比對吃 normalize：否決名單存的是原樣，空白／標點的變體也要撤得掉', async () => {
    const { db, current } = makeDb({
      ...dismissed(),
      dismissedNames: ['在看 除濕機。'],
    })
    vi.mocked(getDb).mockReturnValue(db)

    await call({ action: 'undo-dismiss', proposalId: 'p1' })
    expect(current()!.dismissedNames).toEqual([])
  })

  it('已經取消過的、或不是忽略的紀錄 → 404（不重複撤、也不動採用過的）', async () => {
    for (const over of [{ undoneAtMs: 123 }, { action: 'adopt' }]) {
      const { db } = makeDb(dismissed(over))
      vi.mocked(getDb).mockReturnValue(db)
      await expect(call({ action: 'undo-dismiss', proposalId: 'p1' })).rejects.toThrow('找不到這筆忽略紀錄')
    }
  })
})
