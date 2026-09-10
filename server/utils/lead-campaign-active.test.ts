import { describe, expect, it, vi } from 'vitest'

vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string, data?: unknown }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { isCampaignLinkDisabled, assertCampaignLinkActive } = await import('./lead-campaign-active')

function dbWithCampaign(data: Record<string, unknown> | null) {
  const get = vi.fn(async () => ({ exists: data !== null, data: () => data }))
  return {
    db: { collection: () => ({ doc: () => ({ get }) }) } as never,
    get,
  }
}

describe('isCampaignLinkDisabled', () => {
  it('只有明確 isActive:false 才算停用', () => {
    expect(isCampaignLinkDisabled({ isActive: false })).toBe(true)
    expect(isCampaignLinkDisabled({ isActive: true })).toBe(false)
  })

  it('缺欄位的舊資料視同啟用（等值查詢漏掉的那批不可以被當成全部停用）', () => {
    expect(isCampaignLinkDisabled({})).toBe(false)
    expect(isCampaignLinkDisabled({ name: '沒有 isActive 的舊活動' })).toBe(false)
  })

  it('讀不到活動文件時放行——寧可放行也不要因為讀不到就關掉正在跑的活動', () => {
    expect(isCampaignLinkDisabled(null)).toBe(false)
    expect(isCampaignLinkDisabled(undefined)).toBe(false)
  })

  it('⛔ 字串 "false" 不算停用（避免把髒資料讀成關閉）', () => {
    expect(isCampaignLinkDisabled({ isActive: 'false' })).toBe(false)
  })
})

describe('assertCampaignLinkActive', () => {
  it('停用的活動丟 410，並帶得出讓前端換標題的代碼', async () => {
    const { db } = dbWithCampaign({ isActive: false })
    await expect(assertCampaignLinkActive(db, 'c1')).rejects.toMatchObject({
      statusCode: 410,
      data: { code: 'campaign_inactive' },
    })
  })

  it('啟用中的活動放行', async () => {
    const { db } = dbWithCampaign({ isActive: true })
    await expect(assertCampaignLinkActive(db, 'c1')).resolves.toBeUndefined()
  })

  it('campaignId 是空的就連讀都不讀（舊 claim 沒有這個欄位）', async () => {
    const { db, get } = dbWithCampaign({ isActive: false })
    await expect(assertCampaignLinkActive(db, '  ')).resolves.toBeUndefined()
    expect(get).not.toHaveBeenCalled()
  })
})
