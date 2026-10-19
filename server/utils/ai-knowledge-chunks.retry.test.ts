/**
 * 排程自動重試學失敗的知識（`retryStuckChunks`，`D-129` 2026-10-19 放寬）。
 *
 * 要釘住的事：
 *  ① 份量：一輪最多打 100 次（以前 20 次＝10-16 搬家 281 條要 15 輪、2 個半小時）→ 281 條 3 輪補完；
 *  ② 速率：同時最多 5 條；時間到（15 秒）就不再開新的；
 *  ③ 次數：每條最多自動試 5 次（含第一次失敗），第 5 次失敗那一刻起才算「試完了」（畫面這時才給按鈕），排程不再撿它；
 *  ④ AI 服務在出事時（開頭連續失敗、一條都沒成功）這輪先停，不把每一條的 5 次機會一起燒光；
 *  ⑤ 本月 AI 整理用量用完的帳號整個跳過、不耗次數；
 *  ⑥ 操作紀錄：有學會的、剛好試完的才記（系統排程），只是又失敗一次不記。
 * 跑在記憶體裡的假 Firestore 上，embedDocument 是假的，正式庫零讀零寫、不連網。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => ({ __op: 'ts' }),
    delete: () => ({ __op: 'del' }),
    vector: (v: number[]) => ({ __op: 'vec', v }),
    increment: (n: number) => ({ __op: 'inc', n }),
  },
  Timestamp: { fromMillis: (ms: number) => ({ __ts: ms }) },
}))

const { embedDocument, getMaintenanceBudgetStatus, writeAuditLog, recordAiUsage } = vi.hoisted(() => ({
  embedDocument: vi.fn(),
  getMaintenanceBudgetStatus: vi.fn(),
  writeAuditLog: vi.fn(async () => {}),
  recordAiUsage: vi.fn(async () => {}),
}))
vi.mock('./gemini', () => ({
  embedDocument,
  estimateTokens: (t: string) => t.length,
  runWithLlmBudget: (_ws: string, fn: () => Promise<unknown>) => fn(),
}))
vi.mock('./ai-usage', () => ({ recordAiUsage, getMaintenanceBudgetStatus }))
vi.mock('./audit-log', () => ({ writeAuditLog }))
vi.mock('./ai-product-alias', () => ({
  getProductAliases: vi.fn(async () => ({ aliases: {} })),
  canonicalProductName: (s: string) => s,
  normalizeProductName: (s: string) => s,
}))

import { MAX_AUTO_RETRIES, RETRY_BATCH, RETRY_CONCURRENCY, retryStuckChunks, updateKnowledgeChunk } from './ai-knowledge-chunks'
import { isAutoRetryExhausted } from '~~/shared/knowledge-relearn'

type Row = Record<string, any>
let STORE: Record<string, Row> = {}
const QUERIES: Array<{ filters: Array<[string, string, unknown]>; limit: number; fields: string[] | null }> = []

const toMs = (v: any) => (v instanceof Date ? v.getTime() : typeof v?.toMillis === 'function' ? v.toMillis() : Number(v))
function apply(row: Row, data: Row) {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && v.__op === 'del') delete row[k]
    else if (v && typeof v === 'object' && v.__op === 'inc') row[k] = Number(row[k] ?? 0) + v.n
    else row[k] = v
  }
}
function chunkRef(id: string) {
  return {
    get: async () => ({ exists: !!STORE[id], data: () => (STORE[id] ? { ...STORE[id] } : undefined) }),
    update: async (data: Row) => { apply(STORE[id]!, data) },
  }
}
function query(col: string, filters: Array<[string, string, unknown]> = [], limit = Infinity, fields: string[] | null = null): any {
  return {
    where: (f: string, op: string, v: unknown) => query(col, [...filters, [f, op, v]], limit, fields),
    select: (...fs: string[]) => query(col, filters, limit, fs),
    limit: (n: number) => query(col, filters, n, fields),
    orderBy: () => query(col, filters, limit, fields),
    doc: (id: string) => (col === 'knowledgeChunks' ? chunkRef(id) : { get: async () => ({ exists: false, data: () => undefined }) }),
    get: async () => {
      // 只有知識卡這一個集合有資料；別的（商品名掃描讀的來源）回空——runIndexOnChunk 讀不到就照原文學
      if (col !== 'knowledgeChunks') return { docs: [], size: 0 }
      QUERIES.push({ filters, limit, fields })
      const ids = Object.keys(STORE).filter(id => filters.every(([f, op, v]) => {
        const x = STORE[id]![f]
        if (op === '==') return x === v
        if (op === '<') return x !== undefined && toMs(x) < toMs(v)
        return true
      }))
      // retryCount 是不等式欄位：Firestore 照它排（小的先）
      if (filters.some(([f, op]) => f === 'retryCount' && op === '<')) ids.sort((a, b) => STORE[a]!.retryCount - STORE[b]!.retryCount)
      const docs = ids.slice(0, limit).map(id => ({
        id,
        ref: chunkRef(id),
        data: () => (fields ? Object.fromEntries(fields.filter(f => f in STORE[id]!).map(f => [f, STORE[id]![f]])) : { ...STORE[id] }),
      }))
      return { docs, size: docs.length }
    },
  }
}
const db: any = { collection: (col: string) => query(col) }

/** n 條學失敗的（第一次失敗＝retryCount 1，跟加入知識時失敗一樣） */
function seedFailed(n: number, opts: { ws?: string; retryCount?: number; prefix?: string } = {}) {
  for (let i = 0; i < n; i++) {
    STORE[`${opts.prefix ?? 'f'}${i}`] = {
      workspaceId: opts.ws ?? 'ws1',
      title: `第 ${i} 條`,
      content: `內容 ${i}`,
      status: 'failed',
      failureReason: 'Gemini embed: 503',
      retryCount: opts.retryCount ?? 1,
    }
  }
}
const statuses = () => Object.values(STORE).map(r => r.status)

