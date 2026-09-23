/**
 * 「網址帶 `?id=` 就直接開那一筆」（`C-237`）。
 *
 * **它解的問題**：「這個東西誰在用」那份名單以前只連得到**那一頁**，人到了還要在幾十筆裡
 * 自己找。`C-234` 先做了機器人模組那一頁（那一頁是一次載入完整清單，所以用不到這支）；
 * 其餘五頁（圖文選單／推播／活動／客服預存／AI 腳本）都是**後端分頁**的無限捲動，
 * 要的那一筆很可能還沒載進來，所以得一直往下翻到找到為止。
 *
 * ⛔ **三種結果一定要講得不一樣**（照 `loadUntilFound` 的三態）：
 *    找到了 → 開起來
 *    翻完整份都沒有 → 「可能已經被刪掉了」
 *    翻到上限還沒翻完 → 「這份清單太長，還沒找到」⛔ **不可以說成被刪掉**
 *      （把「還沒找完」講成「不存在」，人會去處理一個其實還在的東西）
 *
 * ⚠️ 開完一定要把 `?id=` 從網址拿掉：留著會跟後續的手動點選打架
 *    （點了別的、一重新整理又跳回原本那一筆）。
 */
import type { FindAcrossPagesResult } from '~~/shared/find-across-pages'

export function useAdminDeepLink() {
  const route = useRoute()
  const router = useRouter()
  const { showToast } = useAdminToast()

  /**
   * @param label 給人看的類別名（「推播」「活動」…），只用在講不出來的時候那句話
   * @param list  側欄清單（要有 `loadUntilFound`）
   * @param select 找到之後怎麼把它打開
   */
  async function openFromQueryId<T extends Record<string, any>>(opts: {
    label: string
    list: { loadUntilFound: (match: (item: T) => boolean, o?: { maxPages?: number }) => Promise<FindAcrossPagesResult<T>> }
    select: (item: T) => void
    idKey?: string
  }) {
    const wanted = String(route.query.id ?? '').trim()
    if (!wanted) return

    const idKey = opts.idKey ?? 'id'
    const result = await opts.list.loadUntilFound(item => String(item?.[idKey] ?? '') === wanted)

    if (result.status === 'found') opts.select(result.item)
    else if (result.status === 'absent') showToast(`找不到這個${opts.label}，可能已經被刪掉了`, 'error')
    else showToast(`這份${opts.label}清單太長，還沒找到那一筆——請往下捲或用搜尋`, 'warning')

    void router.replace({ query: { ...route.query, id: undefined } })
  }

  return { openFromQueryId }
}
