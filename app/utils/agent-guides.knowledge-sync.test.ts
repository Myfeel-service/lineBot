/**
 * 「修好同步失敗的資料」劇本測試（`C-31` Phase 1 三條之一，2026-09-16 補）。
 *
 * 釘住的行為：
 * 1. 🔴 **東西還沒修好就按「確認」時，不能說都恢復了**——同一份資料還在失敗狀態，
 *    AI 讀到的就還是失敗前那一版，報喜等於叫人不要再管它。
 * 2. 「幾份失敗」只數真的標成失敗的那些（與後端一鍵修同一把尺）；
 *    還在同步中、正常的都不算，兩邊講的數字要對得上，否則同一顆異常兩條路各講各話。
 * 3. 查不到 ≠ 修好：確認時查詢失敗要如實說「這次沒確認成功」。
 * 4. 來源名稱是使用者自己取的，列出來時一律當純文字（不可以變成畫面上的標籤）。
 */
import { describe, expect, it, vi } from 'vitest'
import { useAgentScriptRunner } from '../composables/useAgentScriptRunner'
import { AGENT_GUIDES } from './agent-guides'
import type { AgentGuideCtx } from './agent-guides'

const guide = AGENT_GUIDES['knowledge-sync']

/** 假 apiFetch：來源清單依序吐 queue 的回應（Error＝這次查詢失敗） */
function makeCtx(queue: unknown[]) {
  const apiFetch = vi.fn(async (url: string) => {
    if (url === '/api/ai/sources/list') {
      const next = queue.shift()
      if (next instanceof Error) throw next
      if (next === undefined) throw new Error('sources queue 用完了：劇本比預期多查了一次')
      return next
    }
    throw new Error(`未預期的 API：${url}`)
  })
  const r = useAgentScriptRunner({ sayDelayMs: 0, pollIntervalMs: 5 })
  const ctx: AgentGuideCtx = { r, apiFetch: apiFetch as any, workspaceId: 'w1', state: {} }
  return { r, ctx }
}

const htmlOf = (r: ReturnType<typeof useAgentScriptRunner>) =>
  r.entries.value.map(e => JSON.stringify(e.msg)).join('\n')

const waitChoices = (r: ReturnType<typeof useAgentScriptRunner>) =>
  vi.waitFor(() => {
    if (r.ask.value.kind !== 'choices') throw new Error('還沒出現選項')
  })

const sources = (items: { name: string, status: string, failureReason?: string }[]) => ({ items })

describe('knowledge-sync 劇本', () => {
  it('🔴 還沒修就按確認：說還有幾份沒好，不可以說都恢復了；真的修好再按才報喜', async () => {
    const { r, ctx } = makeCtx([
      sources([
        { name: '官網常見問題', status: 'failed', failureReason: '網址已失效' },
        { name: '價目表試算表', status: 'failed', failureReason: '沒有分享權限' },
      ]),
      // 第一次確認：兩份都還在失敗
      sources([
        { name: '官網常見問題', status: 'failed', failureReason: '網址已失效' },
        { name: '價目表試算表', status: 'failed', failureReason: '沒有分享權限' },
      ]),
      // 第二次確認：真的都好了
      sources([{ name: '官網常見問題', status: 'ready' }, { name: '價目表試算表', status: 'ready' }]),
    ])
    const done = r.runSteps(guide.steps, ctx)

    await waitChoices(r)
    const intro = htmlOf(r)
    expect(intro).toContain('2 份')
    expect(intro).toContain('官網常見問題')
    expect(intro).toContain('網址已失效') // 失敗原因要講，否則人不知道能不能自己修
    expect(intro).toContain('health=failedSources') // 帶去已經篩好的清單

    r.onChoice('check')
    await waitChoices(r)
    const midway = htmlOf(r)
    expect(midway).toContain('還有 2 份沒好')
    expect(midway).not.toContain('都恢復了') // 🔴 假綠燈防線

    r.onChoice('check')
    await done
    expect(htmlOf(r)).toContain('都恢復了')
  })

  it('「幾份失敗」只數失敗的：同步中與正常的不算（與一鍵修同一把尺）', async () => {
    const { r, ctx } = makeCtx([
      sources([
        { name: 'A 來源', status: 'failed' },
        { name: 'B 來源', status: 'pending' },
        { name: 'C 來源', status: 'ready' },
        { name: 'D 來源', status: 'syncing' },
      ]),
    ])
    r.runSteps(guide.steps, ctx)
    await waitChoices(r)

    const html = htmlOf(r)
    expect(html).toContain('1 份')
    expect(html).toContain('A 來源')
    expect(html).not.toContain('B 來源')
    expect(html).not.toContain('C 來源')
  })

  it('一進來就沒有失敗的資料：說一聲就收工，不叫人去修沒壞的東西', async () => {
    const { r, ctx } = makeCtx([sources([{ name: 'A 來源', status: 'ready' }])])
    await r.runSteps(guide.steps, ctx)

    expect(r.ask.value.kind).toBe('idle')
    const html = htmlOf(r)
    expect(html).toContain('已經恢復了')
    expect(html).not.toContain('health=failedSources')
  })

  it('🔴 確認時查不到：說「這次沒確認成功」，不說修好也不說沒修好', async () => {
    const { r, ctx } = makeCtx([
      sources([{ name: 'A 來源', status: 'failed' }]),
      new Error('network down'),
    ])
    const done = r.runSteps(guide.steps, ctx)

    await waitChoices(r)
    r.onChoice('check')
    // apiRetry 的重試選單：選「先跳過」
    await vi.waitFor(() => {
      const ask = r.ask.value as { kind: string, options?: { value: string }[] }
      if (ask.kind !== 'choices' || !ask.options?.some(o => o.value === 'skip'))
        throw new Error('還沒出現重試選單')
    })
    r.onChoice('skip')
    await done

    const html = htmlOf(r)
    expect(html).toContain('不代表沒修好')
    expect(html).not.toContain('都恢復了')
    expect(html).toContain('"state":"skipped"')
  })

  it('來源名稱照使用者取的原字顯示，但一律當純文字（不會變成畫面上的標籤）', async () => {
    const { r, ctx } = makeCtx([
      sources([{ name: '<img src=x onerror=alert(1)>', status: 'failed' }]),
    ])
    r.runSteps(guide.steps, ctx)
    await waitChoices(r)

    const html = htmlOf(r)
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('<img src=x')
  })
})
