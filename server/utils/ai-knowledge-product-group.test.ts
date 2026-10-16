/**
 * 分組就是商品（`D-127`）：資料的商品名跟著它所在的那一組走。
 *  · syncSourceProductWithGroup（換了分組）：商品分組＝組名、通用／未分類／型錄／試算表＝空的；有變才存、當場重新學習、稽核
 *  · syncGroupSourcesProduct（改組名、改成／取消通用）：整組改名字、不學習，回改到的那幾份
 * 跑在記憶體裡的假 Firestore 上，updateSourceSettings／runIndexOnChunk 是假的，正式庫零讀零寫、不連網。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Doc = Record<string, any>
const STORE: Record<string, Record<string, Doc>> = {}

vi.mock('./ai-knowledge-sources', () => ({
  KNOWLEDGE_SOURCES_COLLECTION: 'knowledgeSources',
  getSource: vi.fn(async (_db: unknown, id: string, ws: string) => {
    const d = STORE.knowledgeSources?.[id]
    return d && d.workspaceId === ws ? { id, data: { ...d } } : null
  }),
  updateSourceSettings: vi.fn(async (_db: unknown, ws: string, id: string, input: { productName?: string }) => {
    const d = STORE.knowledgeSources?.[id]
    if (!d || d.workspaceId !== ws) return null
    d.productName = input.productName
    return { id, productName: d.productName, folderId: d.folderId }
  }),
}))
vi.mock('./ai-knowledge-folders', () => ({ KNOWLEDGE_FOLDERS_COLLECTION: 'knowledgeFolders' }))
vi.mock('./ai-knowledge-chunks', () => ({
  KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks',
  addWorkspaceProductName: vi.fn(async () => {}),
  buildEmbeddingText: (t: string, c: string) => `${t}\n${c}`,
  invalidateSourceProductCache: vi.fn(),
  invalidateWorkspaceProductNames: vi.fn(),
  runIndexOnChunk: vi.fn(async (_db: unknown, id: string) => ({ id, status: 'indexed', embeddingTokens: 10 })),
}))
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn(async () => {}) }))
vi.mock('./audit-log', () => ({ writeAuditLog: vi.fn(async () => {}) }))
vi.mock('./ai-product-alias', () => ({
  confirmAlias: vi.fn(async () => true),
  invalidateProductAliases: vi.fn(),
  promoteCanonicalName: vi.fn(async () => ''),
}))
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

/** FieldValue.delete() 是哨兵物件：存進假資料庫時當成「這一格沒有了」 */
const isDeleteSentinel = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v) && String((v as object).constructor?.name ?? '').includes('Delete')

function applyUpdate(row: Doc, data: Doc) {
  for (const [k, v] of Object.entries(data)) {
    if (isDeleteSentinel(v)) delete row[k]
    else row[k] = v
  }
}

/** 每一個 batch commit 寫了幾筆（驗「一個 batch 最多 500 筆、要分批」） */
const COMMITS: number[] = []

function query(col: string, filters: Array<[string, unknown]> = [], fields: string[] | null = null): any {
  return {
    where: (f: string, _op: string, v: unknown) => query(col, [...filters, [f, v]], fields),
    select: (...fs: string[]) => query(col, filters, fs),
    doc: (id: string) => ({
      get: async () => ({ exists: !!STORE[col]?.[id], data: () => (STORE[col]?.[id] ? { ...STORE[col]![id] } : undefined) }),
      update: async (data: Doc) => {
        const row = STORE[col]?.[id]
        if (!row) throw new Error(`NOT_FOUND ${col}/${id}`)
        applyUpdate(row, data)
      },
      delete: async () => { delete STORE[col]?.[id] },
    }),
    get: async () => {
      const rows = STORE[col] ?? {}
      const docs = Object.keys(rows)
        .filter(id => filters.every(([f, v]) => rows[id]![f] === v))
        .map(id => ({
          id,
          ref: { col, id },
          data: () => (fields ? Object.fromEntries(fields.filter(f => f in rows[id]!).map(f => [f, rows[id]![f]])) : { ...rows[id] }),
        }))
      return { docs, size: docs.length }
    },
  }
}
const db: any = {
  collection: (col: string) => query(col),
  batch: () => {
    const ops: Array<() => void> = []
    return {
      update: (ref: { col: string; id: string }, data: Doc) => ops.push(() => applyUpdate(STORE[ref.col]![ref.id]!, data)),
      commit: async () => {
        if (ops.length > 500) throw new Error('INVALID_ARGUMENT: maximum 500 writes allowed per request')
        COMMITS.push(ops.length)
        for (const op of ops) op()
      },
    }
  },
}

