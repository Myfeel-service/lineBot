/**
 * 「網址帶 `?id=` 就直接開那一筆」（`C-237`）。
 *
 * **它解的問題**：「這個東西誰在用」那份名單以前只連得到**那一頁**，人到了還要在幾十筆裡
 * 自己找。`C-234` 先做了機器人模組那一頁（那一頁是一次載入完整清單，所以用不到這支）；
 * 其餘五頁（圖文選單／推播／活動／客服預存／AI 腳本）都是**後端分頁**的無限捲動，
 * 要的那一筆很可能還沒載進來，所以得一直往下翻到找到為止。
 *
 * ⛔ **三種結果一定要講得不一樣**（照 `loadUntilFound` 的三態）：
 *    找到了 → 開起來，**而且要把側欄捲到那一列**（見 `scrollActiveRowIntoView`）
 *    翻完整份都沒有 → 「可能已經被刪掉了」
 *    翻到上限還沒翻完 → 「這份清單太長，還沒找到」⛔ **不可以說成被刪掉**
 *      （把「還沒找完」講成「不存在」，人會去處理一個其實還在的東西）
 *
 * ⚠️ 開完要把 `?id=` 從網址拿掉：留著會跟後續的手動點選打架
 *    （點了別的、一重新整理又跳回原本那一筆）。
 *    ⛔ **但「還沒翻完就放棄」那一種不收**，理由寫在下面。
 */
import type { FindAcrossPagesResult } from '~~/shared/find-across-pages'

export function useAdminDeepLink() {
  const route = useRoute()
  const router = useRouter()
  const { showToast } = useAdminToast()

  /**
   * 選好之後，把側欄捲到那一列。
   *
   * ⛔ **少了這一段，深連結只做了一半**：翻頁是把那一列載進 DOM 了沒錯，但側欄還停在最上面
   *    ——右邊編輯器開著「A」，左邊看得到的卻是第 1～10 列，人會以為自己開錯了東西。
   * ⚠️ 靠 `.split-list-item.active` 找那一列，不自己算第幾筆乘以列高：五頁的側欄都是同一顆
   *    `SplitListItem`，選中就是這個 class，而列高會隨內容（有沒有摘要、膠囊）變。
   * ⚠️ 已經整列看得見就不要動：沒事捲一下，人會以為畫面自己跳掉了。
   */
  async function scrollActiveRowIntoView(listEl?: Ref<HTMLElement | null>) {
    if (!listEl) return
    await nextTick()
    const el = listEl.value
    const row = el?.querySelector<HTMLElement>('.split-list-item.active')
    if (!el || !row) return
    const top = row.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
    if (top >= el.scrollTop && top + row.offsetHeight <= el.scrollTop + el.clientHeight) return
    // 捲到偏上一點而不是正中央：上面留幾列，人才看得出自己在這份清單的哪一段
    el.scrollTop = Math.max(0, top - el.clientHeight / 3)
  }

  /**
   * @param label 給人看的類別名（「推播」「活動」…），只用在講不出來的時候那句話
   * @param list  側欄清單（要有 `loadUntilFound`；`listEl` 給了才捲得出那一列）
   * @param select 找到之後怎麼把它打開
   */
  async function openFromQueryId<T extends Record<string, any>>(opts: {
    label: string
    list: {
      loadUntilFound: (match: (item: T) => boolean, o?: { maxPages?: number }) => Promise<FindAcrossPagesResult<T>>
      listEl?: Ref<HTMLElement | null>
    }
    select: (item: T) => void
    idKey?: string
  }) {
    const wanted = String(route.query.id ?? '').trim()
    if (!wanted) return

    const idKey = opts.idKey ?? 'id'
    /**
     * ⚠️ 翻頁是非同步的（最多 20 個來回），這中間人可能已經切到別頁去了。
     * `route` 是活的，事後拿到的是**新那一頁**的路徑——不擋的話會在別人的頁面上
     * 開一筆東西、改別人的網址。
     */
    const fromPath = route.path
    const result = await opts.list.loadUntilFound(item => String(item?.[idKey] ?? '') === wanted)
    if (route.path !== fromPath) return

    if (result.status === 'gave-up') {
      showToast(`這份${opts.label}清單太長，還沒找到那一筆——請往下捲或用搜尋`, 'warning')
      /**
       * ⛔ 這一種**不要**把 `?id=` 收掉。人看到「還沒找到」最自然的下一步是重新整理再試一次，
       *    參數先被收掉就變成「重新整理也沒用」，這條連結從網址列再也救不回來。
       *    另外兩種才收：它們已經有結論了（開起來了／確定沒有），留著只會跟手動點選打架。
       */
      return
    }

    if (result.status === 'absent') showToast(`找不到這個${opts.label}，可能已經被刪掉了`, 'error')
    else opts.select(result.item)

    /**
     * ⚠️ **收網址要在捲動之前**：捲動得等一次 `nextTick`，夾在中間的話 `?id=` 會在網址上
     * 多留一個 tick——實測守門員就因此忽紅忽綠（同一份程式碼第一輪綠、第二輪紅）。
     * ⚠️ `hash` 要自己帶上：只給 `query` 的話 vue-router 會把它一起清掉。
     */
    void router.replace({ path: route.path, query: { ...route.query, id: undefined }, hash: route.hash })

    if (result.status === 'found') await scrollActiveRowIntoView(opts.list.listEl)
  }

  return { openFromQueryId }
}
