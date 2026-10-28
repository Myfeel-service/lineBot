/**
 * 讀商品名對照＋「可能是同一台」的候選（`GET /api/ai/knowledge/product-aliases`）。
 * 「可能是同一台」與「編輯分組 → 客人還會怎麼叫它」兩個視窗都用（`C-406` 從知識庫頁搬出來；兩個視窗打開時各讀一次）。
 */
import { apiErrorText } from '~/utils/api-error-text'
import { groupNameFirst, type KbFolderRow, type ProductAliasCandidate, type ProductAliasPair } from '~/utils/kb-product-groups'

/** folders：現在的分組（候選裡哪個名字是組名，要排前面） */
export function useProductAliases(folders: () => readonly KbFolderRow[]) {
  const { apiFetch } = useWorkspace()
  const { showToast } = useAdminToast()

  const aliasLoading = ref(false)
  const aliasCandidates = ref<ProductAliasCandidate[]>([])
  /** 已確認的對照（別名 → 最終正式名）。編輯分組照這份列出「客人還會怎麼叫它」 */
  const aliasPairs = ref<ProductAliasPair[]>([])
  /** 這個帳號目前所有產品名（編輯分組加叫法時可以直接挑一個現有的＝當成同一台） */
  const aliasProductNames = ref<string[]>([])
  /** 正規化的別名 → 最終正式名 */
  const aliasFinalOf = computed(() => new Map(aliasPairs.value.map(p => [p.aliasKey, p.canonical] as const)))

  /** 讀別名對照＋候選。讀不到回 false（編輯分組要分得出「讀不到」跟「真的沒有」） */
  async function loadAliases(): Promise<boolean> {
    aliasLoading.value = true
    try {
      const res = await apiFetch<{ candidates: ProductAliasCandidate[]; pairs: ProductAliasPair[]; productNames?: string[] }>(
        '/api/ai/knowledge/product-aliases',
      )
      aliasCandidates.value = (res.candidates ?? []).map(c => groupNameFirst(folders(), c))
      aliasPairs.value = res.pairs ?? []
      aliasProductNames.value = (res.productNames ?? []).slice().sort((a: string, b: string) => a.localeCompare(b, 'zh-TW'))
      return true
    }
    catch (err: any) {
      showToast(apiErrorText(err, '讀取商品名失敗'), 'error')
      return false
    }
    finally {
      aliasLoading.value = false
    }
  }

  return { aliasLoading, aliasCandidates, aliasPairs, aliasProductNames, aliasFinalOf, loadAliases }
}