const { updateSourceSettings } = await import('./ai-knowledge-sources')
const { runIndexOnChunk, invalidateSourceProductCache, invalidateWorkspaceProductNames } = await import('./ai-knowledge-chunks')
const { recordAiUsage } = await import('./ai-usage')
const { writeAuditLog } = await import('./audit-log')
const { confirmAlias, promoteCanonicalName } = await import('./ai-product-alias')
const {
  syncSourceProductWithGroup,
  syncGroupSourcesProduct,
  alignSourceProductWithGroup,
  makeGroupNameCanonical,
  mergeProductGroupInto,
  markGroupProductSyncPending,
  RELEARN_PENDING_FIELD,
} = await import('./ai-knowledge-product-group')

const WS = 'ws1'
const GROUP = '珈樂堤 小滑手全自動義式咖啡機'

function seed(opts: { folder?: Doc; me?: Doc } = {}) {
  STORE.knowledgeFolders = { f1: { workspaceId: WS, name: GROUP, order: 0, ...opts.folder } }
  STORE.knowledgeSources = {
    // 原本 AI 想的是含型號的全名：照組名走（全名由搬家腳本收成別名）
    me: { workspaceId: WS, folderId: 'f1', name: '小滑手說明書.pdf', productName: 'Giaretti 珈樂堤 小滑手全自動義式咖啡機 GL-5680', ...opts.me },
    sib: { workspaceId: WS, folderId: 'f1', name: '小滑手 FAQ', productName: GROUP },
    sheet: { workspaceId: WS, folderId: 'f1', name: '價目表', type: 'gsheet', productName: '' },
    // 別家同一個 folderId 的來源：⛔ 不能算進這一組
    other: { workspaceId: 'ws2', folderId: 'f1', productName: '別家的機器' },
  }
  STORE.knowledgeChunks = {
    c1: { workspaceId: WS, sourceId: 'me', title: '清潔', content: '蒸汽管怎麼清', status: 'indexed' },
    c2: { workspaceId: WS, sourceId: 'me', title: '尺寸', content: '寬 285mm', status: 'indexed' },
    c3: { workspaceId: WS, sourceId: 'me', title: '舊活動', content: '早鳥價', status: 'disabled' },
    c4: { workspaceId: WS, sourceId: 'sib', title: '別份', content: '不該重學', status: 'indexed' },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(STORE)) delete STORE[k]
  COMMITS.length = 0
})

