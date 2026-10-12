import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 「讀不讀得到這份試算表」的回答只能講真的看過的分頁（`C-296` 審查，2026-10-11）。
 *
 * 以前只看前 3 頁、卻回「「封面」「目錄」…這幾個分頁的前 20 列都沒有資料」把每一頁都點名，
 * 資料其實在後面那幾頁的人會以為整份表都讀不到。
 */

vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: 'ws1', uid: 'u1', role: 'admin' })),
}))
const { probeGoogleSheetAccess } = vi.hoisted(() => ({ probeGoogleSheetAccess: vi.fn() }))
vi.mock('~~/server/utils/google-sheets', () => ({
  getServiceAccountEmail: () => 'bot@example.iam.gserviceaccount.com',
  parseGoogleSheetUrl: () => ({ spreadsheetId: 's', gid: null }),
  probeGoogleSheetAccess,
}))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('readBody', async () => ({ url: 'https://docs.google.com/spreadsheets/d/abcdefghijklmnopqrstuvwxyz/edit' }))

const { default: handler } = await import('./gsheet-probe.post')
const run = () => (handler as unknown as (e: unknown) => Promise<{ status: string, message: string }>)({})

beforeEach(() => vi.clearAllMocks())

describe('gsheet-probe 沒找到資料時怎麼講', () => {
  it('每一頁都看過了還是沒有 → no_data，點名全部', async () => {
    probeGoogleSheetAccess.mockResolvedValue({ sheetTitle: '封面', sheetTitles: ['封面', '目錄'], checkedTitles: ['封面', '目錄'], hasData: false })
    const r = await run()
    expect(r.status).toBe('no_data')
    expect(r.message).toBe('讀得到這份試算表，但「封面」、「目錄」這幾個分頁的前 20 列都沒有資料（要有一列欄位名稱＋至少一列資料）。')
  })

  it('還有沒看的頁 → 不說「沒資料」：只點名看過的那幾頁、講還有幾頁沒看、叫他直接整理', async () => {
    probeGoogleSheetAccess.mockResolvedValue({
      sheetTitle: 'A',
      sheetTitles: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
      checkedTitles: ['A', 'B', 'C', 'D', 'E'],
      hasData: false,
    })
    const r = await run()
    // 讀得到，只是還有分頁沒看：⛔ 不可以是 'unknown'（那是錯誤，畫面會畫紅叉、叫人去重新分享）
    expect(r.status).toBe('partial')
    expect(r.message).toBe('讀得到這份試算表。先看了「A」、「B」、「C」、「D」、「E」這 5 個分頁，前 20 列都沒有資料；另外 2 個分頁還沒看，資料在那幾頁的話，直接按「整理並加入」就會一起讀。')
    expect(r.message).not.toContain('「F」')
  })

  it('只有一欄的分頁 → no_data，直接講是格式的問題（以前打綠勾、按下去才撞「沒有足夠資料」）', async () => {
    probeGoogleSheetAccess.mockResolvedValue({ sheetTitle: '常見問題', sheetTitles: ['常見問題'], checkedTitles: ['常見問題'], narrowTitles: ['常見問題'], hasData: false })
    const r = await run()
    expect(r.status).toBe('no_data')
    expect(r.message).toContain('「常見問題」只有一欄')
    expect(r.message).toContain('兩欄以上')
  })

  it('找到資料 → ok，講會讀幾個分頁', async () => {
    probeGoogleSheetAccess.mockResolvedValue({ sheetTitle: 'FAQ', sheetTitles: ['封面', 'FAQ'], checkedTitles: ['FAQ'], hasData: true })
    const r = await run()
    expect(r).toMatchObject({ status: 'ok', message: '讀得到了（會讀「封面」、「FAQ」 2 個分頁）' })
  })
})
