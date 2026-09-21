/**
 * 「標籤清單變了」的全站訊號（`C-208`）。
 *
 * **為什麼要有**：就地建標籤之後，同一頁上**其他**的標籤下拉不會知道多了一顆。
 * 機器人模組那一頁最明顯——每顆按鈕一個下拉、用戶輸入卡又一個，全部吃同一份
 * `allTags`；在按鈕那邊建了一顆，切到用戶輸入卡就看不到，人會以為沒建成功。
 *
 * ⛔ 不要在 `useAdminTagList` 裡做快取來解這件事：那支同時服務標籤頁的分頁與篩選，
 *    把它變成單例會讓「篩選過的清單」污染「給下拉用的完整清單」。
 *    這裡只傳一個「該重載了」的訊號，要不要重載、用什麼條件重載，由各頁自己決定。
 *
 * 用法：
 *   建立端：`bumpAdminTagList()`
 *   接收端：`onAdminTagListChanged(() => loadTags({ status: 'active' }))`
 */
export function useAdminTagRefresh() {
  const version = useState('admin-tag-list-version', () => 0)

  /** 標籤清單有新增／變更，請所有在聽的人重載 */
  const bumpAdminTagList = () => {
    version.value += 1
  }

  /**
   * 註冊重載。⛔ 用 `watch` 不是 `watchEffect`——後者會在註冊當下先跑一次，
   * 等於每個掛載這個下拉的元件都多打一次 `/api/tag/list`（這個 repo 為了讀取費
   * 才剛把 `offset()` 換成游標，別在這裡自己加回無謂的查詢）。
   */
  const onAdminTagListChanged = (reload: () => void) => {
    watch(version, () => reload())
  }

  return { tagListVersion: version, bumpAdminTagList, onAdminTagListChanged }
}
