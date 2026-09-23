/**
 * 側欄無限捲動清單：「沒有捲軸就自己補下一批」那段（`C-241`②）。
 *
 * **為什麼值得單獨測**：這段從 `8b6802b` 上線到 `C-241` 為止**一次都沒有生效過**——
 * 它在 `load()` 的 `try` 裡面被呼叫，而那時 `loading` 已經是 `true`，正好撞上它自己
 * 第一行的守衛，一進去就 `return`。typecheck 綠、測試綠、畫面上也看不出來：
 * 視窗短的時候清單只是「停在第一頁」，看起來就像本來只有這麼多
 * （[[feedback_verify_new_code_actually_runs]] 的第九種假綠燈）。
 *
 * ⚠️ 實機也驗不到：正式庫那五個集合每一個都不到 30 筆，`hasMore` 永遠是 `false`，
 *    這段在真後台根本不會被走到。所以只能在這裡釘。
 */
import { nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'

// Nuxt 的自動匯入在 vitest 裡沒有，照 `useSharedRequest.test.ts` 的做法掛上去
const g = globalThis as Record<string, unknown>
g.ref = ref
g.nextTick = nextTick

const { useAdminSidebarInfiniteList, ADMIN_SIDEBAR_PAGE_SIZE } = await import('./useAdminSidebarInfiniteList')

/**
 * 假的側欄容器。只用得到這三個數字，所以不需要真的 DOM。
 * `scrollHeight <= clientHeight` ＝「沒有捲軸」。
 */
function fakeListEl(o: { scrollHeight: number, clientHeight: number }) {
  return { ...o, scrollTop: 0 } as unknown as HTMLElement
}

/** 每頁都回滿、而且永遠說「後面還有」的假後端 */
function pagedFetch(totalPages: number) {
  return vi.fn(async ({ page }: { page: number, limit: number }) => ({
    items: Array.from({ length: ADMIN_SIDEBAR_PAGE_SIZE }, (_, i) => ({ id: `p${page}-${i}` })),
    hasMore: page < totalPages,
  }))
}

describe('沒有捲軸就自己補下一批', () => {
  it('⛔ 清單撐不出捲軸時要繼續載，不可以停在第一頁', async () => {
    const fetchPage = pagedFetch(3)
    const list = useAdminSidebarInfiniteList<{ id: string }>(fetchPage)
    // 內容再多也撐不出捲軸（容器比內容高）＝永遠沒有 onScroll 可以觸發下一頁
    list.listEl.value = fakeListEl({ scrollHeight: 100, clientHeight: 800 })

    await list.load(true)

    expect(fetchPage).toHaveBeenCalledTimes(3)
    expect(list.items.value).toHaveLength(ADMIN_SIDEBAR_PAGE_SIZE * 3)
    expect(list.hasMore.value).toBe(false)
  })

  it('已經有捲軸就不要多載（多抓一頁是白花錢）', async () => {
    const fetchPage = pagedFetch(3)
    const list = useAdminSidebarInfiniteList<{ id: string }>(fetchPage)
    list.listEl.value = fakeListEl({ scrollHeight: 2000, clientHeight: 800 })

    await list.load(true)

    expect(fetchPage).toHaveBeenCalledTimes(1)
    expect(list.hasMore.value).toBe(true)
  })

  it('後端說沒有下一頁就停手（⛔ 別無限問下去）', async () => {
    const fetchPage = pagedFetch(1)
    const list = useAdminSidebarInfiniteList<{ id: string }>(fetchPage)
    list.listEl.value = fakeListEl({ scrollHeight: 100, clientHeight: 800 })

    await list.load(true)

    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('沒有容器（還沒掛上畫面）時不補，而且不可以爆掉', async () => {
    const fetchPage = pagedFetch(3)
    const list = useAdminSidebarInfiniteList<{ id: string }>(fetchPage)

    await list.load(true)

    expect(fetchPage).toHaveBeenCalledTimes(1)
    expect(list.loading.value).toBe(false)
  })

  it('載入失敗時不補、旗標要收乾淨（⛔ 否則整個清單會卡在轉圈）', async () => {
    const fetchPage = vi.fn(async () => { throw new Error('後端掛了') })
    const list = useAdminSidebarInfiniteList<{ id: string }>(fetchPage)
    list.listEl.value = fakeListEl({ scrollHeight: 100, clientHeight: 800 })

    await list.load(true)

    expect(fetchPage).toHaveBeenCalledTimes(1)
    expect(list.loading.value).toBe(false)
    expect(list.loadingMore.value).toBe(false)
    expect(list.hasMore.value).toBe(false)
  })
})
