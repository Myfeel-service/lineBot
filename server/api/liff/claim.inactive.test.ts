import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 停用的活動，連結要真的失效（2026-09-10 拍板）。
 *
 * 為什麼要測端點本人而不是只測那支純函式：這件事的病灶就是「客人端從頭到尾沒讀過
 * `leadCampaigns`」——純函式全綠但沒人呼叫它，症狀一模一樣。這裡釘的是
 * **claim 真的會走到那道門，而且擋下來的時候一個字都還沒寫進去**。
 */

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__' },
}))
vi.mock('~~/server/utils/line', () => ({ getUserProfile: vi.fn(async () => null) }))
vi.mock('~~/server/utils/line-oa-basic-id', () => ({ resolveLineOaBasicId: vi.fn(async () => '@oa') }))
vi.mock('~~/server/utils/liff-token', () => ({
  verifyLiffAccessToken: vi.fn(async () => ({ userId: 'U1' })),
  warnOnLiffChannelMismatch: vi.fn(),
}))
vi.mock('~~/server/utils/line-workspace-credentials', () => ({
  getLineWorkspaceCredentials: vi.fn(async () => ({ defaultLiffId: '2007123456-AbCdEfGh' })),
}))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string, data?: unknown }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

let body: Record<string, unknown> = {}
vi.stubGlobal('readBody', async () => body)

// ⚠️ getDb／createError 在端點裡是 Nitro 自動匯入，不是 import 進來的——
// 只 vi.mock 那支模組不會生效（第一版就是這樣紅的），要 stub 全域。
let fakeDb: unknown = null
vi.stubGlobal('getDb', () => fakeDb)

const { default: handler } = await import('./claim.post')

const claimSet = vi.fn(async () => {})

/** shared 進入網址那條路：模板列 + 使用者列 + 活動文件 */
function stubDb(campaign: Record<string, unknown> | null) {
  const templateDoc = {
    ref: { id: 'tpl1', update: vi.fn(async () => {}) },
    data: () => ({
      workspaceId: 'ws1',
      campaignId: 'c1',
      campaignCode: 'launch_2026',
      sharedEntry: true,
      tagIds: ['t1'],
      moduleId: null,
      action: null,
      redirectUrl: null,
    }),
  }
  fakeDb = {
    collection: (name: string) => {
      if (name === 'leadCampaigns') {
        return { doc: () => ({ get: async () => ({ exists: campaign !== null, data: () => campaign }) }) }
      }
      // leadClaims
      return {
        where: () => ({
          where: () => ({ limit: () => ({ get: async () => ({ empty: false, docs: [templateDoc] }) }) }),
          limit: () => ({ get: async () => ({ empty: true, docs: [] }) }),
        }),
        doc: () => ({
          id: 'user-row',
          get: async () => ({ exists: false, data: () => undefined }),
          set: claimSet,
          update: vi.fn(async () => {}),
        }),
      }
    },
  }
}

beforeEach(() => {
  claimSet.mockClear()
  body = { rawToken: 'raw', accessToken: 'at' }
})

describe('POST /api/liff/claim 遇到停用的活動', () => {
  it('丟 410 並帶 campaign_inactive，且一個字都沒寫進去', async () => {
    stubDb({ isActive: false })
    await expect((handler as (e: unknown) => Promise<unknown>)({})).rejects.toMatchObject({
      statusCode: 410,
      data: { code: 'campaign_inactive' },
    })
    // ⛔ 這一條才是重點：擋下來卻已經寫了一半 ＝ 停用了還是留下半筆綁定
    expect(claimSet).not.toHaveBeenCalled()
  })

  it('活動還啟用時照常綁定', async () => {
    stubDb({ isActive: true })
    const res = await (handler as (e: unknown) => Promise<{ ok: boolean, campaignCode: string }>)({})
    expect(res.ok).toBe(true)
    expect(res.campaignCode).toBe('launch_2026')
    expect(claimSet).toHaveBeenCalledTimes(1)
  })

  it('查不到活動文件時放行（不因為讀不到就把連結關掉）', async () => {
    stubDb(null)
    const res = await (handler as (e: unknown) => Promise<{ ok: boolean }>)({})
    expect(res.ok).toBe(true)
    expect(claimSet).toHaveBeenCalledTimes(1)
  })
})