describe('syncSourceProductWithGroup（換了分組，`D-127`）', () => {
  it('放在商品分組 → 商品名改成組名、這份每一條重新學習（停用的跳過）、稽核', async () => {
    seed()
    const res = await syncSourceProductWithGroup(db, WS, 'me', { uid: 'staff-1' })

    expect(res).toMatchObject({ changed: true, productName: GROUP, relearned: { total: 3, skipped: 1, indexed: 2, failed: 0 } })
    expect(updateSourceSettings).toHaveBeenCalledWith(db, WS, 'me', { productName: GROUP })
    expect(vi.mocked(runIndexOnChunk).mock.calls.map(c => c[1]).sort()).toEqual(['c1', 'c2'])
    expect(invalidateSourceProductCache).toHaveBeenCalledWith('me')
    expect(recordAiUsage).toHaveBeenCalledWith(WS, { buildEmbeddingTokens: 20 }, db)
    const audit = vi.mocked(writeAuditLog).mock.calls[0]![0]
    expect(audit).toMatchObject({ action: 'source.put', targetId: 'me', after: { productName: GROUP } })
    expect(audit.note).toBe(`小滑手說明書.pdf：放進「${GROUP}」，AI 把它當成「${GROUP}」的資料，重新學習 2 條`)
  })

  const untouched = () => {
    expect(updateSourceSettings).not.toHaveBeenCalled()
    expect(runIndexOnChunk).not.toHaveBeenCalled()
    expect(writeAuditLog).not.toHaveBeenCalled()
  }

  it('已經跟組名一樣 → 什麼都不寫、不花 embedding', async () => {
    seed({ me: { productName: GROUP } })
    expect(await syncSourceProductWithGroup(db, WS, 'me', { uid: 'u' })).toEqual({ changed: false, productName: GROUP })
    untouched()
  })

  it('搬到通用／移出分組 → 清掉商品名、重新學習，稽核講「不再當成那一台」', async () => {
    seed({ folder: { general: true } })
    const res = await syncSourceProductWithGroup(db, WS, 'me', { uid: 'u' })
    expect(res).toMatchObject({ changed: true, productName: '' })
    expect(updateSourceSettings).toHaveBeenCalledWith(db, WS, 'me', { productName: '' })
    expect(vi.mocked(writeAuditLog).mock.calls[0]![0].note).toContain('不在商品分組裡，AI 不再把它當成「Giaretti')

    vi.clearAllMocks()
    seed({ me: { folderId: null } })
    expect(await syncSourceProductWithGroup(db, WS, 'me', { uid: 'u' })).toMatchObject({ changed: true, productName: '' })
  })

  it('⛔ 型錄、Google 試算表放在商品分組也不當成那一台；本來就空的就不動', async () => {
    seed({ me: { generateOverview: true, productName: '' } })
    expect(await syncSourceProductWithGroup(db, WS, 'me', { uid: 'u' })).toEqual({ changed: false, productName: '' })
    seed({ me: { type: 'gsheet', productName: '' } })
    expect(await syncSourceProductWithGroup(db, WS, 'me', { uid: 'u' })).toEqual({ changed: false, productName: '' })
    untouched()
  })

  it('別家的分組＝當成沒有分組；資料不見了＝notFound', async () => {
    seed({ folder: { workspaceId: 'ws2' }, me: { productName: '' } })
    expect(await syncSourceProductWithGroup(db, WS, 'me', { uid: 'u' })).toEqual({ changed: false, productName: '' })
    expect(await syncSourceProductWithGroup(db, WS, 'gone', { uid: 'u' })).toEqual({ changed: false, productName: '', notFound: true })
    untouched()
  })

  it('重新學習有失敗的：照實回、稽核寫失敗條數', async () => {
    seed()
    vi.mocked(runIndexOnChunk).mockImplementation(async (_db: unknown, id: string) =>
      id === 'c2' ? { id, status: 'failed', failureReason: 'embed failed', embeddingTokens: 0 } : { id, status: 'indexed', embeddingTokens: 10 })
    const res = await syncSourceProductWithGroup(db, WS, 'me', { uid: 'u' })
    expect(res).toMatchObject({ changed: true, relearned: { indexed: 1, failed: 1, failures: [{ id: 'c2' }] } })
    expect(vi.mocked(writeAuditLog).mock.calls[0]![0].note).toContain('重新學習 1 條、失敗 1 條')
  })

  it('學完拿掉「還沒重新學」的記號（/code-review 第 4 條）', async () => {
    seed({ me: { [RELEARN_PENDING_FIELD]: true } })
    await syncSourceProductWithGroup(db, WS, 'me', { uid: 'u' })
    expect(RELEARN_PENDING_FIELD in STORE.knowledgeSources!.me!).toBe(false)
  })
})

