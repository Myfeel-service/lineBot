import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 建索引時「卡片繼承來源的產品名」要比對帳號（`G-98`，2026-09-29 權限盤點）。
 *
 * 🔴 卡上的 sourceId 修好 create 之前寫得進別家的 id；不比對的話，建索引時會把
 * 別家來源的產品名抄進這一家的卡，還前置進 embedding。
 */
vi.mock('./gemini', () => ({ generateJson: vi.fn(), embedText: vi.fn() }))

const { resolveSourceProductName, invalidateSourceProductCache } = await import('./ai-knowledge-chunks')

const SOURCES: Record<string, Record<string, unknown>> = {
  srcMine: { workspaceId: 'ws1', productName: '我家的除濕機' },
  srcTheirs: { workspaceId: 'ws2', productName: '別家的咖啡機' },
}
let reads = 0
const db = {
  collection: () => ({
    doc: (id: string) => ({ get: async () => { reads++; return { exists: !!SOURCES[id], data: () => SOURCES[id] } } }),
  }),
} as never

beforeEach(() => {
  invalidateSourceProductCache()
  reads = 0
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('resolveSourceProductName', () => {
  it('自己的來源 → 繼承產品名', async () => {
    expect(await resolveSourceProductName(db, 'srcMine', 'ws1')).toBe('我家的除濕機')
  })

  it('🔴 別家的來源 → 不繼承（當作沒有產品名）', async () => {
    expect(await resolveSourceProductName(db, 'srcTheirs', 'ws1')).toBe('')
  })

  it('🔴 快取命中時也要比對：ws2 先讀過，ws1 來借一樣拿不到', async () => {
    expect(await resolveSourceProductName(db, 'srcTheirs', 'ws2')).toBe('別家的咖啡機')
    expect(await resolveSourceProductName(db, 'srcTheirs', 'ws1')).toBe('')
    expect(reads).toBe(1) // 第二次走的是快取——比對不能只做在寫快取前
  })

  it('卡片沒有帳號 → 不給（寧可少一個產品名，也不要猜）', async () => {
    expect(await resolveSourceProductName(db, 'srcMine', undefined)).toBe('')
    expect(reads).toBe(0)
  })
})
