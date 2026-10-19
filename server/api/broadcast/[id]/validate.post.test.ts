import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `C-247`：**發送前就要攔下「模組送不出東西」**。
 *
 * 在這支之前，確認框只檢查「訊息不是空的、受眾算得出人」，所以模組被停用／刪掉／清空時，
 * 畫面照樣顯示「預估發送人數 842」一切正常，**按下去才整則失敗**——而那時受眾快照已經寫進去、
 * 狀態已經翻成 processing。排程推播踩到這個是半夜爆，隔天只看得到「失敗」兩個字。
 * 正式庫已經有一筆指向查不到模組的紀錄（`MR測試`，2026-05-19）。
 */

const WS = 'ws1'

vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn(), getDoc: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: WS })),
}))
vi.mock('~~/server/utils/audience', () => ({ resolveAudienceUserIds: vi.fn(async () => []) }))
// 方案：預設讀不到（fail-open），方案那一組才換成真的方案（走真的 broadcast-plan-gate 判斷）
vi.mock('~~/server/utils/billing', () => ({ getWorkspacePlan: vi.fn(async () => null) }))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getRouterParam', () => 'bc1')
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { default: handler } = await import('./validate.post')
const { getDb, getDoc } = await import('~~/server/utils/firebase')
const { getWorkspacePlan } = await import('~~/server/utils/billing')
const { BILLING_PLANS, broadcastLockText } = await import('~~/shared/billing/plans')
const mockGetDb = vi.mocked(getDb)
const mockGetDoc = vi.mocked(getDoc)

/** 模組型推播存的就是這張會被送出端換掉的卡 */
const moduleCard = [{
  type: 'template',
  altText: '有一則訊息',
  template: {
    type: 'buttons',
    text: '點下面的按鈕看看',
    actions: [{ type: 'postback', label: '開始', data: 'triggerModule=mod_abc' }],
  },
}]

function makeDb(broadcast: Record<string, any>) {
  const db = {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({
        get: vi.fn(async () => ({ exists: true, data: () => broadcast })),
      })),
    })),
  }
  mockGetDb.mockReturnValue(db as any)
}

function broadcastDoc(messages: unknown[]) {
  return {
    workspaceId: WS,
    status: 'draft',
    messages,
    // 匯入名單：受眾不必查 users，這組測的是「內容送不送得出去」
    audienceSource: { type: 'import', importedUserIds: ['U1', 'U2'] },
  }
}

beforeEach(() => {
  mockGetDb.mockReset()
  mockGetDoc.mockReset()
  vi.mocked(getWorkspacePlan).mockReset().mockResolvedValue(null)
})

/**
 * `D-131`：方案不含這種推播，**按確認之前**就講（以前視窗照樣寫「預估發送人數」，按下去或到了排程時間才失敗）。
 * 立即發送與排程都先開這個視窗，所以這一關兩條路一起擋到。
 */
describe('發送前確認：方案不含這種推播就當場講', () => {
  it('輕量方案發匯入名單 → 擋下來，句子跟推播頁鎖住時同一句', async () => {
    makeDb(broadcastDoc([{ type: 'text', text: '今天公休' }]))
    vi.mocked(getWorkspacePlan).mockResolvedValue(BILLING_PLANS.lite)

    const res = await (handler as any)({})

    expect(res.valid).toBe(false)
    expect(res.errors).toEqual([broadcastLockText('basic')])
  })

  it('輕量方案發全部好友、成長方案發匯入名單 → 放行', async () => {
    makeDb({ ...broadcastDoc([{ type: 'text', text: '今天公休' }]), audienceSource: { type: 'all' } })
    vi.mocked(getWorkspacePlan).mockResolvedValue(BILLING_PLANS.lite)
    // 全部好友會去數 users：這裡只要確認沒有方案那一句
    const all = await (handler as any)({}).catch((e: Error) => ({ errors: [String(e)] }))
    expect(all.errors.join()).not.toContain('目前的方案')

    makeDb(broadcastDoc([{ type: 'text', text: '今天公休' }]))
    vi.mocked(getWorkspacePlan).mockResolvedValue(BILLING_PLANS.growth)
    const growth = await (handler as any)({})
    expect(growth.valid).toBe(true)
  })

  it('免費方案連全部好友都擋', async () => {
    makeDb({ ...broadcastDoc([{ type: 'text', text: '今天公休' }]), audienceSource: { type: 'all' } })
    vi.mocked(getWorkspacePlan).mockResolvedValue(BILLING_PLANS.free)
    const res = await (handler as any)({}).catch((e: Error) => ({ valid: false, errors: [String(e)] }))
    expect(res.errors).toContain(broadcastLockText('none'))
  })
})

