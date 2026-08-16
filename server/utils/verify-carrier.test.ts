/**
 * 手機條碼查證的三態（`B-31`）。
 *
 * 重點不是「會不會擋」，是**只在確定填錯時才擋**：光貿連不上、被 IP 擋、金鑰沒設，
 * 都必須放行——否則光貿一出問題，全站沒人能存發票資訊。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./guangmao-invoice', () => ({ checkMobileBarcode: vi.fn() }))

import { checkMobileBarcode } from './guangmao-invoice'
import { verifyCarrierNum } from './verify-carrier'

const mockCheck = vi.mocked(checkMobileBarcode)
const KEYS = { sellerUBN: '12345678', appKey: 'k', apiUrl: 'https://invoice-api.amego.tw' }

beforeEach(() => vi.clearAllMocks())

describe('verifyCarrierNum', () => {
  // 2026-08-16 實測：/ABC1234 格式完全合法，光貿回 9000113 手機條碼不存在
  it('確定不存在 → 擋下來，理由帶上光貿的原話', async () => {
    mockCheck.mockResolvedValue({ exists: false, code: 9000113, message: '手機條碼不存在' })
    const r = await verifyCarrierNum('/ABC1234', KEYS)
    expect(r.rejected).toBe(true)
    expect(r.reason).toContain('/ABC1234')
    expect(r.reason).toContain('手機條碼不存在')
  })

  it('查到存在 → 放行', async () => {
    mockCheck.mockResolvedValue({ exists: true, code: 0, message: '' })
    expect((await verifyCarrierNum('/TRM+O+P', KEYS)).rejected).toBe(false)
  })

  // ⛔ 這三條是重點：「不知道」不能當成「錯」
  it('查不到（被 IP 擋 / 平台維護）→ 放行，不能拿我方的故障擋客戶存檔', async () => {
    mockCheck.mockResolvedValue({ exists: null, code: 14, message: 'IP 錯誤' })
    expect((await verifyCarrierNum('/ABC1234', KEYS)).rejected).toBe(false)
  })

  it('連線直接炸掉 → 放行', async () => {
    mockCheck.mockRejectedValue(new Error('network down'))
    expect((await verifyCarrierNum('/ABC1234', KEYS)).rejected).toBe(false)
  })

  it('沒設金鑰 → 放行，而且根本不去問光貿', async () => {
    expect((await verifyCarrierNum('/ABC1234', null)).rejected).toBe(false)
    expect(mockCheck).not.toHaveBeenCalled()
  })

  it('沒填載具 → 放行，不浪費一次呼叫', async () => {
    expect((await verifyCarrierNum('', KEYS)).rejected).toBe(false)
    expect((await verifyCarrierNum(null, KEYS)).rejected).toBe(false)
    expect(mockCheck).not.toHaveBeenCalled()
  })
})
