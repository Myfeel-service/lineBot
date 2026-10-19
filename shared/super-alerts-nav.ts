import { severityOf } from './types/alerts'
import type { SuperAlertsOverviewPayload } from './types/super-alerts'
import { emailHealthState } from './billing/email-health'

/**
 * 還在寬限期（扣款失敗、還沒降級）的帳號數——側欄「金流總覽」的紅點也讀這個（`B-43`②）。
 * 已經降回免費的不算：那是已經發生的事，清單照樣列，但不該一直亮紅點吵人。查不到（null）回 0、不亮點。
 */
export function pastDueAccountCount(d: SuperAlertsOverviewPayload | null): number {
  return d?.dunning?.filter(r => r.state === 'past_due').length ?? 0
}

/**
 * 超管側欄「異常總覽」那顆點要不要亮、什麼顏色、滑上去說什麼（C-91；`C-164` 加讀圖）。
 *
 * 紅＝排程停擺／有帳號掛紅色異常（客人正在受影響）／客人傳的圖一小時內連著讀不出來／
 *     有帳號自動扣款失敗還在寬限期（`B-43`②）／帳務信寄不出去（`B-50`）；
 * 琥珀＝有黃級異常或高成本帳號；null＝沒事不畫（⛔不畫綠燈——同側欄點三規則）。
 * 心跳 unknown 刻意不亮點：本機／未部署常態如此，亮了等於永遠亮。
 *
 * 讀圖偶發一兩張不亮點（`D-44`②：偶發不吵、連著壞才叫人），清單照樣在總覽頁上。
 * 滑上去的那句講**是哪幾件事**：點是紅的、總覽頁上卻找不到原因，比沒有點更糟。
 */
export function superAlertsNav(d: SuperAlertsOverviewPayload | null): { severity: 'critical' | 'warning' | null, tip: string } {
  if (!d) return { severity: null, tip: '' }
  const critical: string[] = []
  if (d.heartbeat.state === 'stalled') critical.push('背景排程停擺')
  if (d.workspaces.some(w => w.items.some(i => i.state === 'active' && severityOf(i) === 'critical')))
    critical.push('有帳號的客人正在受影響')
  const burst = d.imageReadFailures?.burst
  if (burst) critical.push(`客人傳的圖一小時內有 ${burst.count} 張讀不出來`)
  // `B-43`②：扣款失敗以前只有客戶收得到通知；`B-50`：寄信壞了金流照常、只有信沒出去
  const pastDue = pastDueAccountCount(d)
  if (pastDue) critical.push(`有 ${pastDue} 個帳號自動扣款失敗`)
  if (d.email && emailHealthState(d.email) === 'broken') critical.push('帳務信寄不出去')
  if (critical.length) return { severity: 'critical', tip: critical.join('；') }

  const anyWarning = d.workspaces.some(w =>
    w.usage.flagged || w.items.some(i => i.state === 'active' && severityOf(i) === 'warning'))
  return anyWarning ? { severity: 'warning', tip: '有事情建議處理' } : { severity: null, tip: '' }
}
