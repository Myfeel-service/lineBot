/**
 * 一鍵修 popup 的開窗狀態（`D-34`）。
 *
 * 為什麼是全域 useState：入口有兩個（頁面提醒帶、右下角小幫手卡片），popup 本體
 * （AlertFixDialog）只掛一份在 layout——兩個入口都往同一個狀態塞要修的異常，
 * 不用各自抱一份 dialog。
 */
import type { ResolvedAlert } from '~/composables/useWorkspaceAlerts'

export function useAlertFix() {
  const fixTarget = useState<ResolvedAlert | null>('alert-fix-target', () => null)

  /** 開 popup。⛔呼叫端要自己確認 alert.fixOpId 存在（沒有 op 的異常沒有「幫我修」按鈕） */
  function openFix(alert: ResolvedAlert) {
    if (!alert.fixOpId) return
    fixTarget.value = alert
  }
  function closeFix() {
    fixTarget.value = null
  }
  return { fixTarget, openFix, closeFix }
}