beforeEach(() => {
  STORE = {}
  QUERIES.length = 0
  vi.clearAllMocks()
  embedDocument.mockReset()
  embedDocument.mockResolvedValue([0.1, 0.2])
  getMaintenanceBudgetStatus.mockReset()
  getMaintenanceBudgetStatus.mockResolvedValue({ used: 0, cap: 1, blocked: false })
})

describe('① 份量：一輪 100 次，281 條 3 輪補完（以前一輪 20 條＝15 輪、2 個半小時）', () => {
  it('數字本身（理由寫在 RETRY_BATCH 上面那段）', () => {
    expect(RETRY_BATCH).toBe(100)
    expect(RETRY_CONCURRENCY).toBe(5)
    expect(MAX_AUTO_RETRIES).toBe(5)
  })

  it('查詢只撿還沒試完的（retryCount < 5）、每種最多 100 條、⛔ 不讀向量', async () => {
    await retryStuckChunks(db)
    const failedQ = QUERIES.find(q => q.filters.some(([f, , v]) => f === 'status' && v === 'failed'))!
    expect(failedQ.filters).toContainEqual(['retryCount', '<', 5])
    expect(failedQ.limit).toBe(100)
    expect(failedQ.fields).not.toContain('embedding')
    const pendingQ = QUERIES.find(q => q.filters.some(([f, , v]) => f === 'status' && v === 'pending'))!
    expect(pendingQ.limit).toBe(100)
  })

  it('10-16 搬家那種 281 條：第 1、2 輪各學會 100 條、第 3 輪 81 條＝3 輪（30 分鐘）全部補完', async () => {
    seedFailed(281)
    const rounds: number[] = []
    for (let i = 0; i < 5 && statuses().includes('failed'); i++) rounds.push((await retryStuckChunks(db)).indexed)
    expect(rounds).toEqual([100, 100, 81])
    expect(statuses().every(s => s === 'indexed')).toBe(true)
    expect(embedDocument).toHaveBeenCalledTimes(281) // ⛔ 份量放寬不多花錢：每條只學一次
  })

  it('failed、卡住的 pending 合計也只打 100 次（客人問問題也走同一個模型，留額度給他們）', async () => {
    seedFailed(80)
    for (let i = 0; i < 80; i++) STORE[`p${i}`] = { workspaceId: 'ws1', title: 't', content: 'c', status: 'pending', updatedAt: new Date(Date.now() - 3_600_000) }
    const r = await retryStuckChunks(db)
    expect(embedDocument).toHaveBeenCalledTimes(100)
    expect(r).toMatchObject({ scanned: 160, indexed: 100, deferred: 60 })
  })
})

