/**
 * 一鍵修 op 註冊表的不變量（D-34）。
 *
 * Record<AlertFixOpId, …> 的完整性 TypeScript 編譯期就擋了；這裡釘的是型別擋不住的部分：
 * 權限門檻（capability 的等級）只能是異常註冊表用的那兩級（operate=agent、settings=admin），
 * 以及每個 op 宣稱要修的 alertId 必須真的存在於異常清單。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ALERT_FIX_OP_IDS, type AlertFixOpId } from '~~/shared/types/alert-fix'
import { ALERT_LABELS } from '~~/shared/types/alerts'
import { CAPABILITIES } from '~~/shared/permissions'
import { ALERT_FIX_OPS } from './alert-fix-ops'

describe('alert-fix op 註冊表不變量', () => {
  it('op 清單與 shared 的 id 清單一致（兩份登記，靠這條釘住）', () => {
    expect(Object.keys(ALERT_FIX_OPS).sort()).toEqual([...ALERT_FIX_OP_IDS].sort())
  })

  it('每個 op 的 alertId 是真實存在的異常、capability 的等級只有 agent/admin 兩級', () => {
    for (const [opId, op] of Object.entries(ALERT_FIX_OPS)) {
      expect(ALERT_LABELS[op.alertId], `op ${opId} 指到不存在的異常 ${op.alertId}`).toBeTruthy()
      expect(['agent', 'admin'], `op ${opId} 的門檻只能是 agent/admin`).toContain(CAPABILITIES[op.capability])
    }
  })

  it('`G-106` 從寫死角色改掛能力表：每個 op 的門檻等級跟改之前一樣（誰能按一鍵修沒有變）', () => {
    const before: Record<AlertFixOpId, 'agent' | 'admin'> = {
      'line-webhook-set-url': 'admin',
      'knowledge-refetch-sources': 'agent',
      'knowledge-retry-index': 'agent',
      'knowledge-retry-index-stuck': 'agent',
      'script-disable-anytext': 'agent',
      'script-add-skip-exit': 'agent',
      'broadcast-reset-failed': 'agent',
    }
    for (const [opId, op] of Object.entries(ALERT_FIX_OPS))
      expect(CAPABILITIES[op.capability], `op ${opId}`).toBe(before[opId as AlertFixOpId])
  })
})

/**
 * `C-309`（2026-10-13）：確認卡、結果、操作紀錄都是店家看的字。知識庫頁講「條」、檔案那一份有「換新版」，
 * 這裡以前講「N 張知識卡」、叫人「重新匯入檔案」（重新匯入會多出一份、壞的那份還在）。
 * op 要打 Firestore 才跑得起來，所以讀原始碼的字串驗（註解不算）。
 */
describe('一鍵修的字', () => {
  const src = readFileSync(fileURLToPath(new URL('./alert-fix-ops.ts', import.meta.url)), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
  const strings = [...code.matchAll(/(['`])((?:(?!\1)[^\\]|\\.)*)\1/g)].map(m => m[2]!)

  /** `C-319`（2026-10-15）：按鈕統一叫法——檔案「上傳新版」、試算表與網址「立即更新」；舊名字畫面上已經沒有了 */
  it('知識講「條」，⛔ 不講「張／知識卡／卡片」；檔案教「上傳新版」，⛔ 不教「重新匯入」、不用舊按鈕名', () => {
    expect(strings.length, '對照組：網要撈得到字串').toBeGreaterThan(50)
    const bad = strings.filter(s => /張|知識卡|卡片|重新匯入|換新版|立即同步|重新同步/.test(s))
    expect(bad).toEqual([])
    expect(strings.some(s => s.includes('上傳新版'))).toBe(true)
    expect(strings.some(s => s.includes('立即更新'))).toBe(true)
  })
})
