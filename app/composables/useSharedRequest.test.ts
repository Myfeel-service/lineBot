/**
 * 「同一件事同一瞬間只查一次」這支機制本身的測試（`E-28`）。
 *
 * 為什麼值得單獨測：這支現在被三個地方共用（異常彙總、開通體檢、方案額度），
 * 而它要負責的三件事全都是「錯了只會靜靜地出事」的那種——
 * 少了去重＝每頁打兩次、少了 key＝拿 A 家的查詢回答 B 家、少了 isLatest＝落後的
 * 那支把新答案蓋回舊的。三件各釘一條。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { Ref } from 'vue'

const states = new Map<string, Ref<unknown>>()
const g = globalThis as Record<string, unknown>
g.useState = (key: string, init: () => unknown) => {
  if (!states.has(key))
    states.set(key, ref(init()))
  return states.get(key)!
}

const { useSharedRequest } = await import('./useSharedRequest')

beforeEach(() => { states.clear() })

/** 手動控制何時結束的假查詢 */
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

describe('useSharedRequest', () => {
  it('同一個 key 同時要 → 只跑一次查詢，兩邊拿到同一支 promise', async () => {
    const shared = useSharedRequest('t')
    const task = vi.fn(async () => { await deferred().promise })

    const first = shared.start('w1', task)
    const second = shared.pending('w1')

    expect(task).toHaveBeenCalledTimes(1)
    expect(second).toBe(first) // 這一行紅掉＝呼叫端會各自發車
  })

  it('不同 key → 不共用（拿 A 家的查詢回答 B 家是最嚴重的那種錯）', async () => {
    const shared = useSharedRequest('t')
    shared.start('w1', async () => { await deferred().promise })

    expect(shared.pending('w2')).toBeNull()
  })

  it('落後的那支問 isLatest() 會得到 false（不准寫舊答案）', async () => {
    const shared = useSharedRequest('t')
    const a = deferred()
    let aIsLatest: (() => boolean) | null = null
    const first = shared.start('w1', async (isLatest) => {
      aIsLatest = isLatest
      await a.promise
    })

    // 換帳號：新的那支接手
    const b = deferred()
    let bIsLatest: (() => boolean) | null = null
    const second = shared.start('w2', async (isLatest) => {
      bIsLatest = isLatest
      await b.promise
    })

    expect(aIsLatest!()).toBe(false) // 舊的已被接手
    expect(bIsLatest!()).toBe(true)

    a.resolve(); b.resolve()
    await Promise.all([first, second])
  })

  it('舊那支落地時不會把新那支的鎖清掉', async () => {
    const shared = useSharedRequest('t')
    const a = deferred()
    const first = shared.start('w1', async () => { await a.promise })
    const b = deferred()
    const second = shared.start('w2', async () => { await b.promise })

    a.resolve()
    await first

    // 這一行紅掉＝舊的收尾把新的鎖清掉了，於是下一次呼叫會再送一支重複的查詢
    expect(shared.pending('w2')).toBe(second)

    b.resolve()
    await second
    expect(shared.pending('w2')).toBeNull() // 自己結束後才放鎖
  })

  it('releaseOthers：只放別家的，同一家的留著給後面的人共用', async () => {
    const shared = useSharedRequest('t')
    const a = deferred()
    shared.start('w1', async () => { await a.promise })

    // 還在同一家 → 不放（放了的話切帳號時會送出兩支一模一樣的查詢）
    expect(shared.releaseOthers('w1')).toBe(false)
    expect(shared.pending('w1')).not.toBeNull()

    // 換到別家 → 放掉，新帳號才不會被舊查詢擋住
    expect(shared.releaseOthers('w2')).toBe(true)
    expect(shared.pending('w1')).toBeNull()

    a.resolve()
  })
})