describe('發送前確認：模組送不出東西就要當場講', () => {
  it('模組還在、啟用中、有內容 → 放行', async () => {
    makeDb(broadcastDoc(moduleCard))
    mockGetDoc.mockResolvedValue({ workspaceId: WS, name: '開賣通知', isActive: true, messages: [{ type: 'text' }] } as any)

    const res = await (handler as any)({})

    expect(res.valid).toBe(true)
    expect(res.errors).toEqual([])
    expect(res.estimatedCount).toBe(2)
  })

  it('⭐ 模組被刪掉 → 擋下來，而且講得出後果', async () => {
    makeDb(broadcastDoc(moduleCard))
    mockGetDoc.mockResolvedValue(null as any)

    const res = await (handler as any)({})

    expect(res.valid).toBe(false)
    expect(res.errors.join()).toContain('不存在')
    expect(res.errors.join()).toContain('整則失敗')
  })

  it('⭐ 模組被停用 → 擋下來（送出端要求 isActive，停用的拿回來是 null）', async () => {
    makeDb(broadcastDoc(moduleCard))
    mockGetDoc.mockResolvedValue({ workspaceId: WS, name: '開賣通知', isActive: false, messages: [{ type: 'text' }] } as any)

    const res = await (handler as any)({})

    expect(res.valid).toBe(false)
    expect(res.errors.join()).toContain('停用')
    expect(res.errors.join()).toContain('開賣通知')
  })

  it('⭐ 模組是空的 → 擋下來（客人什麼都收不到，這是最安靜的那種失敗）', async () => {
    makeDb(broadcastDoc(moduleCard))
    mockGetDoc.mockResolvedValue({ workspaceId: WS, name: '開賣通知', isActive: true, messages: [] } as any)

    const res = await (handler as any)({})

    expect(res.valid).toBe(false)
    expect(res.errors.join()).toContain('一則訊息都沒有')
  })

  it('⛔ 別的官方帳號的模組一律當成不存在（多租戶）', async () => {
    makeDb(broadcastDoc(moduleCard))
    mockGetDoc.mockResolvedValue({ workspaceId: 'ws2', name: '別人的模組', isActive: true, messages: [{ type: 'text' }] } as any)

    const res = await (handler as any)({})

    expect(res.valid).toBe(false)
    expect(res.errors.join()).toContain('不存在')
  })

  it('⛔ 純文字推播不會去查模組（別為了一則文字多打一趟資料庫）', async () => {
    makeDb(broadcastDoc([{ type: 'text', text: '今天公休' }]))

    const res = await (handler as any)({})

    expect(mockGetDoc).not.toHaveBeenCalled()
    expect(res.valid).toBe(true)
  })
})

/**
 * `D-118` A（2026-10-15）：用了客人名字的推播改成一人一則送、每位換上自己的名字，
 * 確認框不再提醒「名字會是空白」（那句話已經不是真的了）。
 */
describe('發送前確認：用了客人名字不再提醒「會是空白」', () => {
  it('模組型、純文字都照樣可以送，也沒有那句提醒', async () => {
    makeDb(broadcastDoc(moduleCard))
    mockGetDoc.mockResolvedValue({
      workspaceId: WS,
      name: '水都會-超早鳥倒數',
      isActive: true,
      messages: [{ type: 'text', text: '{{displayName}} ⏰ 最後提醒！你的 $1,000 還沒用' }],
    } as any)
    const moduleRes = await (handler as any)({})
    expect(moduleRes.valid).toBe(true)
    expect(JSON.stringify(moduleRes)).not.toContain('空白')

    makeDb(broadcastDoc([{ type: 'text', text: '嗨 {{displayName}}，今天公休' }]))
    const textRes = await (handler as any)({})
    expect(textRes.valid).toBe(true)
    expect(JSON.stringify(textRes)).not.toContain('空白')
  })
})
