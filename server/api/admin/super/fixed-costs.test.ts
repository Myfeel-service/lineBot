import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 成本總覽的「非 AWS 的固定支出」手填清單（`D-47`③）：只有超管讀得到改得到、存在平台設定、改了留平台層稽核。
 */

vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => '__ts__' } }))
vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireSuperAdmin: vi.fn(async () => ({ uid: 'super1', token: { email: 'boss@example.com', email_verified: true } })),
  trustedEmail: (t: { email?: string }) => t.email ?? null,
}))
vi.mock('~~/server/utils/audit-log', () => ({ writeAuditLog: vi.fn(async () => {}) }))

let method = 'GET'
let body: unknown = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getMethod', () => method)
vi.stubGlobal('readBody', async () => body)
vi.stubGlobal('createError', (o: { statusCode?: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'error'), o))

const { default: handler } = await import('./fixed-costs')
const { getDb } = await import('~~/server/utils/firebase')
const { requireSuperAdmin } = await import('~~/server/utils/workspace-auth')
const { writeAuditLog } = await import('~~/server/utils/audit-log')

const domain = { id: 'a', name: '網域 lineminime.com（GoDaddy）', amount: 840, currency: 'TWD', cycle: 'yearly', renewsOn: '2027-07-13' }
let stored: Record<string, unknown> | null = null
const paths: string[] = []
const run = () => (handler as (e: unknown) => Promise<any>)({})

beforeEach(() => {
  vi.mocked(writeAuditLog).mockClear()
  stored = null
  paths.length = 0
  vi.mocked(getDb).mockReturnValue({
    collection: (c: string) => ({
      doc: (d: string) => {
        paths.push(`${c}/${d}`)
        return {
          get: async () => ({ exists: !!stored, data: () => stored }),
          set: async (v: Record<string, unknown>) => { stored = v },
        }
      },
    }),
  } as never)
})

describe('/api/admin/super/fixed-costs', () => {
  it('不是超管：擋下、什麼都不讀', async () => {
    vi.mocked(requireSuperAdmin).mockRejectedValueOnce(Object.assign(new Error('Super admin only'), { statusCode: 403 }))
    await expect(run()).rejects.toMatchObject({ statusCode: 403 })
    expect(paths).toEqual([])
  })

  it('存在平台設定 platformSettings/fixedCosts；PUT 寫進去、記一筆平台層稽核', async () => {
    method = 'PUT'
    body = { items: [domain] }
    const res = await run()
    expect(paths).toContain('platformSettings/fixedCosts')
    expect(stored).toMatchObject({ items: [domain], updatedBy: 'boss@example.com', updatedAt: '__ts__' })
    expect(res).toMatchObject({ items: [domain], updatedBy: 'boss@example.com' })
    const audit = vi.mocked(writeAuditLog).mock.calls[0]?.[0] as Record<string, any>
    expect(audit).toMatchObject({ workspaceId: '', scope: 'platform', action: 'super.fixedCosts', after: { items: [domain] } })
  })

  it('⛔ 有一筆不合格：整份退回 400、什麼都不寫', async () => {
    method = 'PUT'
    body = { items: [domain, { ...domain, id: 'b', amount: 0 }] }
    await expect(run()).rejects.toMatchObject({ statusCode: 400 })
    expect(stored).toBe(null)
    expect(writeAuditLog).not.toHaveBeenCalled()
  })

  it('GET：讀得出來的照回；壞掉的那筆不算但講出來略過幾筆', async () => {
    method = 'GET'
    stored = { items: [domain, { name: '壞掉的', amount: 'x' }], updatedAt: { toMillis: () => 1_760_000_000_000 }, updatedBy: 'boss@example.com' }
    const res = await run()
    expect(res).toEqual({ items: [domain], dropped: 1, updatedAt: 1_760_000_000_000, updatedBy: 'boss@example.com' })
  })

  it('GET：還沒填過＝空清單（不是錯誤）', async () => {
    method = 'GET'
    expect(await run()).toEqual({ items: [], dropped: 0, updatedAt: null, updatedBy: null })
  })
})

describe('成本總覽頁把手填的那筆算進總額、而且講明是手填的', () => {
  const page = readFileSync(fileURLToPath(new URL('../../../../app/pages/admin/super/costs.vue', import.meta.url)), 'utf8')

  it('總額＝AI＋資料庫＋主機＋手填（每月攤提）', () => {
    expect(page).toContain('const grandTotalTwd = computed(() => aiTotalTwd.value + infraTotalTwd.value + hostTotalTwd.value + fixedMonthlyTwd.value)')
  })

  it('圖例那一筆掛「手填」；讀不到時總額旁點名少了它', () => {
    expect(page).toMatch(/非 AWS 的固定支出<span class="sa-infra-est-tag">手填<\/span>/)
    expect(page).toContain('out.push(\'手填的固定支出\')')
  })

  it('較上月：上月也加同一筆（組成一樣才比得了）', () => {
    expect(page).toMatch(/prevGrandTwd[\s\S]{0,900}\+ fixedMonthlyTwd\.value/)
  })
})
