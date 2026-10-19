import type { BroadcastTier } from '~~/shared/billing/plans'
import { useWorkspace } from './useWorkspace'

/**
 * 這個帳號的推播等級（`C-352`①）：帶著發送對象進推播頁的入口——好友頁「推播給這 N 位」、
 * 好友統計「發推播給這群」、首頁檔期「為這一檔擬推播」、活動精靈「順手留一張推播草稿」——
 * 拿它在入口就先講方案限制（句子用 `broadcastEntryLockText`，跟推播頁鎖住時同一句）。
 *
 * 問的是 `/api/broadcast/list?planOnly=1`：只回等級、不讀推播清單、不回方案名（客服也要看得到哪些選不了，
 * 方案摘要卻要管理員權限，`G-103`）。
 *
 * ⛔ `null`＝還沒問到或讀不到——**不鎖**（fail-open，同推播頁與送出端）：真的不該送的，推播頁跟送出端還會擋。
 * ⛔ 帶帳號戳記（同 `usePlanSummary` 的 `checkedFor`）：換帳號之後，B 家在自己查回來之前不可以照 A 家的等級鎖。
 */
export function useBroadcastTier() {
  const { apiFetch, workspaceId } = useWorkspace()
  const raw = useState<BroadcastTier | null>('broadcast-tier', () => null)
  const checkedFor = useState('broadcast-tier-checked-for', () => '')

  const tier = computed<BroadcastTier | null>(() =>
    workspaceId.value && checkedFor.value === workspaceId.value ? raw.value : null)

  async function load() {
    const wid = workspaceId.value ?? ''
    if (!wid) return
    try {
      const res = await apiFetch<{ broadcastTier?: BroadcastTier | null }>('/api/broadcast/list', {
        params: { planOnly: 1 },
      })
      // 落地前確認還是同一個帳號（切帳號時舊的那支不可以蓋掉新的答案）
      if (workspaceId.value !== wid) return
      raw.value = res?.broadcastTier ?? null
      checkedFor.value = wid
    }
    catch {
      // 讀不到＝不鎖（見上面）；⛔ 不留別家的答案
      if (workspaceId.value !== wid) return
      raw.value = null
      checkedFor.value = wid
    }
  }

  return { tier, load }
}
