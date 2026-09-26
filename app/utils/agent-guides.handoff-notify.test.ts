/**
 * 「LINE 通知沒有人收」劇本測試（原「設定轉真人通知」，`C-31` Phase 1 三條之一；2026-09-27 `C-270` 改寫）。
 *
 * 原本的劇本從官方帳號好友清單讓人挑一位、直接存進名單。2026-09-27 拍板「名單只收綁好 LINE 的成員」
 * （`D-103` 第 2 題）之後，那條路是**要拿掉的行為**，不是要守的行為：
 * - 好友清單幾乎都是客人，挑錯一位＝那位客人會收到別的客人的名字與原話（`C-269`）
 * - 存檔是整份覆寫 `lineUserIds: [挑的那位]`，名單原本有人時會被洗成一個人
 *
 * 現在釘住的是：
 * 1. ⛔ 不讀客人好友清單、⛔ 不寫任何設定（綁定只能本人用手機掃，小幫手代不了）
 * 2. 講清楚後果，並給一條直接打開掃 QR 那一塊的路（`?add=me`）
 */
import { describe, expect, it, vi } from 'vitest'
import { useAgentScriptRunner } from '../composables/useAgentScriptRunner'
import { AGENT_GUIDES } from './agent-guides'
import type { AgentGuideCtx } from './agent-guides'

const guide = AGENT_GUIDES['handoff-notify']

function makeCtx() {
  const calls: { url: string, method?: string }[] = []
  const apiFetch = vi.fn(async (url: string, opts?: any) => {
    calls.push({ url, method: opts?.method })
    return {}
  })
  const r = useAgentScriptRunner({ sayDelayMs: 0, pollIntervalMs: 5 })
  const ctx: AgentGuideCtx = { r, apiFetch: apiFetch as any, workspaceId: 'w1', state: {} }
  return { r, ctx, calls }
}

const htmlOf = (r: ReturnType<typeof useAgentScriptRunner>) =>
  r.entries.value.map(e => JSON.stringify(e.msg)).join('\n')

describe('handoff-notify 劇本（LINE 通知沒有人收）', () => {
  it('⛔ 不讀客人好友清單、⛔ 不寫任何設定', async () => {
    const { r, ctx, calls } = makeCtx()
    await r.runSteps(guide.steps, ctx)
    expect(calls.some(c => c.url.startsWith('/api/users/list'))).toBe(false)
    expect(calls.some(c => c.method && c.method !== 'GET')).toBe(false)
    expect(calls.some(c => c.url.startsWith('/api/ai/settings'))).toBe(false)
  })

  it('講清楚後果，並帶到「LINE 通知」頁、直接打開掃 QR（?add=me）', async () => {
    const { r, ctx } = makeCtx()
    await r.runSteps(guide.steps, ctx)
    const html = htmlOf(r)
    expect(html).toContain('沒有人的手機會收到通知')
    expect(html).toContain('/admin/w1/settings/line-notify?add=me')
    // ⛔ 不再指去 AI 設定（那一區已經搬走，舊連結只會轉一手）
    expect(html).not.toContain('ai-settings')
  })

  it('對應的提醒還是「沒有人會收到 LINE 通知」那一顆', () => {
    expect(guide.alertIds).toEqual(['handoffNotifyMissing'])
  })
})
