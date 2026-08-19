/**
 * 「帶你修好」劇本測試——line-webhook（修好 LINE 收訊）。
 *
 * 釘住的是會騙人的行為，不是文案：
 * 1. 分診要跟後端 workspace-alerts 同一把尺（token → 沒網址 → 開關 → 網址不一致）。
 * 2. 劇本的每一次驗證都必須 runTest:false——「請 LINE 真的發測試訊息」有次數上限，
 *    額度要留給設定頁的「測試連線」。這條被改掉，測試要紅。
 * 3. 教的網址必須來自 publicBaseUrl（教錯網址＝幾分鐘後健康檢查自己亮紅）。
 * 4. 查不到（LINE API 打不通）只能說「查不到」，不能說修好也不能說壞掉。
 */
import { describe, expect, it, vi } from 'vitest'
import { useAgentScriptRunner } from '../composables/useAgentScriptRunner'
import { AGENT_GUIDES, classifyLineWebhook } from './agent-guides'
import type { AgentGuideCtx } from './agent-guides'

const guide = AGENT_GUIDES['line-webhook']

const okVerify = {
  getOk: true,
  lineEndpoint: 'https://app.example.com/webhook',
  lineActive: true,
  urlMatchesCompare: true,
  endpointUnreachable: null,
}

/** 假 apiFetch：workspace 查詢固定回 publicBaseUrl，verify 依序吐 queue 的回應 */
function makeCtx(verifyQueue: unknown[]) {
  const verifyBodies: any[] = []
  const apiFetch = vi.fn(async (url: string, opts?: any) => {
    if (url === '/api/admin/line-workspace')
      return { publicBaseUrl: 'https://app.example.com' }
    if (url === '/api/admin/line-webhook-verify') {
      verifyBodies.push(opts?.body)
      const next = verifyQueue.shift()
      if (next instanceof Error)
        throw next
      if (!verifyQueue.length && next === undefined)
        throw new Error('verify queue 用完了：劇本比測試預期多打了一次')
      return next
    }
    throw new Error(`未預期的 API：${url}`)
  })
  const r = useAgentScriptRunner({ sayDelayMs: 0, pollIntervalMs: 5 })
  const ctx: AgentGuideCtx = { r, apiFetch: apiFetch as any, workspaceId: 'w1', state: {} }
  return { r, ctx, verifyBodies }
}

const htmlOf = (r: ReturnType<typeof useAgentScriptRunner>) =>
  r.entries.value.map(e => JSON.stringify(e.msg)).join('\n')

const waitChoices = (r: ReturnType<typeof useAgentScriptRunner>) =>
  vi.waitFor(() => {
    if (r.ask.value.kind !== 'choices')
      throw new Error('還沒出現選項')
  })

describe('classifyLineWebhook（分診：與後端 workspace-alerts 同一把尺）', () => {
  it('401＝Token 失效、404＝沒填網址、其他查詢失敗＝不下結論', () => {
    expect(classifyLineWebhook({ ...okVerify, getOk: false, getStatus: 401 }).kind).toBe('token')
    expect(classifyLineWebhook({ ...okVerify, getOk: false, getStatus: 404 }).kind).toBe('nourl')
    expect(classifyLineWebhook({ ...okVerify, getOk: false, getStatus: 500 }).kind).toBe('unknown')
  })

  it('開關沒開先於網址不一致；一致且開著＝ok', () => {
    expect(classifyLineWebhook({ ...okVerify, lineActive: false, urlMatchesCompare: false }).kind).toBe('inactive')
    const m = classifyLineWebhook({ ...okVerify, lineEndpoint: 'https://old.example.com/webhook', urlMatchesCompare: false, endpointUnreachable: true })
    expect(m).toMatchObject({ kind: 'mismatch', endpoint: 'https://old.example.com/webhook', unreachable: true })
    expect(classifyLineWebhook(okVerify).kind).toBe('ok')
  })

  it('比不了（compareUrl 空 → urlMatchesCompare null）寧可漏抓不誤報＝ok', () => {
    expect(classifyLineWebhook({ ...okVerify, urlMatchesCompare: null }).kind).toBe('ok')
  })
})

