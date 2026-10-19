import { severityOf } from './types/alerts'
import type { SuperAlertsOverviewPayload } from './types/super-alerts'

/**
 * 超管側欄「異常總覽」那顆點要不要亮、什麼顏色、滑上去說什麼（C-91；`C-164` 加讀圖）。
 *
 * 紅＝排程停擺／有帳號掛紅色異常（客人正在受影響）／客人傳的圖一小時內連著讀不出來；
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
  if (critical.length) return { severity: 'critical', tip: critical.join('；') }

  const anyWarning = d.workspaces.some(w =>
    w.usage.flagged || w.items.some(i => i.state === 'active' && severityOf(i) === 'warning'))
  return anyWarning ? { severity: 'warning', tip: '有事情建議處理' } : { severity: null, tip: '' }
}
