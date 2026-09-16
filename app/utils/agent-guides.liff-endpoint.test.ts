/**
 * 「修好活動頁（LIFF）登記」劇本測試（`C-31` Phase 1 三條之一，2026-09-16 補）。
 *
 * 這條劇本自己不動任何設定——它教人去 LINE 那邊改，然後**替他驗**。
 * 所以要釘的就是那個驗證迴圈會不會說謊：
 * 1. 🔴 **人還沒改就按「改好了」時，絕對不能說修好**——這是假綠燈裡最貴的一種：
 *    客人照樣點不開活動連結，而後台顯示一切正常。
 * 2. 教的網址只能來自後端（同一支檢查端點的 expectedUrl）；後端給不出正確答案時
 *    寧可不教，指去設定頁，⛔不可以拿瀏覽器網址兜一串出來。
 * 3. 查不到 ≠ 修好，也 ≠ 壞掉：這次問不到 LINE 時三種講法要分開。
 * 4. 一進來就已經正常（或剛好自己恢復）時直接收工，不逼人多按一輪。
 */
import { describe, expect, it, vi } from 'vitest'
import { useAgentScriptRunner } from '../composables/useAgentScriptRunner'
import { AGENT_GUIDES } from './agent-guides'
import type { AgentGuideCtx } from './agent-guides'

const guide = AGENT_GUIDES['liff-endpoint']
const EXPECTED = 'https://app.example.com/liff/lead'

/** 假 apiFetch：檢查端點依序吐 queue 的回應（Error＝這次查詢失敗） */
function makeCtx(queue: unknown[]) {
  let calls = 0
  const apiFetch = vi.fn(async (url: string) => {
    if (url === '/api/admin/liff-endpoint-check') {
      calls++
      const next = queue.shift()
      if (next instanceof Error) throw next
      if (next === undefined) throw new Error('check queue 用完了：劇本比預期多查了一次')
      return next
    }
    throw new Error(`未預期的 API：${url}`)
  })
  const r = useAgentScriptRunner({ sayDelayMs: 0, pollIntervalMs: 5 })
  const ctx: AgentGuideCtx = { r, apiFetch: apiFetch as any, workspaceId: 'w1', state: {} }
  return { r, ctx, callCount: () => calls }
}

const htmlOf = (r: ReturnType<typeof useAgentScriptRunner>) =>
  r.entries.value.map(e => JSON.stringify(e.msg)).join('\n')

const waitChoices = (r: ReturnType<typeof useAgentScriptRunner>) =>
  vi.waitFor(() => {
    if (r.ask.value.kind !== 'choices') throw new Error('還沒出現選項')
  })

const res = (
  checks: { liffId: string, status: string, endpoint?: string | null, reason?: string }[],
  expectedUrl: string = EXPECTED,
) => ({
  expectedUrl,
  checks: checks.map(c => ({ source: 'default', endpoint: null, ...c })),
})

describe('liff-endpoint 劇本', () => {
  it('🔴 還沒改就按「改好了」：如實說還沒過，不可以說修好；真的改好再按才報喜', async () => {
    const { r, ctx } = makeCtx([
      res([{ liffId: '2007-A', status: 'broken', endpoint: 'https://old.example.com/x', reason: 'wrong_page' }]),
      // 第一次按檢查：使用者其實還沒改（LINE 那邊照舊）
      res([{ liffId: '2007-A', status: 'broken', endpoint: 'https://old.example.com/x', reason: 'wrong_page' }]),
      // 第二次按檢查：真的改好了
      res([{ liffId: '2007-A', status: 'ok', endpoint: EXPECTED }]),
    ])
    const done = r.runSteps(guide.steps, ctx)

    await waitChoices(r)
    // 教學：正確網址來自後端，且要提醒是掛 LINE Login 的那張卡（整條路唯一反直覺的一步）
    expect(htmlOf(r)).toContain('"kind":"copy"')
    expect(htmlOf(r)).toContain(EXPECTED)
    expect(htmlOf(r)).toContain('LINE Login')
    expect(htmlOf(r)).toContain('https://old.example.com/x') // 講出現在填錯的是什麼

    r.onChoice('check')
    await waitChoices(r)
    const midway = htmlOf(r)
    expect(midway).toContain('還有 1 個沒過')
    expect(midway).not.toContain('修好了 🎉') // 🔴 假綠燈防線

    r.onChoice('check')
    await done
    expect(htmlOf(r)).toContain('修好了 🎉')
  })

  it('一進來就已經正常：說一聲就收工，不逼人再按一輪檢查', async () => {
    const { r, ctx, callCount } = makeCtx([res([{ liffId: '2007-A', status: 'ok', endpoint: EXPECTED }])])
    await r.runSteps(guide.steps, ctx)

    expect(callCount()).toBe(1)
    expect(r.ask.value.kind).toBe('idle')
    const html = htmlOf(r)
    expect(html).toContain('看起來已經修好了')
    expect(html).not.toContain('"kind":"copy"') // 沒壞就不要教人去改設定
  })

  it('🔴 這次查不到登記狀態：不說有問題、也不說沒問題', async () => {
    const { r, ctx } = makeCtx([res([{ liffId: '2007-A', status: 'unknown' }])])
    await r.runSteps(guide.steps, ctx)

    const html = htmlOf(r)
    expect(html).toContain('查不到不代表沒問題')
    expect(html).not.toContain('看起來已經修好了')
    expect(html).toContain('"state":"skipped"')
  })

  it('🔴 系統這邊沒有正式網址：不亂教一串，改指去設定頁', async () => {
    const { r, ctx } = makeCtx([
      res([{ liffId: '2007-A', status: 'broken', endpoint: 'https://old.example.com/x' }], ''),
    ])
    await r.runSteps(guide.steps, ctx)

    const html = htmlOf(r)
    expect(html).not.toContain('"kind":"copy"')
    expect(html).toContain('給不出正確的登記網址')
    expect(html).toContain('settings/organization?verify=liff')
  })

  it('查詢失敗時可以「先不修」收工：講清楚紅點會繼續盯著，不留死路', async () => {
    const { r, ctx } = makeCtx([new Error('LINE API timeout')])
    const done = r.runSteps(guide.steps, ctx)

    await waitChoices(r)
    // apiRetry 的兩顆鈕：再試一次／先不修
    const ask = r.ask.value as { kind: 'choices', options: { value: string }[] }
    expect(ask.options.map(o => o.value)).toEqual(['retry', 'skip'])

    r.onChoice('skip')
    await done
    expect(htmlOf(r)).toContain('先不修')
    expect(htmlOf(r)).not.toContain('修好了 🎉')
  })
})
