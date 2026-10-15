/**
 * 搬進「商品」分組時補產品名＋重新學習（`C-320`）。
 *  ① 商品分組、自己是空的、同組只有一種 → 存名字（走 updateSourceSettings）＋這份每一條重新學習（停用的跳過）＋稽核
 *  ② ⛔ 不覆蓋填好的、⛔ 同組兩款不補（MATELASER）、通用分組不補、未分類不補、型錄不補——什麼都不寫、不花 embedding
 *  ③ 重新學習有失敗的，稽核照實記
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
  buildEmbeddingText: (t: string, c: string) => `${t}\n${c}`,
  invalidateSourceProductCache: vi.fn(),
  runIndexOnChunk: vi.fn(async (_db: unknown, id: string) => ({ id, status: 'indexed', embeddingTokens: 10 })),
}))
vi.mock('./ai-product-alias', () => ({
  getProductAliases: vi.fn(async () => ({ aliases: {}, aliasLabels: {}, dismissedPairs: [] })),
  canonicalProductName: (n: string) => n,
}))
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn(async () => {}) }))
vi.mock('./audit-log', () => ({ writeAuditLog: vi.fn(async () => {}) }))

function query(col: string, filters: Array<[string, unknown]> = [], fields: string[] | null = null): any {
  return {
    where: (f: string, _op: string, v: unknown) => query(col, [...filters, [f, v]], fields),
    select: (...fs: string[]) => query(col, filters, fs),
    doc: (id: string) => ({
      get: async () => ({ exists: !!STORE[col]?.[id], data: () => (STORE[col]?.[id] ? { ...STORE[col]![id] } : undefined) }),
    }),
    get: async () => {
      const rows = STORE[col] ?? {}
      const docs = Object.keys(rows)
        .filter(id => filters.every(([f, v]) => rows[id]![f] === v))
        .map(id => ({
          id,
          data: () => (fields ? Object.fromEntries(fields.filter(f => f in rows[id]!).map(f => [f, rows[id]![f]])) : { ...rows[id] }),
        }))
      return { docs, size: docs.length }
    },
  }
}
const db: any = { collection: (col: string) => query(col) }

const { updateSourceSettings } = await import('./ai-knowledge-sources')
const { runIndexOnChunk, invalidateSourceProductCache } = await import('./ai-knowledge-chunks')
const { recordAiUsage } = await import('./ai-usage')
const { writeAuditLog } = await import('./audit-log')
const { fillProductNameFromGroup } = await import('./ai-knowledge-product-group')

const WS = 'ws1'
const COFFEE = '珈樂堤 小滑手全自動義式咖啡機'

function seed(opts: { folder?: Doc; me?: Doc; siblings?: string[] } = {}) {
  STORE.knowledgeFolders = { f1: { workspaceId: WS, name: '小滑手', order: 0, ...opts.folder } }
  STORE.knowledgeSources = {
    me: { workspaceId: WS, folderId: 'f1', name: '小滑手說明書.pdf', productName: '', ...opts.me },
  }
  for (const [i, n] of (opts.siblings ?? [COFFEE, COFFEE]).entries()) {
    STORE.knowledgeSources[`sib${i}`] = { workspaceId: WS, folderId: 'f1', name: `其他${i}`, productName: n }
  }
  // 別家同名資料夾 id 的來源：⛔ 不能算進同組
  STORE.knowledgeSources.other = { workspaceId: 'ws2', folderId: 'f1', productName: '別家的機器' }
  STORE.knowledgeChunks = {
    c1: { workspaceId: WS, sourceId: 'me', title: '清潔', content: '蒸汽管怎麼清', status: 'indexed' },
    c2: { workspaceId: WS, sourceId: 'me', title: '尺寸', content: '寬 285mm', status: 'indexed' },
    c3: { workspaceId: WS, sourceId: 'me', title: '舊活動', content: '早鳥價', status: 'disabled' },
    c4: { workspaceId: WS, sourceId: 'sib0', title: '別份', content: '不該重學', status: 'indexed' },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(STORE)) delete STORE[k]
})

describe('fillProductNameFromGroup（C-320）', () => {
  it('① 商品分組、自己空的、同組只有一種 → 補上、這份每一條重新學習（停用的跳過）、稽核', async () => {
    seed()
    const res = await fillProductNameFromGroup(db, WS, 'me', { uid: 'staff-1' })

    expect(res).toMatchObject({ filled: true, productName: COFFEE, relearned: { total: 3, skipped: 1, indexed: 2, failed: 0 } })
    expect(updateSourceSettings).toHaveBeenCalledWith(db, WS, 'me', { productName: COFFEE })
    expect(vi.mocked(runIndexOnChunk).mock.calls.map(c => c[1]).sort()).toEqual(['c1', 'c2'])
    expect(invalidateSourceProductCache).toHaveBeenCalledWith('me')
    expect(recordAiUsage).toHaveBeenCalledWith(WS, { buildEmbeddingTokens: 20 }, db)
    const audit = vi.mocked(writeAuditLog).mock.calls[0]![0]
    expect(audit).toMatchObject({ action: 'source.put', targetId: 'me', after: { productName: COFFEE } })
    expect(audit.note).toBe(`小滑手說明書.pdf：放進「小滑手」，所屬產品照同組補成「${COFFEE}」，重新學習 2 條`)
  })

  const untouched = () => {
    expect(updateSourceSettings).not.toHaveBeenCalled()
    expect(runIndexOnChunk).not.toHaveBeenCalled()
    expect(writeAuditLog).not.toHaveBeenCalled()
  }

  it('② ⛔ 已經填好的不覆蓋', async () => {
    seed({ me: { productName: '小滑手' } })
    expect(await fillProductNameFromGroup(db, WS, 'me', { uid: 'u' })).toEqual({ filled: false, reason: 'has-name' })
    untouched()
  })

  it('② ⛔ 同組兩款（MATELASER）→ 不補，回同組有哪幾種', async () => {
    seed({ folder: { name: 'MATELASER' }, siblings: ['MATELASER W1 REGEN', 'MATELASER W1 REGEN ULTRA'] })
    expect(await fillProductNameFromGroup(db, WS, 'me', { uid: 'u' }))
      .toEqual({ filled: false, reason: 'ambiguous', names: ['MATELASER W1 REGEN', 'MATELASER W1 REGEN ULTRA'] })
    untouched()
  })

  it('② 同組沒人填過 → 不補（⛔ 不拿資料夾名頂替）', async () => {
    seed({ siblings: ['', ''] })
    expect(await fillProductNameFromGroup(db, WS, 'me', { uid: 'u' })).toEqual({ filled: false, reason: 'no-names', names: [] })
    untouched()
  })

  it('② 通用分組、未分類、型錄、別家的資料夾 → 不補', async () => {
    seed({ folder: { general: true } })
    expect(await fillProductNameFromGroup(db, WS, 'me', { uid: 'u' })).toEqual({ filled: false, reason: 'general' })

    seed({ me: { folderId: null } })
    expect(await fillProductNameFromGroup(db, WS, 'me', { uid: 'u' })).toEqual({ filled: false, reason: 'no-group' })

    seed({ me: { generateOverview: true } })
    expect(await fillProductNameFromGroup(db, WS, 'me', { uid: 'u' })).toEqual({ filled: false, reason: 'catalog' })

    seed({ folder: { workspaceId: 'ws2' } })
    expect(await fillProductNameFromGroup(db, WS, 'me', { uid: 'u' })).toEqual({ filled: false, reason: 'no-group' })

    expect(await fillProductNameFromGroup(db, WS, 'gone', { uid: 'u' })).toEqual({ filled: false, reason: 'not-found' })
    untouched()
  })

  it('③ 重新學習有失敗的：照實回、稽核寫失敗條數', async () => {
    seed()
    vi.mocked(runIndexOnChunk).mockImplementation(async (_db: unknown, id: string) =>
      id === 'c2' ? { id, status: 'failed', failureReason: 'embed failed', embeddingTokens: 0 } : { id, status: 'indexed', embeddingTokens: 10 })
    const res = await fillProductNameFromGroup(db, WS, 'me', { uid: 'u' })
    expect(res).toMatchObject({ filled: true, relearned: { indexed: 1, failed: 1, failures: [{ id: 'c2' }] } })
    expect(vi.mocked(writeAuditLog).mock.calls[0]![0].note).toContain('重新學習 1 條、失敗 1 條')
  })
})
