/**
 * 「設定轉真人通知」劇本測試（`C-31` Phase 1 三條之一，2026-09-16 補）。
 *
 * 為什麼這條最該先釘：三條 Phase 1 劇本裡**只有它會代使用者寫入**
 * （選完人就直接存進 AI 設定），是整個「代你操作」路線上第一個真的動到設定的地方。
 *
 * 釘住的是會騙人的行為：
 * 1. **存起來 ≠ 生效**——存完一定要把設定讀回來看一眼。少了那一步，寫入被擋掉或
 *    存成空的，劇本照樣說「設好了」，而客人找真人時仍然沒有人會收到通知。
 * 2. 抓不到好友清單時不可以丟一個空選單讓人乾等：要說原因並留一個走得回去的入口。
 * 3. 使用者沒選人（跳過、或清單是空的）就**一個字都不能寫進設定**。
 * 4. 查不到＝查不到：確認那一步失敗時，不說設好、也不說沒設好。
 */
import { describe, expect, it, vi } from 'vitest'
import { useAgentScriptRunner } from '../composables/useAgentScriptRunner'
import { AGENT_GUIDES } from './agent-guides'
import type { AgentGuideCtx } from './agent-guides'

const guide = AGENT_GUIDES['handoff-notify']

interface FakeOpts {
  /** /api/users/list 的回應；Error＝這支查詢掛掉 */
  users?: unknown
  /** 存完之後把設定讀回來的回應（依序）；Error＝這次確認失敗 */
  settingsAfter?: unknown[]
}

/** 假 apiFetch：好友清單、存檔（記下 body）、讀回設定三支，其餘一律視為劇本走錯路 */
function makeCtx(o: FakeOpts = {}) {
  const puts: any[] = []
  const gets: string[] = []
  const settingsQueue = [...(o.settingsAfter ?? [])]
  const apiFetch = vi.fn(async (url: string, opts?: any) => {
    if (url.startsWith('/api/users/list')) {
      if (o.users instanceof Error) throw o.users
      return o.users ?? { users: [] }
    }
    if (url === '/api/ai/settings' && opts?.method === 'PUT') {
      puts.push(opts.body)
      return { ok: true }
    }
    if (url === '/api/ai/settings') {
      gets.push(url)
      const next = settingsQueue.shift()
      if (next instanceof Error) throw next
      if (next === undefined) throw new Error('settings queue 用完了：劇本比預期多讀了一次')
      return next
    }
    throw new Error(`未預期的 API：${url}`)
  })
  const r = useAgentScriptRunner({ sayDelayMs: 0, pollIntervalMs: 5 })
  const ctx: AgentGuideCtx = { r, apiFetch: apiFetch as any, workspaceId: 'w1', state: {} }
  return { r, ctx, puts, gets }
}

const htmlOf = (r: ReturnType<typeof useAgentScriptRunner>) =>
  r.entries.value.map(e => JSON.stringify(e.msg)).join('\n')

const waitPicker = (r: ReturnType<typeof useAgentScriptRunner>) =>
  vi.waitFor(() => {
    if (r.ask.value.kind !== 'picker') throw new Error('還沒出現選人清單')
  })

const FRIENDS = {
  users: [
    { lineUserId: 'U1', displayName: '小明', pictureUrl: 'https://img/1.png' },
    { lineUserId: 'U2', displayName: '阿華' },
    { lineUserId: '', displayName: '沒有 id 的人' },
  ],
}

describe('handoff-notify 劇本', () => {
  it('選人 → 代你存起來 → 真的讀回來確認過才說設好', async () => {
    const { r, ctx, puts, gets } = makeCtx({
      users: FRIENDS,
      settingsAfter: [{ handoffNotify: { enabled: true, lineUserIds: ['U1'] } }],
    })
    const done = r.runSteps(guide.steps, ctx)

    await waitPicker(r)
    // 沒有 lineUserId 的那筆要被濾掉：選了也存不進去，列出來只會讓人白選一次
    const ask = r.ask.value as { kind: 'picker', options: { id: string }[] }
    expect(ask.options.map(o => o.id)).toEqual(['U1', 'U2'])

    r.onPick({ id: 'U1', label: '小明' })
    await done

    // 存進去的內容：開關要一起打開，只設 lineUserIds 而 enabled 還是 false 等於沒設
    expect(puts).toEqual([{
      handoffNotify: { enabled: true, lineUserIds: ['U1'], displayNames: { U1: '小明' } },
    }])
    // 🔴 關鍵：存完必須真的再讀一次（這一趟就是「存起來 ≠ 生效」的防線）
    expect(gets).toHaveLength(1)
    expect(htmlOf(r)).toContain('設好了')
    expect(htmlOf(r)).toContain('小明')
    expect(htmlOf(r)).toContain('"state":"ok"')
  })

  it('🔴 存完讀回來還是空的：不可以說設好，要指回設定頁', async () => {
    const { r, ctx, puts } = makeCtx({
      users: FRIENDS,
      settingsAfter: [{ handoffNotify: { enabled: false, lineUserIds: [] } }],
    })
    const done = r.runSteps(guide.steps, ctx)

    await waitPicker(r)
    r.onPick({ id: 'U2', label: '阿華' })
    await done

    expect(puts).toHaveLength(1) // 有試著存
    const html = htmlOf(r)
    expect(html).not.toContain('設好了') // 但不准報喜
    expect(html).toContain('還是空的')
    expect(html).toContain('"state":"fail"')
    expect(html).toContain('ai-settings?focus=handoff') // 留一條自己走得回去的路
  })

  it('抓不到好友清單：說清楚原因＋給入口，⛔不丟空選單、也不寫入任何設定', async () => {
    const { r, ctx, puts } = makeCtx({ users: { users: [] } })
    await r.runSteps(guide.steps, ctx)

    expect(r.ask.value.kind).not.toBe('picker')
    expect(puts).toHaveLength(0)
    const html = htmlOf(r)
    expect(html).toContain('抓不到好友清單')
    expect(html).toContain('ai-settings?focus=handoff')
  })

  it('好友清單查詢掛掉：同樣走空清單出口，不會把錯誤吞成「沒有好友」就報喜', async () => {
    const { r, ctx, puts } = makeCtx({ users: new Error('boom') })
    await r.runSteps(guide.steps, ctx)

    expect(puts).toHaveLength(0)
    expect(htmlOf(r)).not.toContain('設好了')
    expect(htmlOf(r)).toContain('抓不到好友清單')
  })

  it('選人那一步跳過：講清楚代價、留入口，且一個字都不寫進設定', async () => {
    const { r, ctx, puts } = makeCtx({ users: FRIENDS })
    const done = r.runSteps(guide.steps, ctx)

    await waitPicker(r)
    r.onSkip()
    await done

    expect(puts).toHaveLength(0)
    const html = htmlOf(r)
    expect(html).toContain('不會有人知道')
    expect(html).toContain('ai-settings?focus=handoff')
  })

  it('🔴 確認那一步查不到：不說設好、也不說沒設好', async () => {
    const { r, ctx } = makeCtx({
      users: FRIENDS,
      settingsAfter: [new Error('network down')],
    })
    const done = r.runSteps(guide.steps, ctx)

    await waitPicker(r)
    r.onPick({ id: 'U1', label: '小明' })
    await done

    const html = htmlOf(r)
    expect(html).toContain('不代表沒設好')
    expect(html).not.toContain('設好了')
    expect(html).toContain('"state":"skipped"')
  })
})
