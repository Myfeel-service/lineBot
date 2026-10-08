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

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getRouterParam', () => 'bc1')
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { default: handler } = await import('./validate.post')
const { getDb, getDoc } = await import('~~/server/utils/firebase')
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
    expect(res.warnings).toEqual([])
  })
})

/**
 * `D-118`：推播一次送給所有人，`{{displayName}}` 送出去一律是空白。
 * ⛔ 不擋（valid 照樣 true），但確認框一定要講——9/29 起 7 則推播都中招，預覽卻一直說會換成名字。
 */
describe('發送前確認：用了客人名字要提醒', () => {
  it('模組型：掃的是模組內容（送出去的那一份），不是那張會被換掉的卡', async () => {
    makeDb(broadcastDoc(moduleCard))
    mockGetDoc.mockResolvedValue({
      workspaceId: WS,
      name: '水都會-超早鳥倒數',
      isActive: true,
      messages: [{ type: 'text', text: '{{displayName}} ⏰ 最後提醒！你的 $1,000 還沒用' }],
    } as any)

    const res = await (handler as any)({})

    expect(res.valid).toBe(true)
    expect(res.warnings).toHaveLength(1)
    expect(res.warnings[0]).toContain('空白')
  })

  it('純文字推播：掃推播本身', async () => {
    makeDb(broadcastDoc([{ type: 'text', text: '嗨 {{displayName}}，今天公休' }]))

    const res = await (handler as any)({})

    expect(res.valid).toBe(true)
    expect(res.warnings).toHaveLength(1)
  })
})
