/**
 * C-40(c) 跨來源重複偵測——三層漏斗。
 * 釘住的行為：①向量候選門檻與上限 ②同來源同產品不報（切卡粒度不是重複）
 * ③LLM 判官只有 same 才出建議（different/unsure 都不出＝寧可漏不可誤）
 * ④指紋沒變整輪跳過＝零 LLM 費 ⑤忽略過的組合不再報。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as any).createError ??= (opts: { statusCode?: number; statusMessage?: string }) =>
  Object.assign(new Error(opts?.statusMessage ?? 'error'), opts)

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __op: 'ts' }) },
}))

const { generateJson } = vi.hoisted(() => ({ generateJson: vi.fn() }))
vi.mock('./gemini', () => ({
  generateJson,
  runWithLlmBudget: (_ws: string, fn: () => Promise<unknown>) => fn(),
}))
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn(async () => {}) }))
vi.mock('./ai-knowledge-chunks', () => ({ KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks' }))

import {
  cardSetFingerprint,
  classifyPair,
  cosineSim,
  DUP_MAX_CANDIDATES,
  dupPairKey,
  runDuplicateScan,
  topSimilarPairs,
  type DupCardLite, titleModelConflict } from './ai-duplicate-scan'

const vec = (...v: number[]) => v
const card = (id: string, over: Partial<DupCardLite> = {}): DupCardLite => ({
  id,
  title: `卡${id}`,
  productName: '',
  sourceId: `src-${id}`,
  firstLine: '重點：測試',
  embedding: vec(1, 0, 0),
  ...over,
})

describe('cosineSim / topSimilarPairs', () => {
  it('同向 = 1、正交 = 0；未單位化也算對', () => {
    expect(cosineSim([2, 0], [5, 0])).toBeCloseTo(1)
    expect(cosineSim([1, 0], [0, 3])).toBeCloseTo(0)
  })
  it('只收 ≥ 門檻的組合、分數高的優先、有上限', () => {
    const cards = [
      card('a', { embedding: vec(1, 0, 0) }),
      card('b', { embedding: vec(0.99, 0.14, 0) }), // 與 a 約 0.99
      card('c', { embedding: vec(0, 1, 0) }), // 與誰都不像
    ]
    const pairs = topSimilarPairs(cards, 0.9, DUP_MAX_CANDIDATES)
    expect(pairs).toHaveLength(1)
    expect(dupPairKey(pairs[0]!.a.id, pairs[0]!.b.id)).toBe('a~b')
  })
})

describe('classifyPair', () => {
  it('兩邊產品名都有且不同 → product_split（同一台兩個名字）', () => {
    expect(classifyPair(
      card('a', { productName: '上好ㄟ抽取式除濕機' }),
      card('b', { productName: 'NWT 威技 除濕機' }),
    )).toBe('product_split')
  })
  it('同產品（或有一邊沒掛）→ duplicate_cards；⛔同一來源內不報（切卡粒度不是重複）', () => {
    expect(classifyPair(
      card('a', { productName: 'GPLUS 除濕機' }),
      card('b', { productName: 'GPLUS 除濕機' }),
    )).toBe('duplicate_cards')
    expect(classifyPair(
      card('a', { sourceId: 'same', productName: 'GPLUS 除濕機' }),
      card('b', { sourceId: 'same', productName: 'GPLUS 除濕機' }),
    )).toBe(null)
  })
})

describe('cardSetFingerprint', () => {
  it('與順序無關；內容變了指紋就變', () => {
    const a = [{ id: 'x', updatedAtMs: 1 }, { id: 'y', updatedAtMs: 2 }]
    const b = [{ id: 'y', updatedAtMs: 2 }, { id: 'x', updatedAtMs: 1 }]
    expect(cardSetFingerprint(a)).toBe(cardSetFingerprint(b))
    expect(cardSetFingerprint([{ id: 'x', updatedAtMs: 9 }, { id: 'y', updatedAtMs: 2 }]))
      .not.toBe(cardSetFingerprint(a))
  })
})

// ── 完整掃描流程 ────────────────────────────────────────

function makeScanDb(opts: {
  prev?: Record<string, unknown> | null
  chunks: Array<{ id: string; data: Record<string, unknown> }>
}) {
  const writes: Array<Record<string, unknown>> = []
  const db: any = {
    collection: (col: string) => ({
      doc: () => ({
        get: async () => ({ exists: opts.prev != null, data: () => opts.prev ?? undefined }),
        set: async (payload: Record<string, unknown>) => { writes.push(payload) },
      }),
      where: () => ({
        where: () => ({
          select: () => ({
            limit: () => ({
              get: async () => ({
                size: opts.chunks.length,
                docs: opts.chunks.map(c => ({ id: c.id, data: () => c.data })),
              }),
            }),
          }),
        }),
      }),
    }),
  }
  return { db, writes }
}

const chunkDoc = (id: string, emb: number[], over: Record<string, unknown> = {}) => ({
  id,
  data: {
    title: `卡${id}`,
    productName: '',
    sourceId: `src-${id}`,
    content: '重點：內容',
    embedding: emb,
    updatedAt: { toMillis: () => 100 },
    ...over,
  },
})

beforeEach(() => generateJson.mockReset())

describe('runDuplicateScan', () => {
  it('判官回 same 才出建議；different/unsure 都不出（寧可漏不可誤）', async () => {
    generateJson.mockResolvedValue({
      data: {
        results: [
          { index: 0, verdict: 'same', reason: '同一台咖啡機，一張暱稱一張正式名' },
          { index: 1, verdict: 'different', reason: '型號不同' },
        ],
      },
      inputTokens: 10,
      outputTokens: 5,
    })
    const { db, writes } = makeScanDb({
      prev: null,
      chunks: [
        chunkDoc('a', [1, 0], { productName: '義比壓壓' }),
        chunkDoc('b', [0.99, 0.14], { productName: 'Balzano 義式半自動' }),
        chunkDoc('c', [0, 1], { productName: 'GPLUS 12L' }),
        chunkDoc('d', [0.14, 0.99], { productName: 'GPLUS 16L' }),
      ],
    })
    const r = await runDuplicateScan(db, 'ws1', { force: true })
    expect(r.outcome).toBe('scanned')
    expect(r.candidates).toBe(2)
    expect(r.suggestions).toBe(1)
    const saved = writes.at(-1) as any
    expect(saved.suggestions).toHaveLength(1)
    expect(saved.suggestions[0].kind).toBe('product_split')
    expect(saved.suggestions[0].reason).toContain('咖啡機')
  })

  it('指紋沒變 → 整輪跳過、零 LLM 呼叫', async () => {
    const chunks = [chunkDoc('a', [1, 0]), chunkDoc('b', [0.99, 0.14])]
    const fp = cardSetFingerprint(chunks.map(c => ({ id: c.id, updatedAtMs: 100 })))
    const { db } = makeScanDb({
      prev: { fingerprint: fp, scannedAtMs: 1, suggestions: [{ key: 'a~b' }], ignoredKeys: [] },
      chunks,
    })
    const r = await runDuplicateScan(db, 'ws1', { force: true })
    expect(r.outcome).toBe('skipped_unchanged')
    expect(generateJson).not.toHaveBeenCalled()
  })

  it('忽略過的組合不再送判官、也不再出建議', async () => {
    const chunks = [chunkDoc('a', [1, 0]), chunkDoc('b', [0.99, 0.14])]
    const { db } = makeScanDb({
      prev: { fingerprint: 'old', scannedAtMs: 1, suggestions: [], ignoredKeys: ['a~b'] },
      chunks,
    })
    const r = await runDuplicateScan(db, 'ws1', { force: true })
    expect(r.outcome).toBe('scanned')
    expect(r.candidates).toBe(0)
    expect(generateJson).not.toHaveBeenCalled()
  })

  it('回收桶與總覽卡不參與；卡不足 2 張直接跳過', async () => {
    const { db } = makeScanDb({
      prev: null,
      chunks: [
        chunkDoc('a', [1, 0]),
        chunkDoc('b', [0.99, 0.14], { deletedAt: { toMillis: () => 1 } }),
        chunkDoc('c', [0.98, 0.2], { isOverview: true }),
      ],
    })
    const r = await runDuplicateScan(db, 'ws1', { force: true })
    expect(r.outcome).toBe('skipped_too_few')
    expect(generateJson).not.toHaveBeenCalled()
  })
})

describe('候選名額要先過濾再取（C-49 review #3）', () => {
  it('同來源高相似對不該吃掉名額，跨來源的組要留得下來', () => {
    // 20 組同來源、超像的卡（型錄切出來的形狀）＋ 1 組跨來源的真重複
    const sameSrc: DupCardLite[] = Array.from({ length: 20 }, (_, i) =>
      card(`s${i}`, { sourceId: 'catalog', embedding: vec(1, i * 0.0001) }))
    const cross = [
      card('x', { sourceId: 'srcA', productName: '上好ㄟ除濕機', embedding: vec(0.9, 0.436) }),
      card('y', { sourceId: 'srcB', productName: 'NWT 威技除濕機', embedding: vec(0.9, 0.4359) }),
    ]
    const keep = (a: DupCardLite, b: DupCardLite) => classifyPair(a, b) != null
    // cap 故意設小（3）：同來源那 20 組若先佔位，跨來源那組必被擠掉
    const pairs = topSimilarPairs([...sameSrc, ...cross], 0.9, 3, keep)
    expect(pairs.some(p => dupPairKey(p.a.id, p.b.id) === 'x~y')).toBe(true)
    expect(pairs.every(p => classifyPair(p.a, p.b) != null)).toBe(true)
  })
})

describe('掃描不覆寫 ignoredKeys（C-49 review #15）', () => {
  it('寫回的內容不含 ignoredKeys —— 掃描期間按的「忽略」不會被吃掉', async () => {
    generateJson.mockResolvedValue({ data: { results: [] }, inputTokens: 1, outputTokens: 1 })
    const { db, writes } = makeScanDb({
      prev: { fingerprint: 'old', scannedAtMs: 1, suggestions: [], ignoredKeys: ['a~b'] },
      chunks: [chunkDoc('a', [1, 0]), chunkDoc('b', [0.99, 0.14]), chunkDoc('c', [0, 1])],
    })
    await runDuplicateScan(db, 'ws1', { force: true })
    const saved = writes.at(-1) as any
    expect('ignoredKeys' in saved).toBe(false)
  })
})

/**
 * `C-143`：判官規則 2 的程式後檢。
 * 2026-09-04 實測判官把「6L開關機」與「12L開關機」判成 same——規則寫在 prompt 裡
 * 模型偶爾會踩，紅線要有程式版（同 C-27 觸發詞後檢的教訓）。
 * 案例全部取自正式資料當天的真實候選。
 */
