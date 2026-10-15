/**
 * 「帶你放進第一份知識」劇本測試（D-40）。
 *
 * 釘住的是會騙人的行為，不是文案：
 * 1. 已經有知識的人不該被當成從零開始（否則老手每次點都被上一次課）。
 * 2. **查不到 ≠ 沒有**：知識數量查詢掛掉時不可以說成「你還沒放進去」。
 * 3. 沒真的看到知識就不准說「好了」——等待迴圈要一直等到後端真的數得到。
 * 4. 最後一哩：知識放好了但 AI 總開關關著時，一定要講「客人還聽不到」並給開關入口。
 *    這條是整個 D-40 的起因，被拿掉就等於白做。
 * 5. 🔴 只有「等你看過」的不算有（`C-308`⑦）：開帳整理出來還沒採用的，客人問不會用到。
 */
import { describe, expect, it, vi } from 'vitest'
import { useAgentScriptRunner } from '../composables/useAgentScriptRunner'
import { AGENT_GUIDES } from './agent-guides'
import type { AgentGuideCtx } from './agent-guides'

const guide = AGENT_GUIDES['knowledge-first']

/** 知識數量的回應（跟開通清單同一支：`/api/admin/setup-status?only=knowledge`） */
const kb = (live: number, drafts = 0) => ({ knowledge: { live, drafts } })

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
    if (url === '/api/admin/setup-status?only=knowledge') {
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
    const { r, ctx } = makeCtx({ sources: [kb(17, 4)] })
    await r.runSteps(guide.steps, ctx)

    expect(ctx.state.exit).toBe(true)
    expect(htmlOf(r)).toContain('已經有 17 條') // 只講上線的那 17 條，等你看過的 4 條不加進去
    expect(htmlOf(r)).not.toContain('21')
    expect(r.ask.value.kind).toBe('idle')
  })

  it('🔴 只有「等你看過」的（開帳整理出來還沒採用）：⛔ 不可以說「已經有、不用跑」，要帶去採用', async () => {
    const { r, ctx, calls } = makeCtx({ sources: [kb(0, 37), kb(0, 37), kb(5, 32)], settings: { enabled: true } })
    const done = r.runSteps(guide.steps, ctx)

    await waitChoices(r)
    const intro = htmlOf(r)
    expect(intro).not.toContain('不用跑')
    expect(intro).toContain('37 條')
    expect(intro).toContain('還沒上線')
    expect(intro).toContain('/admin/w1/knowledge/sources?drafts=1')
    // 要做的是採用，不是再加一份：不開「加入知識」
    expect(intro).not.toContain('?import=1')

    r.onChoice('check') // 還沒採用 → 不可以說好了
    await waitChoices(r)
    expect(htmlOf(r)).toContain('還沒採用')
    expect(htmlOf(r)).not.toContain('進去了')

    r.onChoice('check') // 採用了 5 條
    await waitInput(r)
    r.onSkip()
    await done
    expect(ctx.state.chunkTotal).toBe(5)
    expect(calls.filter(u => u.includes('setup-status')).length).toBe(3)
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

  it('沒真的看到知識就不說「好了」：空的時候提示「停在先看一下那頁要按加入」，再確認才過關', async () => {
    const { r, ctx } = makeCtx({
      sources: [
        kb(0), // intro：空的 → 照常帶路
        kb(0), // 第一次確認：還是空的
        kb(3), // 第二次確認：真的有了
      ],
      settings: { enabled: true },
    })
    const done = r.runSteps(guide.steps, ctx)

    await waitChoices(r)
    r.onChoice('check')
    // `D-123`②（2026-10-12）起一份也直接加入：還是空的時候，要講「停在先看一下那頁的，要按加入才會存進去」
    await vi.waitFor(() => {
      if (!htmlOf(r).includes('加入之前先看一下'))
        throw new Error('還沒提示「停在先看一下那頁要按加入」')
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
      sources: [kb(0), kb(8)],
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
      sources: [kb(0), kb(8)],
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
      sources: [kb(0), kb(8)],
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
    const { r, ctx } = makeCtx({ sources: [kb(0)] })
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

  it('「帶著做」清單裡的每一條都真的存在，且 knowledge-first 在裡面（否則做完一次就叫不出來）', async () => {
    const { WALKTHROUGH_GUIDES, AGENT_GUIDES: ALL } = await import('./agent-guides')
    const { CAPABILITIES } = await import('~~/shared/permissions')
    expect(WALKTHROUGH_GUIDES.length).toBeGreaterThan(0)
    for (const g of WALKTHROUGH_GUIDES) {
      expect(ALL[g.id], `WALKTHROUGH_GUIDES 指到不存在的劇本：${g.id}`).toBeTruthy()
      expect(g.blurb.trim()).not.toBe('')
      // 門檻是權限表裡的一項能力（`G-109`，跟 SetupCapability.requires 同一把尺）
      expect(Object.keys(CAPABILITIES)).toContain(g.requires)
    }
    expect(WALKTHROUGH_GUIDES.some(g => g.id === 'knowledge-first')).toBe(true)
  })

  it('⛔修復劇本不進「帶著做」清單（東西沒壞還列修理教學，會讓人以為壞了）', async () => {
    const { WALKTHROUGH_GUIDES, AGENT_GUIDES: ALL } = await import('./agent-guides')
    for (const g of WALKTHROUGH_GUIDES)
      expect(ALL[g.id].alertIds, `${g.id} 綁著異常＝修復劇本，不該進帶著做清單`).toEqual([])
  })

  it('帶路要用既有的 ?import=1 直接開匯入視窗，不另做入口', async () => {
    const { r, ctx } = makeCtx({ sources: [kb(0)] })
    const done = r.runSteps(guide.steps, ctx)
    await waitChoices(r)
    expect(htmlOf(r)).toContain('/admin/w1/knowledge/sources?import=1')
    r.onChoice('skip')
    await done
  })

  it('`C-309`／`C-319`：檔案改了教「上傳新版」（⛔ 不教重新放＝多出一份、⛔ 不用舊名「換新版」）；網址也會自己更新', async () => {
    const { r, ctx } = makeCtx({ sources: [kb(0)] })
    const done = r.runSteps(guide.steps, ctx)
    await waitChoices(r)
    const html = htmlOf(r)
    expect(html).toContain('上傳新版')
    expect(html).not.toMatch(/重新放|重新匯入|換新版/)
    expect(html).toContain('網址會定期自動跟著更新')
    r.onChoice('skip')
    await done
  })

  it('後端數不出來（knowledge: null）也當成「查不到」，⛔ 不當成 0 條', async () => {
    const { r, ctx } = makeCtx({ sources: [{ knowledge: null }, { knowledge: null }] })
    const done = r.runSteps(guide.steps, ctx)
    await waitChoices(r)
    r.onChoice('check')
    await vi.waitFor(() => {
      if (!htmlOf(r).includes('不代表你沒放進去'))
        throw new Error('還沒講出「查不到不等於沒放」')
    })
    await waitChoices(r)
    r.onChoice('skip')
    await done
    expect(htmlOf(r)).not.toContain('知識庫還是空的')
  })
})
