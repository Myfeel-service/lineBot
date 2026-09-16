/**
 * 三個新的唯讀查詢（2026-09-16）：最近改了什麼、標籤人數、推播成效。
 *
 * 為什麼補這三個：小幫手可以代人動手之後，「它到底改了什麼」卻只能自己去開操作紀錄頁看；
 * 「貼了某標籤的有幾個人」「上次推播發給幾個人」也一直問不到。
 * 唯讀查詢是這整套裡最安全的東西——不用確認流、不寫任何資料。
 *
 * 釘住的是**講出來的話對不對**：白話、量詞、以及「查不到就說查不到」。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __op: 'ts' }), increment: (n: number) => ({ __op: 'inc', n }) },
}))
vi.mock('./firebase', () => ({
  getDb: vi.fn(),
  // Email 查不到時紀錄照給（只講 uid 也好過整個查詢失敗）
  getFirebaseAuth: () => ({ getUsers: async () => ({ users: [{ uid: 'u1', email: 'kevin@example.com' }] }) }),
}))
vi.mock('./gemini', () => ({ generateJson: vi.fn() }))
vi.mock('./tagging', () => ({ addTagsToUser: vi.fn() }))

;(globalThis as any).createError = (o: any) => Object.assign(new Error(o?.statusMessage || 'error'), o)

const { TOOLS } = await import('./ai-admin-agent')

/** 假 Firestore：認得 collection 名稱，支援 where/orderBy/limit 鏈 */
function makeDb(data: Record<string, any[]>) {
  const chain = (name: string) => {
    const api: any = {
      where: () => api,
      orderBy: () => api,
      limit: () => api,
      get: async () => ({ docs: (data[name] ?? []).map((d: any, i: number) => ({ id: d.id ?? `d${i}`, data: () => d })) }),
    }
    return api
  }
  return { collection: (name: string) => chain(name) } as any
}

const ts = (ms: number) => ({ toMillis: () => ms })

describe('查詢：最近改了什麼', () => {
  const tool = TOOLS.get_recent_changes

  it('講白話不講代號，而且看得出是人改的還是小幫手代的、誰改的', async () => {
    const db = makeDb({
      auditLogs: [{
        action: 'agent-op/ai-settings-service-hours',
        actor: 'agent',
        uid: 'u1',
        before: { serviceHours: { enabled: true } },
        after: { serviceHours: { enabled: false } },
        createdAt: ts(Date.UTC(2026, 8, 15, 2, 30)),
      }],
    })

    const rows = await tool.run(db, 'w1', {}, {}) as any[]

    expect(rows[0].what).toBe('改了服務時間／勿擾時段')
    expect(rows[0].who).toContain('小幫手代辦')
    expect(rows[0].who).toContain('kevin@example.com')
    expect(rows[0].changes[0]).toContain('勿擾時段')
    // 時間要換成台灣時間再講（伺服器跑 UTC，直接講會差 8 小時）
    expect(rows[0].when).toBe('2026-09-15 10:30')
  })

  it('這道查詢的門檻是「看得到操作紀錄」，⛔不是誰都能問', () => {
    expect(tool.requires).toBe('audit.read')
    expect(tool.mutates).toBe(false)
  })

  it('說明裡要講清楚「這裡只記設定類操作」——查不到不等於沒發生過', () => {
    expect(tool.description).toContain('查不到不等於沒發生過')
  })
})

describe('查詢：標籤人數', () => {
  const tool = TOOLS.get_tag_audience

  it('🔴 標籤名對不到：回現有清單讓它反問，⛔不挑最接近的那個', async () => {
    const db = makeDb({ tags: [{ id: 't1', name: 'VIP' }, { id: 't2', name: '新客' }] })
    const res = await tool.run(db, 'w1', { tagName: '黃金會員' }, {}) as any

    expect(res.found).toBe(false)
    expect(res.availableTags).toEqual(['VIP', '新客'])
  })

  it('對到就回人數，並講明「發送時會重新計算」（⛔不要講成保證發得到）', async () => {
    const db = makeDb({ tags: [{ id: 't1', name: 'VIP' }] })
    ;(globalThis as any).$fetch = async () => ({ estimatedCount: 128 })

    const res = await tool.run(db, 'w1', { tagName: 'VIP' }, {}) as any
    expect(res).toMatchObject({ found: true, count: 128 })
    expect(res.note).toContain('重新計算')
  })
})

describe('查詢：推播成效', () => {
  const tool = TOOLS.get_broadcast_results

  it('狀態講白話，數字照實；沒完成的不要編一個完成時間', async () => {
    const db = makeDb({
      broadcasts: [
        { name: '中秋通知', status: 'completed', totalCount: 100, sentCount: 98, failedCount: 2, skippedCount: 0, completedAt: ts(Date.UTC(2026, 8, 14, 1, 0)) },
        { name: '下週活動', status: 'draft', totalCount: 0, sentCount: 0, failedCount: 0, skippedCount: 0 },
      ],
    })

    const rows = await tool.run(db, 'w1', {}, {}) as any[]

    expect(rows[0]).toMatchObject({ name: '中秋通知', status: '已完成', sent: 98, failed: 2 })
    expect(rows[0].completedAt).toBe('2026-09-14 09:00')
    expect(rows[1].status).toBe('草稿（還沒發）')
    expect(rows[1].completedAt).toBeNull()
  })

  it('⛔ 說明要講明這裡沒有開封率點擊率（不然它會憑空講一個）', () => {
    expect(tool.description).toContain('沒有開封率與點擊率')
  })
})