describe('alignSourceProductWithGroup（「重新學習這一份」先對齊組名，/code-review 第 14 條）', () => {
  it('商品名沒跟上組名 → 改成組名、留「還沒重新學」記號；⛔ 不學（學交給呼叫端）', async () => {
    seed()
    const res = await alignSourceProductWithGroup(db, WS, 'me')
    expect(res).toMatchObject({ changed: true, productName: GROUP, previous: 'Giaretti 珈樂堤 小滑手全自動義式咖啡機 GL-5680' })
    expect(STORE.knowledgeSources!.me!.productName).toBe(GROUP)
    expect(STORE.knowledgeSources!.me![RELEARN_PENDING_FIELD]).toBe(true)
    expect(runIndexOnChunk).not.toHaveBeenCalled()
  })

  it('已經對上 → 什麼都不寫', async () => {
    seed({ me: { productName: GROUP } })
    expect(await alignSourceProductWithGroup(db, WS, 'me')).toEqual({ changed: false, productName: GROUP })
    expect(updateSourceSettings).not.toHaveBeenCalled()
    expect(RELEARN_PENDING_FIELD in STORE.knowledgeSources!.me!).toBe(false)
  })
})

describe('syncGroupSourcesProduct（改組名、改成／取消通用，`D-127`）', () => {
  it('改了組名 → 底下每一份改成新名字（試算表不算、別家的不碰），回改到的那幾份；不重新學習', async () => {
    seed()
    STORE.knowledgeFolders!.f1!.name = '小滑手'
    const ids = await syncGroupSourcesProduct(db, WS, 'f1')

    expect(ids.sort()).toEqual(['me', 'sib'])
    expect(STORE.knowledgeSources!.me!.productName).toBe('小滑手')
    expect(STORE.knowledgeSources!.sib!.productName).toBe('小滑手')
    expect(STORE.knowledgeSources!.sheet!.productName).toBe('')
    expect(STORE.knowledgeSources!.other!.productName).toBe('別家的機器')
    expect(runIndexOnChunk).not.toHaveBeenCalled()
    expect(invalidateWorkspaceProductNames).toHaveBeenCalledWith(WS)
  })

  it('改成通用 → 清掉商品名', async () => {
    seed({ folder: { general: true } })
    expect((await syncGroupSourcesProduct(db, WS, 'f1')).sort()).toEqual(['me', 'sib'])
    expect('productName' in STORE.knowledgeSources!.me!).toBe(false)
  })

  it('沒有要改的／別家的分組 → 回空的、什麼都不寫', async () => {
    seed({ me: { productName: GROUP } })
    expect(await syncGroupSourcesProduct(db, WS, 'f1')).toEqual([])
    seed({ folder: { workspaceId: 'ws2' } })
    expect(await syncGroupSourcesProduct(db, WS, 'f1')).toEqual([])
    expect(invalidateWorkspaceProductNames).not.toHaveBeenCalled()
  })

  it('改到的每一份留「還沒重新學」記號（畫面中途關掉，體檢找得到），沒改到的不留（/code-review 第 4 條）', async () => {
    seed()
    STORE.knowledgeFolders!.f1!.name = '小滑手'
    await syncGroupSourcesProduct(db, WS, 'f1')
    expect(STORE.knowledgeSources!.me![RELEARN_PENDING_FIELD]).toBe(true)
    expect(STORE.knowledgeSources!.sib![RELEARN_PENDING_FIELD]).toBe(true)
    expect(RELEARN_PENDING_FIELD in STORE.knowledgeSources!.sheet!).toBe(false)
  })

  it('⛔ 一組超過 500 份也寫得進去：分批 commit（以前整批失敗、一份都沒改，/code-review 第 14 條）', async () => {
    STORE.knowledgeFolders = { f1: { workspaceId: WS, name: GROUP, order: 0 } }
    STORE.knowledgeSources = Object.fromEntries(Array.from({ length: 901 }, (_, i) => [`s${i}`, { workspaceId: WS, folderId: 'f1', productName: '舊名字' }]))
    expect((await syncGroupSourcesProduct(db, WS, 'f1')).length).toBe(901)
    expect(COMMITS).toEqual([400, 400, 101])
    expect(Object.values(STORE.knowledgeSources).every(s => s.productName === GROUP)).toBe(true)
  })

  it('上一次沒跟上（分組上有記號）→ 這次整組跟上了就拿掉記號；寫失敗時 markGroupProductSyncPending 留記號', async () => {
    seed()
    await markGroupProductSyncPending(db, 'f1')
    expect(STORE.knowledgeFolders!.f1!.productSyncPending).toBe(true)
    await syncGroupSourcesProduct(db, WS, 'f1')
    expect('productSyncPending' in STORE.knowledgeFolders!.f1!).toBe(false)

    // 本來就都對上了（什麼都不用改）也拿掉
    seed({ folder: { productSyncPending: true }, me: { productName: GROUP } })
    expect(await syncGroupSourcesProduct(db, WS, 'f1')).toEqual([])
    expect('productSyncPending' in STORE.knowledgeFolders!.f1!).toBe(false)
  })
})

