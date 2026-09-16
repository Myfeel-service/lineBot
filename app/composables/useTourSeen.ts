/**
 * 「這個帳號看過哪幾頁的導覽」——給「第一次進某一頁自動跑導覽」用的記憶。
 *
 * 2026-09-16 老闆拍板：每個帳號第一次進到某一頁，就直接把那一頁的導覽跑給他看。
 * （這推翻了 08-26「不自動跑導覽」那條；當時的折衷是問號旁邊冒四秒的灰字提示。）
 *
 * ⛔ 記在後端不記瀏覽器，因為要的是「每個**帳號**一次」：localStorage 是「這台瀏覽器」，
 *    同一台電腦換個人登入會被當成看過、同一個人換手機會整批重跳。
 * ⚠️ 但 localStorage 還是要寫一份當備援：後端查不到時若一律當成沒看過，那就會變成
 *    「每進一頁都被導覽蓋一次、而且永遠不會停」——那比少跳一次嚴重得多。所以規則是
 *    **後端或本機任一邊說看過了，就算看過**。
 */

interface TourSeenResponse { seen: string[] }

export function useTourSeen() {
  /**
   * ⛔ 用 `useAuth()` 的 `user` 不要用 `$auth.currentUser`（2026-09-16 實機驗到）：
   *    Firebase 是**非同步**回報登入狀態的，元件掛載那一瞬間 `currentUser` 還是 null。
   *    第一版讀它，於是「不知道是誰」→ 當成看過 → 導覽每一頁都靜靜地不跑，
   *    typecheck 綠、單元測試綠、畫面上完全沒有錯誤，只是功能整個沒作用。
   */
  const { user, waitForAuthReady } = useAuth()
  const shared = useSharedRequest('tour-seen')

  /** 後端那份（null ＝ 還沒查過／查不到）。用純物件不用 Set：useState 要能序列化 */
  const remote = useState<Record<string, true> | null>('tour-seen-remote', () => null)
  /** 這份答案是誰的。換帳號登入要重查，不可以把上一個人的紀錄套到下一個人身上 */
  const loadedForUid = useState('tour-seen-uid', () => '')

  const currentUid = () => user.value?.uid ?? ''

  function lsKey(uid: string, key: string) {
    return `tour-auto-seen:${uid}:${key}`
  }

  function localSeen(uid: string, key: string): boolean {
    try {
      return !!localStorage.getItem(lsKey(uid, key))
    }
    catch {
      // 無痕／擋 storage：本機這一邊等於沒有意見，交給後端那一邊決定
      return false
    }
  }

  function markLocal(uid: string, key: string) {
    try {
      localStorage.setItem(lsKey(uid, key), '1')
    }
    catch { /* 記不起來就下次再帶一遍，比整批重跳好 */ }
  }

  /**
   * 查一次後端。同一瞬間好幾頁一起發車時共用同一支（`useSharedRequest`）。
   * 查不到就讓 `remote` 留在 null——呼叫端會退回只看本機那一份。
   */
  async function ensureLoaded(): Promise<void> {
    // 先等 Firebase 講出「現在登入的是誰」，不然下面問到的一律是「沒有人」
    await waitForAuthReady()
    const uid = currentUid()
    if (!uid)
      return
    if (loadedForUid.value === uid && remote.value)
      return
    const already = shared.pending(uid)
    if (already)
      return already
    return shared.start(uid, async (isLatest) => {
      try {
        const token = await user.value?.getIdToken()
        if (!token)
          return
        const data = await $fetch<TourSeenResponse>('/api/admin/tour-seen', {
          headers: { Authorization: `Bearer ${token}` },
        })
        // ⛔ 落地前先確認自己還是最新那一支（同 useSetupStatus 的理由）：
        //    「A 帳號送出 → 登出換 B → B 先回來 → A 才回來」會把 A 的紀錄寫成 B 的答案。
        if (!isLatest() || currentUid() !== uid)
          return
        const map: Record<string, true> = {}
        for (const k of data.seen)
          map[k] = true
        remote.value = map
        loadedForUid.value = uid
      }
      catch {
        // 查不到就維持 null＝「不知道」。呼叫端只在本機也沒紀錄時才會自動跑，
        // 最壞情況是在這台瀏覽器上多帶一遍，不會變成每次進來都跳。
      }
    })
  }

  function hasSeen(key: string): boolean {
    const uid = currentUid()
    if (!uid)
      return true // 還沒登入就別自動跑任何東西
    if (remote.value?.[key])
      return true
    return localSeen(uid, key)
  }

  /** 記下來。兩邊都寫：後端負責跨裝置，本機負責後端掛掉時不要一直重跳 */
  function markSeen(key: string) {
    const uid = currentUid()
    if (!uid)
      return
    markLocal(uid, key)
    if (remote.value)
      remote.value = { ...remote.value, [key]: true }
    void (async () => {
      try {
        const token = await user.value?.getIdToken()
        if (!token)
          return
        await $fetch('/api/admin/tour-seen', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: { key },
        })
      }
      catch { /* 本機那一份已經寫了，這台瀏覽器不會重跳；換裝置再補記 */ }
    })()
  }

  return { ensureLoaded, hasSeen, markSeen }
}
