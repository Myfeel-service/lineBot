/**
 * 「設定活動頁（LIFF）」劇本測試（`D-19`）。
 *
 * 釘住的是會騙人的行為：
 * 1. **存起來 ≠ 修好了**——存完一定要真的回頭問 LINE 一次。少了那一步，LIFF ID 打錯
 *    或 Endpoint URL 填成別的網址時，劇本會笑著說修好了，客人照樣打不開。
 * 2. 教的網址必須來自後端（liff-endpoint-check 的 expectedUrl），⛔不可以拿瀏覽器網址兜。
 * 3. 查不到＝查不到：不能說修好，也不能說沒修好。
 * 4. 每一步都有跳過出口，跳過時要講清楚代價，並留一個能自己走回去的入口。
 */
import { describe, expect, it, vi } from 'vitest'
import { useAgentScriptRunner } from '../composables/useAgentScriptRunner'
import { AGENT_GUIDES } from './agent-guides'
import type { AgentGuideCtx } from './agent-guides'

const guide = AGENT_GUIDES['liff-setup']
const EXPECTED = 'https://app.example.com/liff/lead'
const LIFF_ID = '2007123456-AbCdEfGh'

/** 假 apiFetch：liff-endpoint-check 依序吐 queue 的回應，PUT 記下 body */
function makeCtx(checkQueue: unknown[]) {
  const puts: any[] = []
  const apiFetch = vi.fn(async (url: string, opts?: any) => {
    if (url === '/api/admin/liff-endpoint-check') {
      const next = checkQueue.shift()
      if (next instanceof Error) throw next
      if (next === undefined) throw new Error('check queue 用完了：劇本比預期多查了一次')
      return next
    }
    if (url === '/api/admin/line-workspace' && opts?.method === 'PUT') {
      puts.push(opts.body)
      return { ok: true }
    }
    throw new Error(`未預期的 API：${url}`)
  })
  const r = useAgentScriptRunner({ sayDelayMs: 0, pollIntervalMs: 5 })
  const ctx: AgentGuideCtx = { r, apiFetch: apiFetch as any, workspaceId: 'w1', state: {} }
  return { r, ctx, puts }
}

const htmlOf = (r: ReturnType<typeof useAgentScriptRunner>) =>
  r.entries.value.map(e => JSON.stringify(e.msg)).join('\n')

const waitInput = (r: ReturnType<typeof useAgentScriptRunner>) =>
  vi.waitFor(() => {
    if (r.ask.value.kind !== 'input') throw new Error('還沒出現輸入格')
  })
const waitChoices = (r: ReturnType<typeof useAgentScriptRunner>) =>
  vi.waitFor(() => {
    if (r.ask.value.kind !== 'choices') throw new Error('還沒出現選項')
  })

const check = (status: string, endpoint: string | null = EXPECTED) => ({
  expectedUrl: EXPECTED,
  checks: [{ liffId: LIFF_ID, source: 'default', status, endpoint }],
})

describe('liff-setup 劇本', () => {
  it('教正確網址 → 貼 LIFF ID → 存起來 → 真的問過 LINE 才說設好', async () => {
    const { r, ctx, puts } = makeCtx([
      { expectedUrl: EXPECTED, checks: [] }, // 開場：拿活動頁網址
      check('ok'), // 存完的驗證
    ])
    const done = r.runSteps(guide.steps, ctx)

    await waitInput(r)
    // 教的網址一律取後端口徑
    expect(htmlOf(r)).toContain('"kind":"copy"')
    expect(htmlOf(r)).toContain(EXPECTED)
    // 「跟拿鑰匙相反」這句不能掉：兩份教學指的是不同的卡片
    expect(htmlOf(r)).toContain('LINE Login')

    r.onSubmit(LIFF_ID)
    await done

    expect(puts).toEqual([{ defaultLiffId: LIFF_ID }])
    expect(htmlOf(r)).toContain('設好了 🎉')
  })

  it('🔴 存好了但 LINE 那邊網址填錯：不可以說設好，要講出現在填的是什麼', async () => {
    const { r, ctx } = makeCtx([
      { expectedUrl: EXPECTED, checks: [] },
      check('broken', 'https://example.com/wrong'),
      check('ok'),
    ])
    const done = r.runSteps(guide.steps, ctx)

    await waitInput(r)
    r.onSubmit(LIFF_ID)
    await waitChoices(r)
    expect(htmlOf(r)).toContain('https://example.com/wrong')
    expect(htmlOf(r)).not.toContain('設好了 🎉')

    // 「改好了，再檢查一次」→ 不該再問一次 LIFF ID
    r.onChoice('again')
    await done
    expect(htmlOf(r)).toContain('設好了 🎉')
  })

  it('🔴 這次查不到：不說修好、也不說沒修好', async () => {
    const { r, ctx } = makeCtx([
      { expectedUrl: EXPECTED, checks: [] },
      { expectedUrl: EXPECTED, checks: [{ liffId: LIFF_ID, source: 'default', status: 'unknown', endpoint: null }] },
    ])
    const done = r.runSteps(guide.steps, ctx)
    await waitInput(r)
    r.onSubmit(LIFF_ID)
    await done

    expect(htmlOf(r)).toContain('這次查不到')
    expect(htmlOf(r)).not.toContain('設好了 🎉')
  })

  it('🔴 拿不到活動頁網址就別亂教：收工並指去設定頁', async () => {
    const { r, ctx, puts } = makeCtx([{ expectedUrl: '', checks: [] }])
    await r.runSteps(guide.steps, ctx)

    expect(ctx.state.exit).toBe(true)
    expect(puts).toEqual([])
    expect(htmlOf(r)).toContain('?focus=liff')
  })

  it('貼進來的不像 LIFF ID 會退回重問，不會存進去', async () => {
    const { r, ctx, puts } = makeCtx([{ expectedUrl: EXPECTED, checks: [] }, check('ok')])
    const done = r.runSteps(guide.steps, ctx)

    await waitInput(r)
    r.onSubmit('我不知道')
    await vi.waitFor(() => {
      if (!htmlOf(r).includes('不像 LIFF ID')) throw new Error('還沒退回')
    })
    expect(puts).toEqual([])

    await waitInput(r)
    r.onSubmit(LIFF_ID)
    await done
    expect(puts).toEqual([{ defaultLiffId: LIFF_ID }])
  })

  it('跳過：講清楚代價，並留一個自己走得回去的入口', async () => {
    const { r, ctx, puts } = makeCtx([{ expectedUrl: EXPECTED, checks: [] }])
    const done = r.runSteps(guide.steps, ctx)

    await waitInput(r)
    r.onSkip()
    await done

    expect(puts).toEqual([])
    expect(htmlOf(r)).toContain('打不開')
    expect(htmlOf(r)).toContain('?focus=liff')
  })
})