describe('titleModelConflict（C-143：標題數字對不上就不准合）', () => {
  it('🔴 6L vs 12L 要擋（判官當天真的判了 same）', () => {
    expect(titleModelConflict('GPLUS除濕機6L開關機操作', 'GPLUS除濕機12L開關機操作')).toBe(true)
    expect(titleModelConflict('GPLUS除濕機12L按鍵鎖功能', 'GPLUS除濕機6L按鍵鎖功能')).toBe(true)
  })

  it('一邊沒有數字＝比不出型號，不擋（HEALSIO 那組是真的同一鍋）', () => {
    expect(titleModelConflict('SHARP HEALSIO 2.4L 自動調理零水鍋功能', 'SHARP HEALSIO 自動調理零水鍋產品特色')).toBe(false)
    expect(titleModelConflict('GPLUS產品保固範圍與服務條款', 'GPLUS除濕機6L保固範圍服務條款')).toBe(false)
  })

  it('空白排版差異不算不同型號（BOYA mini2 vs mini 2 是真重複）', () => {
    expect(titleModelConflict('BOYA mini2 迷你無線 AI 降噪麥克風特色', 'BOYA mini 2 產品特色')).toBe(false)
  })

  it('數字相同不擋；全形數字要先轉半形', () => {
    expect(titleModelConflict('Kieslect 10S 規格參數', 'Kieslect 10S 規格')).toBe(false)
    expect(titleModelConflict('除濕機１２L操作', '除濕機12L操作')).toBe(false)
    expect(titleModelConflict('型號806說明', '型號807說明')).toBe(true)
  })

  it('兩邊都沒數字＝交給判官（W1 REGEN vs ULTRA 靠產品名分流，不靠這裡）', () => {
    expect(titleModelConflict('模式切換', '模式切換說明')).toBe(false)
  })
})

/**
 * `C-146`：型號後檢改用共用的 `extractNumbers`（原本手寫版把千分位與全形小數點拆錯，
 * 會把**真的重複**誤擋掉，而且只留一行 log）。
 */
describe('titleModelConflict 沿用共用數字抽取（C-146）', () => {
  it('🔴 千分位不可以被拆成兩個數字（1,000 與 1000 是同一個價格）', () => {
    expect(titleModelConflict('省電 1,000 元技巧', '省電 1000 元技巧')).toBe(false)
  })

  it('🔴 全形小數點要吃得對（２．４Ｌ 與 2.4L 是同一台）', () => {
    expect(titleModelConflict('HEALSIO ２．４Ｌ 功能', 'HEALSIO 2.4L 功能')).toBe(false)
  })

  it('真的不同型號照樣擋（這才是後檢存在的理由）', () => {
    expect(titleModelConflict('GPLUS除濕機6L開關機操作', 'GPLUS除濕機12L開關機操作')).toBe(true)
  })
})
