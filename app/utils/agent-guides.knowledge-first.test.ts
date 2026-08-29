/**
 * 「帶你放進第一份知識」劇本測試（D-40）。
 *
 * 釘住的是會騙人的行為，不是文案：
 * 1. 已經有知識的人不該被當成從零開始（否則老手每次點都被上一次課）。
 * 2. **查不到 ≠ 沒有**：`/api/ai/sources/list` 掛掉時不可以說成「你還沒放進去」。
 * 3. 沒真的看到知識就不准說「好了」——等待迴圈要一直等到後端真的數得到。
 * 4. 最後一哩：知識放好了但 AI 總開關關著時，一定要講「客人還聽不到」並給開關入口。
 *    這條是整個 D-40 的起因，被拿掉就等於白做。
 */
import { describe, expect, it, vi } from 'vitest'
import { useAgentScriptRunner } from '../composables/useAgentScriptRunner'
import { AGENT_GUIDES } from './agent-guides'
import type { AgentGuideCtx } from './agent-guides'

const guide = AGENT_GUIDES['knowledge-first']

/**
 * 假 apiFetch。sources 佇列每次取一筆（Error 代表這次查詢失敗），
 * settings 固定回同一份，verify 依 queue 回應。
 */
function makeCtx(opts: {
  sources: unknown[]
  settings?: unknown
  verify?: unknown[]
}) {
  const calls: string[] = []
  const apiFetch = vi.fn(async (url: string, _o?: any) => {
    calls.push(url)
    if (url === '/api/ai/sources/list') {
      const next = opts.sources.shift()
      if (next instanceof Error)
        throw next
      if (next === undefined)
        throw new Error('sources queue 用完了：劇本比測試預期多查了一次')
      return next
    }
    if (url === '/api/ai/settings') {
      if (opts.settings instanceof Error)
        throw opts.settings
      return opts.settings ?? { enabled: true }
    }
    if (url === '/api/ai/knowledge/verify') {
      const next = (opts.verify ?? []).shift()
      if (next instanceof Error)
        throw next
      return next ?? { timedOut: false, decision: 'answered' }
    }
    throw new Error(`未預期的 API：${url}`)
  })
  const r = useAgentScriptRunner({ sayDelayMs: 0, pollIntervalMs: 5 })
  const ctx: AgentGuideCtx = { r, apiFetch: apiFetch as any, workspaceId: 'w1', state: {} }
  return { r, ctx, calls }
}

const htmlOf = (r: ReturnType<typeof useAgentScriptRunner>) =>
  r.entries.value.map(e => JSON.stringify(e.msg)).join('\n')

const waitChoices = (r: ReturnType<typeof useAgentScriptRunner>) =>
  vi.waitFor(() => {
    if (r.ask.value.kind !== 'choices')
      throw new Error('還沒出現選項')
  })

const waitInput = (r: ReturnType<typeof useAgentScriptRunner>) =>
  vi.waitFor(() => {
    if (r.ask.value.kind !== 'input')
      throw new Error('還沒出現輸入格')
  })

