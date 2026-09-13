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
vi.mock('~~/server/utils/tagging', () => ({ addTagsToUser: vi.fn(), removeTagsFromUser: vi.fn() }))
vi.mock('uuid', () => ({ v4: () => 'new-tag-id' }))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { default: handler } = await import('./discovery.post')
const { getDb } = await import('~~/server/utils/firebase')
const { addTagsToUser, removeTagsFromUser } = await import('~~/server/utils/tagging')

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
function makeDb(
  initial: Record<string, any> | null,
  existingTags: Record<string, any> = {},
  /** 合併還原資料：`tagDiscovery/{ws}/merges/{proposalId}` 一筆一個合併 */
  merges: Record<string, any> = {},
) {
  let doc: Record<string, any> | null = initial ? { ...initial } : null
  const tagWrites: Array<Record<string, any>> = []

  const docRef = {
    get: async () => ({ exists: !!doc, data: () => doc ?? undefined }),
    set: async (patch: Record<string, any>) => { doc = { ...(doc ?? {}), ...patch } },
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => ({ exists: name in { merges: 1 } && !!merges[id], data: () => merges[id] }),
        set: async (d: Record<string, any>) => { merges[id] = d },
      }),
    }),
  }

  const db: any = {
    collection: (name: string) => {
      if (name === 'tagDiscovery') return { doc: () => docRef }
      // tags：建立時先查 code 有沒有撞號（回空＝沒撞），再 set 一份新文件
      const q: any = { where: () => q, limit: () => q, get: async () => ({ empty: true }) }
      return Object.assign(q, {
        // doc(id).get()＝merge 要先驗「這顆標籤在不在」；doc().set()＝adopt 建新的
        doc: (id?: string) => ({
          get: async () => ({ exists: !!existingTags[id ?? ''], data: () => existingTags[id ?? ''] }),
          set: async (d: Record<string, any>) => { tagWrites.push(d) },
        }),
      })
    },
    runTransaction: async (fn: (tx: any) => Promise<any>) => fn({
      get: async (ref: any) => ref.get(),
      set: (ref: any, patch: Record<string, any>) => { void ref.set(patch) },
    }),
  }
  return { db, tagWrites, current: () => doc, merges }
}

const call = (body: Record<string, unknown>) => (handler as any)({ __body: body })

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('readBody', async (e: any) => e.__body)
  vi.mocked(addTagsToUser).mockResolvedValue({ added: ['x'] } as any)
  vi.mocked(removeTagsFromUser).mockResolvedValue({ removed: ['x'] } as any)
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

/**
 * 改貼到既有標籤（`C-178`，老闆 2026-09-11）。
 *
 * 為什麼要有這條路：帳號裡已經有「在看收音麥克風」，AI 又提「在看無線麥克風」——
 * 先前畫面只有「建立」與「忽略」兩顆按鈕，而忽略等於把那 8 位聊過的客人整批丟掉，
 * 所以人明知重複還是只能按建立。三顆麥克風標籤就是這樣長出來的。
 */