describe('② 速率與時限', () => {
  it('同時最多 5 條', async () => {
    seedFailed(30)
    let inFlight = 0
    let peak = 0
    embedDocument.mockImplementation(async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise(r => setTimeout(r, 2))
      inFlight--
      return [0.1]
    })
    await retryStuckChunks(db)
    expect(peak).toBe(5)
  })

  it('過了 15 秒就不再開新的（已經開始的做完），沒輪到的下一輪再撿', async () => {
    seedFailed(50)
    let clock = 0
    embedDocument.mockImplementation(async () => { clock += 1000; return [0.1] }) // 一條「花」1 秒
    const r = await retryStuckChunks(db, { concurrency: 1, now: () => clock })
    expect(r.indexed).toBe(15)
    expect(r.deferred).toBe(35)
    expect(statuses().filter(s => s === 'failed')).toHaveLength(35)
  })
})

describe('③ 次數：試完 5 次才算「要人看」（畫面這時才給按鈕）', () => {
  it('加入時失敗一次（1）→ 排程再試 4 輪都失敗 → 第 4 輪那一刻才變成「試完了」，第 5 輪不再撿', async () => {
    seedFailed(1)
    embedDocument.mockRejectedValue(new Error('Gemini embed: 503'))
    const seen: Array<{ count: number; exhausted: boolean; roundExhausted: number }> = []
    for (let round = 1; round <= 5; round++) {
      const r = await retryStuckChunks(db, { circuitBreakAfter: 99 })
      seen.push({ count: STORE.f0!.retryCount, exhausted: isAutoRetryExhausted(STORE.f0), roundExhausted: r.exhausted })
    }
    expect(seen).toEqual([
      { count: 2, exhausted: false, roundExhausted: 0 },
      { count: 3, exhausted: false, roundExhausted: 0 },
      { count: 4, exhausted: false, roundExhausted: 0 },
      { count: 5, exhausted: true, roundExhausted: 1 },
      { count: 5, exhausted: true, roundExhausted: 0 }, // 不再撿：次數停在 5
    ])
    expect(embedDocument).toHaveBeenCalledTimes(4)
  })

  it('中途學會了就歸零（不留「試過幾次」）', async () => {
    seedFailed(1, { retryCount: 4 })
    await retryStuckChunks(db)
    expect(STORE.f0).toMatchObject({ status: 'indexed' })
    expect(STORE.f0!.retryCount).toBeUndefined()
  })

  it('試完 5 次的那一條，店家照建議改了內容再存 → 次數從頭算（改完剛好碰到 AI 忙，也還是回到「系統會自己再試」）', async () => {
    seedFailed(1, { retryCount: 5 })
    embedDocument.mockRejectedValue(new Error('Gemini embed: 503'))
    await updateKnowledgeChunk(db, { chunkId: 'f0', title: '第 0 條', content: '改過的內容', contentChanged: true, manualEdit: true })
    expect(STORE.f0).toMatchObject({ status: 'failed', retryCount: 1 })
    expect(isAutoRetryExhausted(STORE.f0)).toBe(false)
  })

  it('空內容推不動：當場標成試完（不佔下一輪名額）', async () => {
    STORE.e = { workspaceId: 'ws1', title: '空的', content: '', status: 'failed', retryCount: 1 }
    const r = await retryStuckChunks(db)
    expect(STORE.e!.retryCount).toBe(MAX_AUTO_RETRIES)
    expect(r.exhausted).toBe(1)
    expect(embedDocument).not.toHaveBeenCalled()
  })
})

