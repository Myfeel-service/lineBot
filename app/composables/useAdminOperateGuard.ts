import { CAPABILITIES, type Capability } from '~~/shared/permissions'

/**
 * 寫入動作的最後一道保底：畫面照理早就把沒權限的按鈕藏起來了（政策：沒權限一律藏），
 * 這裡擋的是「藏漏了」或鍵盤快捷鍵這類繞過按鈕的路。
 *
 * 2026-09-29 `G-109`：以前只有一顆「客服以上」的大開關，現在每次都要講
 * **這個動作需要哪一項能力**——跟後端那支端點的 `requireCapability` 同一項，前後端才讀同一份表。
 * 例：回覆客人 `assertCan('conversations.reply')`、幫客人貼標 `assertCan('customers.write')`。
 */
export function useAdminOperateGuard() {
  const { can } = useWorkspace()
  const { showToast } = useAdminToast()

  /** 被擋時講給他聽的那句：照那一項的門檻講，⛔ 不要一律寫「觀察者」（管理員級的動作客服也會被擋） */
  function deniedMessage(capability: Capability): string {
    return CAPABILITIES[capability] === 'admin' ? '這個操作只有管理員能做' : '觀察者無法執行此操作'
  }

  function assertCan(capability: Capability): boolean {
    if (can(capability)) return true
    showToast(deniedMessage(capability), 'warning')
    return false
  }

  function guardCan<T>(capability: Capability, fn: () => T): T | undefined {
    return assertCan(capability) ? fn() : undefined
  }

  return { can, assertCan, guardCan }
}
