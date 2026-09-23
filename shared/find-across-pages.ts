/**
 * 在「後端分頁的無限捲動清單」裡一路往下翻，直到找到那一筆為止（`C-237`）。
 *
 * **它解的問題**：網址帶 `?id=` 要直接開那一筆，但側欄一次只載一頁（30 筆），
 * 要的那一筆很可能還沒載進來。
 *
 * ⛔ **三種結果一定要分得開**，這是這支唯一的難處：
 *   `found`   → 找到了
 *   `absent`  → **整份清單翻完了，真的沒有這一筆**（才可以說「可能已經被刪掉了」）
 *   `gave-up` → **還沒翻完就停了**（翻到上限、或載了卻沒變多）
 *               ⛔ 絕對不可以講成「被刪掉了」——那是把「還沒找完」說成「不存在」，
 *               人會去處理一個其實還在的東西。
 *
 * ⚠️ 上限是必要的：id 打錯或不屬於這個帳號時，沒有上限就會把整個集合一頁一頁全抓下來。
 */
export type FindAcrossPagesResult<T>
  = | { status: 'found', item: T }
    | { status: 'absent' }
    | { status: 'gave-up', pagesLoaded: number, reason: 'max-pages' | 'no-progress' }

export async function findAcrossPages<T>(o: {
  /** 目前已經載進來的那些 */
  peek: () => T[]
  match: (item: T) => boolean
  /** 後面還有沒有 */
  hasMore: () => boolean
  loadMore: () => Promise<void>
  maxPages?: number
}): Promise<FindAcrossPagesResult<T>> {
  const maxPages = o.maxPages ?? 20
  let pagesLoaded = 0

  for (;;) {
    const hit = o.peek().find(o.match)
    if (hit) return { status: 'found', item: hit }
    if (!o.hasMore()) return { status: 'absent' }
    if (pagesLoaded >= maxPages) return { status: 'gave-up', pagesLoaded, reason: 'max-pages' }

    const before = o.peek().length
    await o.loadMore()
    pagesLoaded += 1
    /**
     * ⛔ 防無限迴圈：`hasMore` 說還有、但載完一筆都沒多（後端回空頁、或這一次載入失敗
     * 被 catch 吞掉）。沒有這一關就是**永遠轉下去**，而畫面上只會看到一直在載入。
     * ⚠️ 這裡回 `gave-up` 不是 `absent`：我們並不知道它在不在，只知道問不下去了。
     */
    if (o.peek().length === before) return { status: 'gave-up', pagesLoaded, reason: 'no-progress' }
  }
}
