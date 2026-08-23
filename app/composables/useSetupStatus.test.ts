/**
 * 設定就緒度快取「不可以跨帳號」。
 *
 * 存在的理由是一個真實事故（2026-08-23）：老闆開 MYFEEL（LINE 早就接好、訊息也收過）
 * 卻被整頁拉去「開通引導」，而引導自己重查一次後顯示兩項都 ✓、直接跳「接通完成 🎉」。
 * 根因不在 MYFEEL——是**上一個看過的帳號**（例如全新的 Kevin Test：沒收過任何訊息）
 * 的體檢結果留在共用狀態裡：`statusMap` 只有一份、不記得是誰的，60 秒內再問還會被
 * 當成新鮮的直接回覆，於是 default.vue 拿 A 家的「還沒開通」對 B 家下判斷。
 *
 * 這裡把「這份答案是誰的」釘死：不是現在這個帳號的，一律當作沒有資料。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import type { Ref } from 'vue'
import type { SetupStatusResponse } from '~~/shared/types/setup'

// ── Nuxt 自動匯入的替身（要在 import 受測模組之前就位）────────────────
const states = new Map<string, Ref<unknown>>()
const workspaceId = ref('')

const fixtures: Record<string, SetupStatusResponse['items']> = {
  // 全新帳號：鑰匙貼了，但一則客人訊息都還沒收過 → 開通沒做完
  'kevin-test': [
    { id: 'lineConnected', status: 'done' },
    { id: 'liffReady', status: 'incomplete' },
    { id: 'aiEnabled', status: 'incomplete' },
    { id: 'knowledgeReady', status: 'incomplete' },
    { id: 'scriptReady', status: 'incomplete' },
    { id: 'firstMessageReceived', status: 'incomplete' },
  ],
  // 正在營運的帳號：開通那兩件事都做完了
  'myfeel': [
    { id: 'lineConnected', status: 'done' },
    { id: 'liffReady', status: 'done' },
    { id: 'aiEnabled', status: 'done' },
    { id: 'knowledgeReady', status: 'done' },
    { id: 'scriptReady', status: 'done' },
    { id: 'firstMessageReceived', status: 'done' },
  ],
}

const fetchSpy = vi.fn(async (_url: string, opts: { query: { workspaceId: string } }) => ({
  workspaceId: opts.query.workspaceId,
  items: fixtures[opts.query.workspaceId] ?? [],
}))

const g = globalThis as Record<string, unknown>
g.useState = (key: string, init: () => unknown) => {
  if (!states.has(key))
    states.set(key, ref(init()))
  return states.get(key)!
}
g.computed = computed
g.useWorkspace = () => ({
  workspaceId,
  getBearer: async () => 'token',
  canManageSettings: ref(true),
  canOperate: ref(true),
})
g.$fetch = fetchSpy

const { useSetupStatus } = await import('./useSetupStatus')

beforeEach(() => {
  states.clear()
  fetchSpy.mockClear()
  workspaceId.value = ''
})

describe('useSetupStatus：這份體檢結果是「誰的」', () => {
  it('換到另一個帳號（60 秒內）→ 不可以沿用上一個帳號的答案', async () => {
    const setup = useSetupStatus()

    workspaceId.value = 'kevin-test'
    await setup.refresh()
    expect(setup.onboardingIncomplete.value).toBe(true) // 全新帳號本來就沒做完

    // 老闆從帳號選擇頁點進 MYFEEL：同一個瀏覽器分頁、距離上一次體檢不到 60 秒
    workspaceId.value = 'myfeel'
    await setup.refresh()

    // ⛔ 這行紅掉＝MYFEEL 會被整頁拉去開通引導（default.vue 的 maybePopOnboarding）
    expect(setup.onboardingIncomplete.value).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(2) // 換帳號一定要真的再問一次，不能吃快取
  })

  it('查詢還沒回來之前，畫面拿到的是「沒有資料」而不是上一個帳號的資料', async () => {
    const setup = useSetupStatus()

    workspaceId.value = 'kevin-test'
    await setup.refresh()
    expect(setup.requiredDone.value).toBe(1) // lineConnected done、aiEnabled 沒開

    workspaceId.value = 'myfeel' // 才剛切過去、還沒重查
    expect(setup.loaded.value).toBe(false)
    expect(setup.onboardingIncomplete.value).toBe(false)
    expect(setup.capabilities.value.every(c => c.status === 'unknown')).toBe(true)
  })

  it('同一個帳號 60 秒內重複問 → 照樣共用快取（別退化成每頁都打一次）', async () => {
    const setup = useSetupStatus()
    workspaceId.value = 'myfeel'
    await setup.refresh()
    await setup.refresh()
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    await setup.refresh({ force: true }) // 使用者按「重新檢查」時仍要真的重查
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('查詢失敗不會把別的帳號的舊答案端出來（查不到≠沒做，但也不能是別人的）', async () => {
    const setup = useSetupStatus()
    workspaceId.value = 'kevin-test'
    await setup.refresh()

    workspaceId.value = 'myfeel'
    fetchSpy.mockRejectedValueOnce(new Error('network'))
    await setup.refresh()

    expect(setup.loaded.value).toBe(false)
    expect(setup.onboardingIncomplete.value).toBe(false)
  })
})
