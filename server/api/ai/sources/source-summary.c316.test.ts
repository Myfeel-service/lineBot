import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 「這份在講什麼」（`C-316`，2026-10-15 老闆拍板 D-126：點開一份資料先看摘要，示意頁 ②）。
 *
 * PUT /api/ai/sources/:id `{ generateSummary: true }`：從這份上線中的條目整理最多 3 行、每行 30 字內，存在資料上。
 * 釘住：① 只拿上線中的條目（等你看過、停用、沒學起來、回收桶的不算）② 已經有就不再花錢、force 才重整理
 * ③ AI 失敗不回 500（summaryFailed）、什麼都不存 ④ 不動 updatedAt（清單照它排）⑤ 這是單獨一個動作，不順手改設定
 * ⑥ 清單／明細都帶得出 summary、summaryAt。
 * 跑在記憶體裡的假 Firestore 上，AI 是假的（不連網），正式庫零讀零寫。
 */

const WS = 'ws1'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__del__' },
  Timestamp: { fromMillis: (ms: number) => ({ __ts: ms }) },
}))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: WS, uid: 'staff-1' })),
}))
vi.mock('~~/server/utils/audit-log', async importOriginal => ({
  ...(await importOriginal<typeof import('~~/server/utils/audit-log')>()),
  writeAuditLog: vi.fn(async () => {}),
}))
vi.mock('~~/server/utils/knowledge-source-files', () => ({ deleteSourceFiles: vi.fn(async () => {}) }))
vi.mock('~~/server/utils/ai-knowledge-chunks', () => ({
  KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks',
  addWorkspaceProductName: vi.fn(async () => {}),
  buildChunkSoftDeletePatch: vi.fn(),
  invalidateSourceProductCache: vi.fn(),
  invalidateTagIndexCache: vi.fn(),
}))
vi.mock('~~/server/utils/gemini', () => ({
  generateJson: vi.fn(),
  runWithLlmBudget: vi.fn((_ws: string, fn: () => Promise<unknown>) => fn()),
}))
vi.mock('~~/server/utils/ai-usage', () => ({ recordAiUsage: vi.fn(async () => {}) }))

const STORE: Record<string, Record<string, Record<string, any>>> = {}
function docRef(col: string, id: string): any {
  return {
    id,
    get: async () => ({ id, exists: !!STORE[col]?.[id], data: () => STORE[col]?.[id] }),
    update: async (p: Record<string, any>) => {
      if (!STORE[col]?.[id]) throw new Error('NOT_FOUND')
      for (const [k, v] of Object.entries(p)) {
        if (v === '__del__') delete STORE[col][id]![k]
        else STORE[col][id]![k] = v
      }
    },
  }
}
function query(col: string, filters: Array<[string, unknown]> = []): any {
  return {
    where: (f: string, _op: string, v: unknown) => query(col, [...filters, [f, v]]),
    get: async () => {
      const docs = Object.entries(STORE[col] ?? {})
        .filter(([, d]) => filters.every(([f, v]) => d[f] === v))
        .map(([id, d]) => ({ id, data: () => d, ref: docRef(col, id) }))
      return { empty: !docs.length, size: docs.length, docs }
    },
  }
}
const db: any = {
  collection: (col: string) => ({ doc: (id: string) => docRef(col, id), where: (f: string, op: string, v: unknown) => query(col).where(f, op, v) }),
}
vi.mock('~~/server/utils/firebase', () => ({ getDb: () => db }))

