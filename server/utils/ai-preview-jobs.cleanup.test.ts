/**
 * C-46 匯入 job 清理的三態與孤兒續命。
 *
 * 兩個病：①清理不看狀態，會把「還在跑」的 job 連 work.json 一起刪——使用者去開會
 * 回來 404、已付的 OCR 錢作廢 ②回報「deleted=scanned」與實際無關，刪除失敗連續
 * 三個月假綠燈也看不出來。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __op: 'ts' }) },
  Timestamp: {
    now: () => ({ __ts: 'now' }),
    fromMillis: (ms: number) => ({ __ts: ms }),
  },
}))
vi.mock('./firebase', () => ({
  getDb: () => { throw new Error('test 必須自帶 db') },
  getStorage: () => ({
    bucket: () => ({
      deleteFiles: async () => {},
      file: () => ({ save: async () => {}, download: async () => [Buffer.from('{}')] }),
    }),
  }),
}))
vi.mock('./ai-knowledge-chunker', () => ({
  chunkSegment: vi.fn(),
  summarizeAsOverviewCard: vi.fn(),
  enrichCardBatch: vi.fn(),
  segmentText: (t: string) => [t],
  MAX_TOTAL_CHUNKS: 150,
  ENRICH_BATCH_SIZE: 15,
  isChunkTruncationError: () => false,
  splitSegmentInHalf: (t: string) => [t, t],
}))
vi.mock('./pdf-split', () => ({ splitPdfPageRange: vi.fn(), getPdfPageCount: vi.fn() }))
vi.mock('./ai-source-extractors', () => ({ ocrPdfWithGemini: vi.fn(), MAX_RAW_TEXT_LEN: 100_000 }))
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn(async () => {}) }))

import { cleanupExpiredPreviewJobs } from './ai-preview-jobs'

interface JobSeed {
  id: string
  status: string
  /** updatedAt 距今幾分鐘前 */
  updatedMinAgo: number
  deleteFails?: boolean
}

function makeDb(seeds: JobSeed[]) {
  const ops: Array<{ id: string; op: string; payload?: unknown }> = []
  const db: any = {
    collection: () => {
      const q: any = {
        where: () => q,
        limit: () => q,
        get: async () => ({
          size: seeds.length,
          docs: seeds.map(s => ({
            id: s.id,
            data: () => ({
              workspaceId: 'ws1',
              status: s.status,
              updatedAt: { toMillis: () => Date.now() - s.updatedMinAgo * 60_000 },
            }),
            ref: {
              update: async (payload: unknown) => { ops.push({ id: s.id, op: 'update', payload }) },
              delete: async () => {
                if (s.deleteFails) throw new Error('permission denied')
                ops.push({ id: s.id, op: 'delete' })
              },
            },
          })),
        }),
      }
      return q
    },
  }
  return { db, ops }
}

describe('cleanupExpiredPreviewJobs', () => {
  it('還在動的 processing job（30 分內有寫入）→ 續命不刪；已停擺的照刪', async () => {
    const { db, ops } = makeDb([
      { id: 'active', status: 'processing', updatedMinAgo: 5 },
      { id: 'stale', status: 'processing', updatedMinAgo: 90 },
      { id: 'finished', status: 'done', updatedMinAgo: 5 },
    ])
    const r = await cleanupExpiredPreviewJobs(db)
    expect(r.extended).toBe(1)
    expect(r.deleted).toBe(2)
    expect(ops.find(o => o.id === 'active')!.op).toBe('update') // 續 expiresAt
    expect(ops.filter(o => o.op === 'delete').map(o => o.id).sort()).toEqual(['finished', 'stale'])
  })

  it('刪除失敗照實計 failed，不虛報 deleted（deleted=scanned 是健檢明列的反模式）', async () => {
    const { db } = makeDb([
      { id: 'ok', status: 'done', updatedMinAgo: 120 },
      { id: 'bad', status: 'done', updatedMinAgo: 120, deleteFails: true },
    ])
    const r = await cleanupExpiredPreviewJobs(db)
    expect(r.deleted).toBe(1)
    expect(r.failed).toBe(1)
    expect(r.scanned).toBe(2)
  })
})
