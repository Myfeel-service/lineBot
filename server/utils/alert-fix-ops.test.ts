/**
 * 一鍵修 op 註冊表的不變量（D-34）。
 *
 * Record<AlertFixOpId, …> 的完整性 TypeScript 編譯期就擋了；這裡釘的是型別擋不住的部分：
 * 權限門檻只能是異常註冊表用的那兩級（operate=agent、settings=admin），
 * 以及每個 op 宣稱要修的 alertId 必須真的存在於異常清單。
 */
import { describe, expect, it } from 'vitest'
import { ALERT_FIX_OP_IDS } from '~~/shared/types/alert-fix'
import { ALERT_LABELS } from '~~/shared/types/alerts'
import { ALERT_FIX_OPS } from './alert-fix-ops'

describe('alert-fix op 註冊表不變量', () => {
  it('op 清單與 shared 的 id 清單一致（兩份登記，靠這條釘住）', () => {
    expect(Object.keys(ALERT_FIX_OPS).sort()).toEqual([...ALERT_FIX_OP_IDS].sort())
  })

  it('每個 op 的 alertId 是真實存在的異常、minRole 只有 agent/admin 兩級', () => {
    for (const [opId, op] of Object.entries(ALERT_FIX_OPS)) {
      expect(ALERT_LABELS[op.alertId], `op ${opId} 指到不存在的異常 ${op.alertId}`).toBeTruthy()
      expect(['agent', 'admin'], `op ${opId} 的門檻只能是 agent/admin`).toContain(op.minRole)
    }
  })
})
