/**
 * 「LINE 通知沒有人收」劇本測試（原「設定轉真人通知」，`C-31` Phase 1 三條之一；2026-09-27 `C-270` 改寫、`C-271`⑪ 分三種）。
 *
 * 原本的劇本從官方帳號好友清單讓人挑一位、直接存進名單。2026-09-27 拍板「名單只收綁好 LINE 的成員」
 * （`D-103` 第 2 題）之後，那條路是**要拿掉的行為**：好友清單幾乎都是客人，挑錯一位＝客人收到別的客人的資料。
 *
 * 現在釘住的是：
 * 1. ⛔ 不讀客人好友清單、⛔ 不寫任何設定（綁定只能本人用手機掃，小幫手代不了）
 * 2. 這顆提醒有兩種亮法，要講對的那一套：
 *    - 名單上沒有人、自己還沒綁 → 帶去直接打開掃 QR（`?add=me`）
 *    - 名單上沒有人、自己綁好了但關著 → 帶去打開開關（⛔ 不叫他再掃一次）
 *    - 名單上有人但全部收不到 → 講「封鎖或還沒加好友」、帶去看是誰（⛔ 不叫他掃 QR：已綁好的人進頁什麼都不會開）
 */
import { describe, expect, it, vi } from 'vitest'
import { useAgentScriptRunner } from '../composables/useAgentScriptRunner'
import { AGENT_GUIDES } from './agent-guides'
import type { AgentGuideCtx } from './agent-guides'

const guide = AGENT_GUIDES['handoff-notify']

function makeCtx(selfStatus: unknown) {
  const calls: { url: string, method?: string }[] = []
  const apiFetch = vi.fn(async (url: string, opts?: any) => {
    calls.push({ url, method: opts?.method })
    if (url.endsWith('/line-notify/self-status')) {
      if (selfStatus instanceof Error) throw selfStatus
      return selfStatus
    }
    throw new Error(`未預期的 API：${url}`)
  })
  const r = useAgentScriptRunner({ sayDelayMs: 0, pollIntervalMs: 5 })
  const ctx: AgentGuideCtx = { r, apiFetch: apiFetch as any, workspaceId: 'w1', state: {} }
  return { r, ctx, calls }
}

const htmlOf = (r: ReturnType<typeof useAgentScriptRunner>) =>
  r.entries.value.map(e => JSON.stringify(e.msg)).join('\n')

describe('handoff-notify 劇本（LINE 通知沒有人收）', () => {
  it('⛔ 不讀客人好友清單、⛔ 不寫任何設定（三種情況都一樣）', async () => {
    for (const s of [{ bound: false, receivingCount: 0 }, { bound: true, receivingCount: 0 }, { bound: true, receivingCount: 2 }]) {
      const { r, ctx, calls } = makeCtx(s)
      await r.runSteps(guide.steps, ctx)
      expect(calls.some(c => c.url.startsWith('/api/users/list'))).toBe(false)
      expect(calls.some(c => c.method && c.method !== 'GET')).toBe(false)
      expect(calls.some(c => c.url.startsWith('/api/ai/settings'))).toBe(false)
    }
  })

  it('名單上沒有人、自己還沒綁 → 講後果，帶去直接打開掃 QR（?add=me）', async () => {
    const { r, ctx } = makeCtx({ bound: false, receivingCount: 0 })
    await r.runSteps(guide.steps, ctx)
    const html = htmlOf(r)
    expect(html).toContain('沒有人的手機會收到通知')
    expect(html).toContain('/admin/w1/settings/line-notify?add=me')
    expect(html).not.toContain('ai-settings')
  })

  it('名單上沒有人、自己綁好了但關著 → 帶去打開開關，⛔ 不叫他再掃一次', async () => {
    const { r, ctx } = makeCtx({ bound: true, receiving: false, receivingCount: 0 })
    await r.runSteps(guide.steps, ctx)
    const html = htmlOf(r)
    expect(html).toContain('已經綁好了')
    expect(html).not.toContain('add=me')
  })

  it('🔴 名單上有人但全部收不到 → 講封鎖或還沒加好友、帶去看是誰，⛔ 不叫他掃 QR', async () => {
    const { r, ctx } = makeCtx({ bound: true, receiving: true, receivingCount: 2 })
    await r.runSteps(guide.steps, ctx)
    const html = htmlOf(r)
    expect(html).toContain('全部都收不到')
    expect(html).toContain('封鎖')
    expect(html).toContain('/admin/w1/settings/line-notify')
    expect(html).not.toContain('add=me')
    expect(html).not.toContain('掃一下')
  })

  it('問不到自己的狀態 → 退回最常見的那一套（名單上沒有人），⛔ 不卡住', async () => {
    const { r, ctx } = makeCtx(new Error('boom'))
    await r.runSteps(guide.steps, ctx)
    expect(htmlOf(r)).toContain('?add=me')
  })

  it('對應的提醒還是「沒有人會收到 LINE 通知」那一顆', () => {
    expect(guide.alertIds).toEqual(['handoffNotifyMissing'])
  })
})