describe('line-webhook 劇本', () => {
  it('沒填網址：教正確網址（copy 卡吃 publicBaseUrl）→ 檢查通過 → 慶祝＋聚光燈連結卡', async () => {
    const { r, ctx, verifyBodies } = makeCtx([
      { ...okVerify, getOk: false, getStatus: 404, lineEndpoint: null },
      okVerify,
    ])
    const done = r.runSteps(guide.steps, ctx)

    await waitChoices(r)
    // 教的網址必須是 publicBaseUrl 兜出來的，copy 卡一鍵可貼
    expect(htmlOf(r)).toContain('"kind":"copy"')
    expect(htmlOf(r)).toContain('https://app.example.com/webhook')
    r.onChoice('check')
    await done

    expect(htmlOf(r)).toContain('修好了 🎉')
    // 成功後給「到設定頁測試連線」的聚光燈入口（?focus=webhook）
    expect(htmlOf(r)).toContain('?focus=webhook')
    // 劇本的驗證一律不燒測試額度
    expect(verifyBodies.length).toBe(2)
    for (const b of verifyBodies) {
      expect(b.runTest).toBe(false)
      expect(b.compareUrl).toBe('https://app.example.com/webhook')
    }
  })

  it('Token 失效：教重發＋?focus=token 聚光燈連結卡，之後收工（不再逼人按檢查）', async () => {
    const { r, ctx } = makeCtx([{ ...okVerify, getOk: false, getStatus: 401 }])
    await r.runSteps(guide.steps, ctx)

    expect(htmlOf(r)).toContain('Reissue')
    expect(htmlOf(r)).toContain('?focus=token')
    expect(ctx.state.exit).toBe(true)
    expect(r.ask.value.kind).toBe('idle')
  })

  it('開關沒開：檢查仍沒開→如實說沒過；再檢查通過→收工', async () => {
    const { r, ctx } = makeCtx([
      { ...okVerify, lineActive: false },
      { ...okVerify, lineActive: false },
      okVerify,
    ])
    const done = r.runSteps(guide.steps, ctx)

    await waitChoices(r)
    expect(htmlOf(r)).toContain('Use webhook')
    r.onChoice('check')
    await waitChoices(r)
    expect(htmlOf(r)).toContain('還沒打開')
    r.onChoice('check')
    await done
    expect(htmlOf(r)).toContain('修好了 🎉')
  })

  it('網址不一致：講出 LINE 現在填的網址；「已連不上」與「還活著」講法不同', async () => {
    const dead = makeCtx([{ ...okVerify, lineEndpoint: 'https://old.example.com/webhook', urlMatchesCompare: false, endpointUnreachable: true }])
    const p1 = dead.r.runSteps(guide.steps, dead.ctx)
    await waitChoices(dead.r)
    expect(htmlOf(dead.r)).toContain('old.example.com')
    expect(htmlOf(dead.r)).toContain('已經連不上')
    dead.r.onChoice('skip')
    await p1
    // 跳過也要留出口：紅點會盯著＋聚光燈連結卡
    expect(htmlOf(dead.r)).toContain('?focus=webhook')

    const alive = makeCtx([{ ...okVerify, lineEndpoint: 'https://old.example.com/webhook', urlMatchesCompare: false, endpointUnreachable: false }])
    const p2 = alive.r.runSteps(guide.steps, alive.ctx)
    await waitChoices(alive.r)
    expect(htmlOf(alive.r)).toContain('無聲斷掉')
    alive.r.onChoice('skip')
    await p2
  })

  it('已經恢復：說「看起來已經修好了」就收工，不逼人多按', async () => {
    const { r, ctx } = makeCtx([okVerify])
    await r.runSteps(guide.steps, ctx)
    expect(htmlOf(r)).toContain('看起來已經修好了')
    expect(r.ask.value.kind).toBe('idle')
  })

  it('查不到（LINE API 打不通）：只說查不到，不說修好也不說壞掉', async () => {
    const { r, ctx } = makeCtx([{ ...okVerify, getOk: false, getStatus: 500 }])
    await r.runSteps(guide.steps, ctx)
    const html = htmlOf(r)
    expect(html).toContain('查不到不代表有問題')
    expect(html).not.toContain('修好了 🎉')
    expect(r.ask.value.kind).toBe('idle')
  })

  it('系統這邊 Token 被清掉（後端 400）：指去存 Token，不進 retry 迴圈', async () => {
    const { r, ctx } = makeCtx([Object.assign(new Error('400'), { statusCode: 400 })])
    await r.runSteps(guide.steps, ctx)
    expect(htmlOf(r)).toContain('?focus=token')
    expect(ctx.state.exit).toBe(true)
  })
})
