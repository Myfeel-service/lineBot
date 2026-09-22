/**
 * 「機器人模組清單變了」的全站訊號（`D-86`）。
 *
 * **為什麼要有**：就地建了一個模組之後，同一頁上**其他**的模組下拉不會知道多了一個。
 * 機器人模組那一頁最明顯——每顆按鈕一個下拉、輪播每一張卡又各有幾個，全部吃同一份
 * `modulePickerOptions`；在按鈕那邊建了一個，切到另一張卡就看不到，人會以為沒建成功。
 *
 * ⚠️ 與 `useAdminTagRefresh` 是同一個形狀、刻意分開兩支：兩邊的重載條件不一樣
 *    （模組要帶 `?fields=picker`），混成一支會讓某一邊白抓一份 133 KB 的完整清單。
 *
 * 用法：
 *   建立端：`bumpAdminFlowList()`
 *   接收端：`onAdminFlowListChanged(() => loadModules())`
 */
export function useAdminFlowRefresh() {
  const version = useState('admin-flow-list-version', () => 0)

  /** 模組清單有新增／變更，請所有在聽的人重載 */
  const bumpAdminFlowList = () => {
    version.value += 1
  }

  /**
   * 註冊重載。⛔ 用 `watch` 不是 `watchEffect`——後者會在註冊當下先跑一次，
   * 等於每個掛著模組下拉的元件都多打一次 `/api/flow/list`。
   */
  const onAdminFlowListChanged = (reload: () => void) => {
    watch(version, () => reload())
  }

  return { flowListVersion: version, bumpAdminFlowList, onAdminFlowListChanged }
}