describe('改貼到既有標籤：不另外開一顆，客人照樣貼上', () => {
  const TARGET = { workspaceId: WS, name: '在看收音麥克風' }

  it('不建新標籤，把客人貼到既有那顆，回「已併入」而不是「已建立」', async () => {
    const { db, tagWrites } = makeDb(
      { workspaceId: WS, pending: [PROPOSAL], dismissedNames: [] },
      { 'tag-mic': TARGET },
    )
    vi.mocked(getDb).mockReturnValue(db)

    const res: any = await call({ action: 'merge', proposalId: 'p1', tagId: 'tag-mic' })

    // ⛔ 一顆標籤都不可以被建出來——這整條路的重點就是「不要再多一顆」
    expect(tagWrites).toEqual([])
    expect(res.created).toBeUndefined()
    expect(res.merged).toEqual({ id: 'tag-mic', name: '在看收音麥克風' })
    expect(vi.mocked(addTagsToUser).mock.calls[0]?.[1]).toEqual(['tag-mic'])
    // 來源要分得出是併進來的（日後查「這批人怎麼被貼上的」）；`C-181` 起還要帶提案 id
    expect(vi.mocked(addTagsToUser).mock.calls[0]?.[3]).toBe('tag-discovery:merge:p1')
  })

  /**
   * ⛔ 少了這條，這個主題下週原封不動再被提一次：掃描的排除名單只認「既有標籤名」
   * 與「否決過的名」，而「在看無線麥克風」併進去之後這個名字從來沒變成標籤、
   * 也沒被否決過——於是每週回來一次，每次的正確動作都是再併一次。
   */
  it('名字要進「不再建議」名單，否則下週同一條會再回來', async () => {
    const { db, current } = makeDb(
      { workspaceId: WS, pending: [PROPOSAL], dismissedNames: [] },
      { 'tag-mic': TARGET },
    )
    vi.mocked(getDb).mockReturnValue(db)

    await call({ action: 'merge', proposalId: 'p1', tagId: 'tag-mic' })

    expect(current()!.dismissedNames).toEqual(['在看除濕機'])
    expect(current()!.history[0]).toMatchObject({ action: 'merge', tagId: 'tag-mic', taggedCount: 4 })
  })

  /**
   * ⛔ 驗標籤要在認領提案**之前**：順序反過來的話，標籤 id 是錯的時候提案已經
   * 從收件匣摘走了——那條建議連同它的客人名單就這樣消失，而且什麼都沒貼到。
   */
  it('目標標籤不存在 → 404，而且提案還留在收件匣', async () => {
    const { db, current } = makeDb({ workspaceId: WS, pending: [PROPOSAL], dismissedNames: [] }, {})
    vi.mocked(getDb).mockReturnValue(db)

    await expect(call({ action: 'merge', proposalId: 'p1', tagId: 'gone' })).rejects.toThrow('找不到要貼上的那顆標籤')
    expect(current()!.pending).toEqual([PROPOSAL])
    expect(addTagsToUser).not.toHaveBeenCalled()
  })

  it('別的工作區的標籤不算數（跨租戶不可貼）', async () => {
    const { db, current } = makeDb(
      { workspaceId: WS, pending: [PROPOSAL], dismissedNames: [] },
      { 'tag-mic': { workspaceId: 'other-ws', name: '別人的標籤' } },
    )
    vi.mocked(getDb).mockReturnValue(db)

    await expect(call({ action: 'merge', proposalId: 'p1', tagId: 'tag-mic' })).rejects.toThrow('找不到要貼上的那顆標籤')
    expect(current()!.pending).toEqual([PROPOSAL])
  })

  it('沒帶要貼到哪一顆 → 400', async () => {
    const { db } = makeDb({ workspaceId: WS, pending: [PROPOSAL], dismissedNames: [] }, {})
    vi.mocked(getDb).mockReturnValue(db)

    await expect(call({ action: 'merge', proposalId: 'p1' })).rejects.toThrow('要帶 tagId')
  })
})

/**
 * 解除合併（`C-181`，老闆 2026-09-13 問「是否也跟知識庫一樣合併的可以解除」）。
 *
 * 為什麼非有不可：按「改貼到現有標籤」會把主題名**永久**記進「不再建議」
 * （不記的話下週原封不動再來一次）——沒有這條路，併錯了就再也叫不回來。
 * 知識庫的產品名合併早就有「解除」（那邊能解是因為它只是一張對照表、沒動到資料；
 * 這邊是真的把標籤貼到人身上，所以要靠合併當下留下的還原資料）。
 */