describe('knowledge-first 劇本', () => {
  it('已經有知識的人：直接說「不用跑」並收工，不重上一次課', async () => {
    const { r, ctx } = makeCtx({ sources: [{ items: [{ chunkCount: 12 }, { chunkCount: 5 }] }] })
    await r.runSteps(guide.steps, ctx)

    expect(ctx.state.exit).toBe(true)
    expect(htmlOf(r)).toContain('17') // 12 + 5，數字要對得上
    expect(r.ask.value.kind).toBe('idle')
  })

  it('⛔查不到 ≠ 沒放：sources 查詢掛掉時不可以說成「還是空的」', async () => {
    // 第一次（intro）查詢就失敗 → 不可以判定成「已經有」也不可以判定成「沒有」，
    // 劇本要照常帶人去放（而不是收工說你已經有了）
    const { r, ctx } = makeCtx({ sources: [new Error('boom'), new Error('boom again')] })
    const done = r.runSteps(guide.steps, ctx)

    await waitChoices(r)
    r.onChoice('check') // 我放好了，幫我確認 → 第二次查詢也失敗
    await vi.waitFor(() => {
      if (!htmlOf(r).includes('不代表你沒放進去'))
        throw new Error('還沒講出「查不到不等於沒放」')
    })
    // 講完之後要能再按一次確認（不是死路）
    await waitChoices(r)
    r.onChoice('skip')
    await done
    expect(htmlOf(r)).not.toContain('知識庫還是空的')
  })

  it('沒真的看到知識就不說「好了」：空的時候提示「預覽不會存進去」，再確認才過關', async () => {
    const { r, ctx } = makeCtx({
      sources: [
        { items: [] }, // intro：空的 → 照常帶路
        { items: [] }, // 第一次確認：還是空的
        { items: [{ chunkCount: 3 }] }, // 第二次確認：真的有了
      ],
      settings: { enabled: true },
    })
    const done = r.runSteps(guide.steps, ctx)

    await waitChoices(r)
    r.onChoice('check')
    await vi.waitFor(() => {
      if (!htmlOf(r).includes('直接匯入'))
        throw new Error('還沒提示「光是預覽不會存進去」')
    })

    await waitChoices(r)
    r.onChoice('check') // 這次真的有了
    await waitInput(r)
    r.onSkip() // 試問先跳過，直接看最後一哩
    await done

    expect(ctx.state.chunkTotal).toBe(3)
    expect(htmlOf(r)).toContain('3')
  })

  it('最後一哩：AI 開關關著要明講「客人聽不到」並給開啟入口', async () => {
    const { r, ctx } = makeCtx({
      sources: [{ items: [] }, { items: [{ chunkCount: 8 }] }],
      settings: { enabled: false },
    })
    const done = r.runSteps(guide.steps, ctx)

    await waitChoices(r)
    r.onChoice('check')
    await waitInput(r)
    r.onSkip()
    await done

    const html = htmlOf(r)
    expect(html).toContain('總開關還關著')
    expect(html).toContain('/admin/w1/ai-settings') // 給得出入口，不是只抱怨
  })

  it('AI 開著就收尾慶祝，不要多叫人去按一次開關', async () => {
    const { r, ctx } = makeCtx({
      sources: [{ items: [] }, { items: [{ chunkCount: 8 }] }],
      settings: { enabled: true },
    })
    const done = r.runSteps(guide.steps, ctx)

    await waitChoices(r)
    r.onChoice('check')
    await waitInput(r)
    r.onSkip()
    await done

    const html = htmlOf(r)
    expect(html).toContain('都到位了')
    expect(html).not.toContain('/admin/w1/ai-settings')
  })

  it('試問答不出來：照實說 + 指去補「客人可能怎麼問」，不報喜', async () => {
    const { r, ctx } = makeCtx({
      sources: [{ items: [] }, { items: [{ chunkCount: 8 }] }],
      settings: { enabled: true },
      verify: [{ timedOut: false, decision: 'handoff' }],
    })
    const done = r.runSteps(guide.steps, ctx)

    await waitChoices(r)
    r.onChoice('check')
    await waitInput(r)
    r.onSubmit('你們幾點營業')
    await done

    const html = htmlOf(r)
    expect(html).toContain('還答不出來')
    expect(html).toContain('客人可能怎麼問')
    // 狀態卡不可以標成 ok
    expect(html).toContain('"state":"fail"')
  })

  it('中途「先跳過」：收工且不再往下問，也不留死路', async () => {
    const { r, ctx } = makeCtx({ sources: [{ items: [] }] })
    const done = r.runSteps(guide.steps, ctx)

    await waitChoices(r)
    r.onChoice('skip')
    await done

    expect(ctx.state.exit).toBe(true)
    expect(htmlOf(r)).toContain('還會在那裡等你')
    expect(r.ask.value.kind).toBe('idle')
  })
})

describe('knowledge-first 掛在開通清單上', () => {
  it('這條劇本不對應任何異常（它是「還沒開始」不是「壞了」）', () => {
    expect(guide.alertIds).toEqual([])
  })

  it('帶路要用既有的 ?import=1 直接開匯入視窗，不另做入口', async () => {
    const { r, ctx } = makeCtx({ sources: [{ items: [] }] })
    const done = r.runSteps(guide.steps, ctx)
    await waitChoices(r)
    expect(htmlOf(r)).toContain('/admin/w1/knowledge/sources?import=1')
    r.onChoice('skip')
    await done
  })
})