let body: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('readBody', async () => body)
vi.stubGlobal('getRouterParam', () => 'src1')
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { generateJson, runWithLlmBudget } = await import('~~/server/utils/gemini')
const { recordAiUsage } = await import('~~/server/utils/ai-usage')
const { writeAuditLog } = await import('~~/server/utils/audit-log')
const { docToSourceSummary } = await import('~~/server/utils/ai-knowledge-sources')
const { default: putHandler } = await import('./[sourceId].put')
const { default: getHandler } = await import('./[sourceId].get')
const run = (h: unknown) => (h as (e: unknown) => Promise<any>)({})
const llm = vi.mocked(generateJson)
const promptSent = () => String(llm.mock.calls[0]![0])

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(STORE)) delete STORE[k]
  STORE.knowledgeSources = {
    src1: { workspaceId: WS, type: 'file', name: 'SHARP 乾淨方MAX 說明書.pdf', updatedAt: 'old-ts', chunkCount: 5 },
  }
  STORE.knowledgeChunks = {
    a: { workspaceId: WS, sourceId: 'src1', status: 'indexed', title: '後進氣面板清潔', content: '重點：頻率：2 週｜工具：吸塵器\n\n建議大約每2週清潔一次後進氣面板。' },
    b: { workspaceId: WS, sourceId: 'src1', status: 'indexed', title: '過濾網安裝順序', content: '先裝集塵過濾網，再裝活性碳脫臭過濾網。' },
    d: { workspaceId: WS, sourceId: 'src1', status: 'draft', title: '等你看過的那條', content: '還沒點頭' },
    x: { workspaceId: WS, sourceId: 'src1', status: 'disabled', title: '停用的那條', content: '過期了' },
    f: { workspaceId: WS, sourceId: 'src1', status: 'failed', title: '沒學起來的那條', content: '失敗' },
    r: { workspaceId: WS, sourceId: 'src1', status: 'indexed', title: '回收桶裡的那條', content: '刪掉了', deletedAt: 'ts' },
    other: { workspaceId: WS, sourceId: 'src2', status: 'indexed', title: '別份資料的', content: '不相干' },
  }
  llm.mockResolvedValue({
    data: { lines: ['• SHARP 變頻除濕機的使用說明（除濕＋空氣清淨）', '2. 過濾網與後進氣面板怎麼保養、怎麼裝', '故障排除：無法除濕、過濾網有氣味、顯示面板各個燈號代表的意思與處理方式', '第四行不要'] },
    inputTokens: 321,
    outputTokens: 45,
  } as any)
})