describe('makeGroupNameCanonical（組名一定是正式名，原本指向的名字收成它的別名）', () => {
  const groups = () => {
    STORE.knowledgeFolders = {
      pk: { workspaceId: WS, name: 'Poketomo 口袋同萌', order: 0 },
      pot: { workspaceId: WS, name: 'SHARP 自動調理零水鍋', order: 1 },
      gen: { workspaceId: WS, name: '客服', order: 2, general: true },
      other: { workspaceId: 'ws2', name: 'SHARP 小獴友 Poketomo 口袋同萌', order: 0 },
    }
  }

  it('組名本來指向一個舊全名 → 舊全名收成組名的別名（不然「小獴友」就沒人認）', async () => {
    groups()
    vi.mocked(promoteCanonicalName).mockResolvedValueOnce('SHARP 小獴友 Poketomo 口袋同萌')
    expect(await makeGroupNameCanonical(db, WS, 'Poketomo 口袋同萌', 'pk')).toBe('SHARP 小獴友 Poketomo 口袋同萌')
    expect(confirmAlias).toHaveBeenCalledWith(db, WS, 'Poketomo 口袋同萌', 'SHARP 小獴友 Poketomo 口袋同萌')
  })

  it('⛔ 原本指向的是另一個商品分組的組名 → 不收（他另外建這一組就是要分成兩台）；通用、別家同名的不算', async () => {
    groups()
    vi.mocked(promoteCanonicalName).mockResolvedValueOnce('SHARP 自動調理零水鍋')
    expect(await makeGroupNameCanonical(db, WS, '零水鍋', 'new')).toBe('')
    expect(confirmAlias).not.toHaveBeenCalled()

    // 跟通用那一組、別家那一組同名不算「另一台」
    vi.mocked(promoteCanonicalName).mockResolvedValueOnce('客服')
    await makeGroupNameCanonical(db, WS, '客服專線', 'new')
    expect(confirmAlias).toHaveBeenCalledWith(db, WS, '客服專線', '客服')
  })

  it('本來就是正式名、原本指向的太短 → 什麼都不收', async () => {
    groups()
    expect(await makeGroupNameCanonical(db, WS, 'Poketomo 口袋同萌', 'pk')).toBe('')
    vi.mocked(promoteCanonicalName).mockResolvedValueOnce('鍋')
    expect(await makeGroupNameCanonical(db, WS, '零水鍋', 'new')).toBe('')
    expect(confirmAlias).not.toHaveBeenCalled()
  })
})