describe('解除合併：把後悔藥補上', () => {
  const TARGET = { workspaceId: WS, name: '在看收音麥克風' }
  const merged = (over: Record<string, any> = {}) => ({
    workspaceId: WS,
    pending: [],
    dismissedNames: ['在看除濕機'],
    history: [{
      id: 'p1',
      name: '在看除濕機',
      action: 'merge',
      category: 'interest',
      criteria: 'x',
      usage: '',
      reason: '',
      userCount: 4,
      sampleNames: [],
      proposedAtMs: 1,
      decidedAtMs: 2,
      decidedBy: UID,
      tagId: 'tag-mic',
      taggedCount: 2,
      ...over,
    }],
  })

  /**
   * ⛔ 還原資料只能存「**這次真的被貼上**的人」：本來就有這顆標籤的那幾位不是這次給的，
   * 解除時動他們就是把別人的資料改掉。
   */
  it('合併時留下還原資料，而且只記真的被貼上的那幾位', async () => {
    const { db, merges } = makeDb(
      { workspaceId: WS, pending: [PROPOSAL], dismissedNames: [] },
      { 'tag-mic': TARGET },
    )
    vi.mocked(getDb).mockReturnValue(db)
    // u2 本來就有這顆標籤（addTagsToUser 回空 added＝略過）
    vi.mocked(addTagsToUser).mockImplementation(async (userDocId: string) =>
      (userDocId === 'ws1_u2' ? { added: [], skipped: ['tag-mic'], hits: [] } : { added: ['tag-mic'], skipped: [], hits: [] }) as any)

    await call({ action: 'merge', proposalId: 'p1', tagId: 'tag-mic' })

    expect(merges.p1.tagId).toBe('tag-mic')
    expect(merges.p1.userDocIds).toEqual(['ws1_u1', 'ws1_u3', 'ws1_u4']) // ⛔ 不含 u2
  })

  /** ⛔ 同一顆標籤可能被併進兩次（先「無線麥克風」再「錄音麥克風」）→ 記號要帶提案 id */
  it('貼標來源帶提案 id，兩次併進同一顆才分得出是哪一批', async () => {
    const { db } = makeDb(
      { workspaceId: WS, pending: [PROPOSAL], dismissedNames: [] },
      { 'tag-mic': TARGET },
    )
    vi.mocked(getDb).mockReturnValue(db)
    await call({ action: 'merge', proposalId: 'p1', tagId: 'tag-mic' })
    expect(vi.mocked(addTagsToUser).mock.calls[0]?.[3]).toBe('tag-discovery:merge:p1')
  })

  it('解除＝摘掉那批人的標籤＋讓這個主題可以再被提＋紀錄標上已解除', async () => {
    const { db, current } = makeDb(merged(), {}, {
      p1: { workspaceId: WS, tagId: 'tag-mic', userDocIds: ['ws1_u1', 'ws1_u3'], mergedAtMs: 5 },
    })
    vi.mocked(getDb).mockReturnValue(db)

    const res: any = await call({ action: 'unmerge', proposalId: 'p1' })

    expect(res.unmerged).toBe(true)
    expect(res.removed).toBe(2)
    expect(vi.mocked(removeTagsFromUser).mock.calls.map(c => c[0])).toEqual(['ws1_u1', 'ws1_u3'])
    expect(vi.mocked(removeTagsFromUser).mock.calls[0]?.[1]).toEqual(['tag-mic'])
    expect(current()!.dismissedNames).toEqual([]) // 主題放回可再提
    expect(current()!.history[0].unmergedAtMs).toBeGreaterThan(0)
  })

  /**
   * ⛔ 沒有還原資料就**不可以**假裝解除成功：摘 0 位卻回「已解除」＝畫面說謊，
   * 而且紀錄一旦標成已解除，按鈕就消失、再也修不回來。
   */
  it('沒有還原資料（功能上線前併的）→ 報錯，且不標成已解除', async () => {
    const { db, current } = makeDb(merged())
    vi.mocked(getDb).mockReturnValue(db)

    await expect(call({ action: 'unmerge', proposalId: 'p1' })).rejects.toThrow('沒有留下還原資料')
    expect(current()!.history[0].unmergedAtMs).toBeUndefined()
    expect(removeTagsFromUser).not.toHaveBeenCalled()
    expect(current()!.dismissedNames).toEqual(['在看除濕機']) // 也不可以順手解鎖
  })

  it('已經解除過的不可以再解一次', async () => {
    const { db } = makeDb(merged({ unmergedAtMs: 999 }))
    vi.mocked(getDb).mockReturnValue(db)
    await expect(call({ action: 'unmerge', proposalId: 'p1' })).rejects.toThrow('已經解除過')
  })

  /**
   * 另一種後悔：「併得沒錯，但這主題值得單獨開一顆」——要的是讓 AI 重新提議，
   * ⛔ **不是**把已經貼好的客人標籤拔掉。
   */
  it('只放回可再提：標籤一顆都不動，而且不吃掉「解除合併」', async () => {
    const { db, current } = makeDb(merged())
    vi.mocked(getDb).mockReturnValue(db)

    const res: any = await call({ action: 'unblock', proposalId: 'p1' })

    expect(res.unblocked).toBe(true)
    expect(removeTagsFromUser).not.toHaveBeenCalled()
    expect(current()!.dismissedNames).toEqual([])
    expect(current()!.history[0].unblockedAtMs).toBeGreaterThan(0)
    // ⛔ 沒有標上 unmergedAtMs＝後悔藥還在（標籤還在客人身上，本來就該還能拉回來）
    expect(current()!.history[0].unmergedAtMs).toBeUndefined()
  })

  it('不是合併的紀錄不能解除（別動到「已建立」那些）', async () => {
    const { db } = makeDb(merged({ action: 'adopt' }))
    vi.mocked(getDb).mockReturnValue(db)
    await expect(call({ action: 'unmerge', proposalId: 'p1' })).rejects.toThrow('找不到這筆合併紀錄')
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
