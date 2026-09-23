import { findAcrossPages } from '~~/shared/find-across-pages'

/**
 * 後台 split sidebar 無限捲動列表（初次載入一批，捲到底再載入下一批）
 */
export const ADMIN_SIDEBAR_PAGE_SIZE = 30

export type SidebarListPageResult<T> = {
  items: T[]
  hasMore: boolean
}

type FetchPageFn<T> = (params: { page: number, limit: number }) => Promise<T[] | SidebarListPageResult<T>>

function normalizePageResult<T>(res: T[] | Partial<SidebarListPageResult<T>>): SidebarListPageResult<T> {
  if (Array.isArray(res)) return { items: res, hasMore: false }
  return { items: res.items ?? [], hasMore: Boolean(res.hasMore) }
}

/** 標準後台 list API（有 page 回 { items, hasMore }；無 page 回陣列） */
export function useWorkspaceSidebarList<T>(
  path: string,
  params?: () => Record<string, unknown>,
) {
  const { apiFetch } = useWorkspace()
  return useAdminSidebarInfiniteList<T>(async ({ page, limit }) => {
    const res = await apiFetch<T[] | { items?: T[], hasMore?: boolean }>(path, {
      params: { page, limit, ...params?.() },
    })
    return normalizePageResult(res)
  })
}

export function useAdminSidebarInfiniteList<T>(fetchPage: FetchPageFn<T>) {
  const items = ref<T[]>([]) as Ref<T[]>
  const loading = ref(false)
  const loadingMore = ref(false)
  const hasMore = ref(false)
  const page = ref(1)
  const listEl = ref<HTMLElement | null>(null)

  /** 列表尚無捲軸時自動載入下一批（避免卡在僅顯示第一頁） */
  async function prefetchIfListDoesNotScroll() {
    await nextTick()
    const el = listEl.value
    if (!el || !hasMore.value || loading.value || loadingMore.value) return
    if (el.scrollHeight <= el.clientHeight + 1) {
      await loadMore()
      await prefetchIfListDoesNotScroll()
    }
  }

  async function load(reset = true) {
    if (reset) {
      if (loading.value) return
      loading.value = true
      page.value = 1
      hasMore.value = false
      items.value = []
    }
    else {
      if (loadingMore.value || loading.value || !hasMore.value) return
      loadingMore.value = true
    }

    try {
      const res = normalizePageResult(
        await fetchPage({ page: page.value, limit: ADMIN_SIDEBAR_PAGE_SIZE }),
      )
      items.value = reset ? res.items : [...items.value, ...res.items]
      hasMore.value = res.hasMore
      if (hasMore.value) {
        await prefetchIfListDoesNotScroll()
      }
    }
    catch {
      if (reset) items.value = []
      hasMore.value = false
    }
    finally {
      loading.value = false
      loadingMore.value = false
    }
  }

  async function loadMore() {
    if (!hasMore.value || loading.value || loadingMore.value) return
    page.value += 1
    await load(false)
  }

  function onScroll() {
    const el = listEl.value
    if (!el) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80)
      void loadMore()
  }

  /** 一直往下翻，直到找到那一筆為止（`C-237`）。邏輯本體在 `findAcrossPages`，那支有測試。 */
  async function loadUntilFound(match: (item: T) => boolean, opts?: { maxPages?: number }) {
    return findAcrossPages<T>({
      peek: () => items.value,
      match,
      hasMore: () => hasMore.value,
      loadMore,
      maxPages: opts?.maxPages,
    })
  }

  return {
    items,
    loading,
    loadingMore,
    hasMore,
    listEl,
    load,
    loadMore,
    onScroll,
    loadUntilFound,
  }
}