describe('mergeProductGroupInto（兩組是同一台 → 合成一組，/code-review 第 9、10 條）', () => {
  const seedTwo = () => {
    STORE.knowledgeFolders = {
      keep: { workspaceId: WS, name: 'SHARP 零水鍋', order: 0 },
      from: { workspaceId: WS, name: '零水鍋 KN-S10', order: 1 },
      gen: { workspaceId: WS, name: '通用', order: 2, general: true },
    }
    STORE.knowledgeSources = {
      a: { workspaceId: WS, folderId: 'from', productName: '零水鍋 KN-S10' },
      // 畫面清單可能被截斷、沒列出來的那一份：伺服器照分組查，一樣搬
      b: { workspaceId: WS, folderId: 'from', productName: '零水鍋 KN-S10' },
      cat: { workspaceId: WS, folderId: 'from', productName: '', generateOverview: true },
      k: { workspaceId: WS, folderId: 'keep', productName: 'SHARP 零水鍋' },
      other: { workspaceId: 'ws2', folderId: 'from', productName: '別家的' },
    }
  }

  it('那一組的每一份搬過來、商品名換成留下那一組的、留記號；舊組名收成別名；刪掉變空的那一組', async () => {
    seedTwo()
    const res = await mergeProductGroupInto(db, WS, 'from', 'keep')

    expect(res).toMatchObject({ moved: 3, aliasFrom: '零水鍋 KN-S10', fromName: '零水鍋 KN-S10', intoName: 'SHARP 零水鍋' })
    expect(res.relearnSourceIds.sort()).toEqual(['a', 'b'])
    for (const id of ['a', 'b']) {
      expect(STORE.knowledgeSources![id]).toMatchObject({ folderId: 'keep', productName: 'SHARP 零水鍋', [RELEARN_PENDING_FIELD]: true })
    }
    // 型錄搬過來、商品名照樣空的，不用重新學
    expect(STORE.knowledgeSources!.cat).toMatchObject({ folderId: 'keep', productName: '' })
    expect(RELEARN_PENDING_FIELD in STORE.knowledgeSources!.cat!).toBe(false)
    expect(STORE.knowledgeSources!.other!.folderId).toBe('from')
    expect(STORE.knowledgeFolders!.from).toBeUndefined()
    expect(promoteCanonicalName).toHaveBeenCalledWith(db, WS, 'SHARP 零水鍋')
    expect(confirmAlias).toHaveBeenCalledWith(db, WS, 'SHARP 零水鍋', '零水鍋 KN-S10')
    expect(runIndexOnChunk).not.toHaveBeenCalled()
  })

  it('舊組名太短（「鍋」）不收成別名，照樣合', async () => {
    seedTwo()
    STORE.knowledgeFolders!.from!.name = '鍋'
    const res = await mergeProductGroupInto(db, WS, 'from', 'keep')
    expect(res.aliasFrom).toBe('')
    expect(confirmAlias).not.toHaveBeenCalled()
    expect(STORE.knowledgeFolders!.from).toBeUndefined()
  })

  it('⛔ 同一組、通用、找不到的 → 擋下來，什麼都不寫', async () => {
    seedTwo()
    await expect(mergeProductGroupInto(db, WS, 'keep', 'keep')).rejects.toMatchObject({ statusCode: 400 })
    await expect(mergeProductGroupInto(db, WS, 'from', 'gen')).rejects.toMatchObject({ statusCode: 400 })
    await expect(mergeProductGroupInto(db, WS, 'from', 'nope')).rejects.toMatchObject({ statusCode: 404 })
    STORE.knowledgeFolders!.keep!.workspaceId = 'ws2'
    await expect(mergeProductGroupInto(db, WS, 'from', 'keep')).rejects.toMatchObject({ statusCode: 404 })
    expect(COMMITS).toEqual([])
    expect(STORE.knowledgeFolders!.from).toBeDefined()
  })
})