describe('④ AI 服務在出事：這輪先停', () => {
  it('開頭連續 10 條失敗、一條都沒成功 → 停（同時在跑的幾條做完），剩下的不耗次數', async () => {
    seedFailed(100)
    embedDocument.mockRejectedValue(new Error('Gemini embed: 503'))
    const r = await retryStuckChunks(db)
    expect(r.circuitBroken).toBe(true)
    expect(r.failed).toBeGreaterThanOrEqual(10)
    expect(r.failed).toBeLessThan(10 + RETRY_CONCURRENCY)
    const untouched = Object.values(STORE).filter(x => x.retryCount === 1).length
    expect(untouched).toBe(100 - r.failed)
  })

  it('有成功的就不停（只是那幾條本身有問題）', async () => {
    seedFailed(40)
    embedDocument.mockImplementation(async (text: string) => {
      if (/第 [0-9]?[13579] 條/.test(text)) throw new Error('Gemini embed: 400 invalid')
      return [0.1]
    })
    const r = await retryStuckChunks(db, { concurrency: 1 })
    expect(r.circuitBroken).toBe(false)
    expect(r.indexed + r.failed).toBe(40)
  })
})

describe('⑤ 本月 AI 整理用量用完的帳號：整個跳過、不耗次數', () => {
  it('擋下的那一家不打、次數不動；別家照常', async () => {
    seedFailed(3, { ws: 'full', prefix: 'x' })
    seedFailed(2, { ws: 'ok', prefix: 'y' })
    getMaintenanceBudgetStatus.mockImplementation(async (ws: string) => ({ used: 9, cap: 1, blocked: ws === 'full' }))
    const r = await retryStuckChunks(db)
    expect(r).toMatchObject({ indexed: 2, skippedBudget: 3 })
    expect(['x0', 'x1', 'x2'].map(id => STORE[id]!.retryCount)).toEqual([1, 1, 1])
    expect(getMaintenanceBudgetStatus).toHaveBeenCalledTimes(2) // 一家查一次
  })
})

describe('⑥ 操作紀錄', () => {
  it('學會的、剛好試完的：每家記一筆（系統排程，不掛在任何人頭上）', async () => {
    seedFailed(2, { ws: 'a', prefix: 'a' })
    STORE.b0 = { workspaceId: 'b', title: '壞的', content: '內容', status: 'failed', retryCount: 4 }
    embedDocument.mockImplementation(async (text: string) => {
      if (text.includes('壞的')) throw new Error('Gemini embed: 400')
      return [0.1]
    })
    await retryStuckChunks(db)
    const calls = writeAuditLog.mock.calls.map(c => (c as unknown as [Record<string, any>])[0])
    expect(calls).toHaveLength(2)
    const a = calls.find(c => c.workspaceId === 'a')!
    expect(a).toMatchObject({ actor: 'system', uid: '', action: 'knowledge.autoRetry' })
    expect(a.note).toBe('之前沒學會的知識，系統自己再試：學會 2 條')
    const b = calls.find(c => c.workspaceId === 'b')!
    expect(b.note).toBe('之前沒學會的知識，系統自己再試：學會 0 條；1 條試了 5 次都沒學會，要人看一下（知識庫「要處理的事」）')
  })

  it('只是又失敗一次（還會再試）：不記——服務出事時不要每 10 分鐘洗一筆', async () => {
    seedFailed(3)
    embedDocument.mockRejectedValue(new Error('Gemini embed: 503'))
    await retryStuckChunks(db)
    expect(writeAuditLog).not.toHaveBeenCalled()
  })
})