describe('整理「這份在講什麼」（C-316）', () => {
  it('沒有摘要 → 用最便宜的模型整理、收乾淨（去符號、最多 3 行、每行 30 字內）、存起來、記帳記在整理那一格', async () => {
    body = { generateSummary: true }
    const r = await run(putHandler)

    const want = [
      'SHARP 變頻除濕機的使用說明（除濕＋空氣清淨）',
      '過濾網與後進氣面板怎麼保養、怎麼裝',
      // 超過 30 字的截在 29 字＋「…」（剛好 30 字的不截）
      '故障排除：無法除濕、過濾網有氣味、顯示面板各個燈號代表的意…',
    ]
    expect(r.summary).toEqual(want)
    expect(r.summary.every((l: string) => Array.from(l).length <= 30)).toBe(true)
    expect(r.summaryAt).toBeGreaterThan(0)
    expect(r).not.toHaveProperty('summaryFailed')
    expect(STORE.knowledgeSources!.src1).toMatchObject({ summary: want, summaryAt: '__ts__' })

    expect(llm.mock.calls[0]![1]).toMatchObject({ model: 'gemini-2.5-flash-lite', thinkingBudget: 0 })
    // 整理一份資料的摘要＝店家加資料那本帳（`C-413`）
    expect(runWithLlmBudget).toHaveBeenCalledWith(WS, expect.any(Function), 'knowledge')
    expect(recordAiUsage).toHaveBeenCalledWith(WS, { inputTokens: 321, outputTokens: 45, importInputTokens: 321, importOutputTokens: 45 })
  })

  it('① 只拿上線中的條目：等你看過、停用、沒學起來、回收桶、別份資料的都不送', async () => {
    body = { generateSummary: true }
    await run(putHandler)
    const p = promptSent()
    expect(p).toContain('後進氣面板清潔')
    expect(p).toContain('過濾網安裝順序')
    expect(p).toContain('SHARP 乾淨方MAX 說明書.pdf')
    for (const no of ['等你看過的那條', '停用的那條', '沒學起來的那條', '回收桶裡的那條', '別份資料的']) expect(p).not.toContain(no)
    // 內容開頭取敘述那一句（「重點：」那一行是關鍵字串，不是在講什麼）
    expect(p).toContain('建議大約每2週清潔一次後進氣面板')
    expect(p).not.toContain('重點：')
  })

  it('② 已經有摘要 → 直接回存著的那份，不打 AI；force 才重整理', async () => {
    STORE.knowledgeSources!.src1!.summary = ['舊的第一行', '舊的第二行']
    STORE.knowledgeSources!.src1!.summaryAt = { toMillis: () => 1_700_000_000_000 }
    body = { generateSummary: true }
    expect(await run(putHandler)).toEqual({ summary: ['舊的第一行', '舊的第二行'], summaryAt: 1_700_000_000_000 })
    expect(llm).not.toHaveBeenCalled()

    body = { generateSummary: true, force: true }
    const r = await run(putHandler)
    expect(llm).toHaveBeenCalledTimes(1)
    expect(r.summary[0]).toBe('SHARP 變頻除濕機的使用說明（除濕＋空氣清淨）')
  })

  it('③ AI 失敗（服務掛了、超過維運額度）→ 不回 500，回 summaryFailed、什麼都不存', async () => {
    llm.mockRejectedValueOnce(Object.assign(new Error('Gemini 503'), { statusCode: 502 }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    body = { generateSummary: true }
    await expect(run(putHandler)).resolves.toEqual({ summary: [], summaryAt: 0, summaryFailed: true })
    expect(STORE.knowledgeSources!.src1).not.toHaveProperty('summary')
    warn.mockRestore()
  })

  it('③ AI 回空的（或全是空行）→ 一樣當失敗，不存一份空摘要（存了之後就永遠不會再整理）', async () => {
    llm.mockResolvedValueOnce({ data: { lines: ['  ', '- '] }, inputTokens: 1, outputTokens: 1 } as any)
    body = { generateSummary: true }
    await expect(run(putHandler)).resolves.toEqual({ summary: [], summaryAt: 0, summaryFailed: true })
    expect(STORE.knowledgeSources!.src1).not.toHaveProperty('summary')
  })

  it('行首的數字是內容不是編號時不拿掉（「2.4GHz」「3.5 吋」；/code-review 第 10 條）', async () => {
    llm.mockResolvedValueOnce({ data: { lines: ['2.4GHz 無線連線與配對', '3.5 吋螢幕操作', '1. 開機與設定'] }, inputTokens: 1, outputTokens: 1 } as any)
    body = { generateSummary: true }
    const r = await run(putHandler)
    expect(r.summary).toEqual(['2.4GHz 無線連線與配對', '3.5 吋螢幕操作', '開機與設定'])
  })

  it('這份沒有上線中的條目 → 不打 AI、回空的（不算失敗）', async () => {
    for (const id of ['a', 'b']) STORE.knowledgeChunks![id]!.status = 'draft'
    body = { generateSummary: true }
    await expect(run(putHandler)).resolves.toEqual({ summary: [], summaryAt: 0 })
    expect(llm).not.toHaveBeenCalled()
  })

  it('④ 不動 updatedAt（資料清單照它排，整理摘要不該讓這份跳到最上面）', async () => {
    body = { generateSummary: true }
    await run(putHandler)
    expect(STORE.knowledgeSources!.src1!.updatedAt).toBe('old-ts')
  })

  it('⑤ 是單獨一個動作：同一個請求帶的名稱不改、也不寫操作紀錄', async () => {
    body = { generateSummary: true, name: '不該被改的名字' }
    await run(putHandler)
    expect(STORE.knowledgeSources!.src1!.name).toBe('SHARP 乾淨方MAX 說明書.pdf')
    expect(writeAuditLog).not.toHaveBeenCalled()
  })

  it('找不到這份（或是別的帳號的）→ 404', async () => {
    STORE.knowledgeSources!.src1!.workspaceId = 'someone-else'
    body = { generateSummary: true }
    await expect(run(putHandler)).rejects.toMatchObject({ statusCode: 404 })
    expect(llm).not.toHaveBeenCalled()
  })

  it('沒帶 generateSummary → 照舊改設定，不打 AI', async () => {
    body = { name: '新名字' }
    const r = await run(putHandler)
    expect(r.name).toBe('新名字')
    expect(llm).not.toHaveBeenCalled()
  })
})

describe('清單／明細帶得出摘要（⑥）', () => {
  it('docToSourceSummary：有值照給（去空白、最多 3 行）、沒有給預設', () => {
    expect(docToSourceSummary('x', { summary: [' A ', '', 'B', 'C', 'D'], summaryAt: { toMillis: () => 123 } } as any))
      .toMatchObject({ summary: ['A', 'B', 'C'], summaryAt: 123 })
    expect(docToSourceSummary('x', {} as any)).toMatchObject({ summary: [], summaryAt: 0 })
    expect(docToSourceSummary('x', { summary: 'not-an-array' } as any)).toMatchObject({ summary: [] })
  })

  it('GET 明細：source 裡就有 summary', async () => {
    STORE.knowledgeSources!.src1!.summary = ['這份在講濾網']
    const r = await run(getHandler)
    expect(r.source).toMatchObject({ summary: ['這份在講濾網'], summaryAt: 0 })
  })
})
