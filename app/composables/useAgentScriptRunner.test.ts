/**
 * agent 劇本 runner 測試：原語行為（say/ask/apiRetry/pollUntil）與取消語意。
 * 開通精靈與「帶你修好」引導劇本共用這顆引擎——這裡綠了，兩邊的機械行為才有保障。
 */
import { describe, it, expect, vi } from 'vitest'
import { useAgentScriptRunner, AgentScriptCancelled } from './useAgentScriptRunner'

const make = () => useAgentScriptRunner({ sayDelayMs: 0, pollIntervalMs: 5 })

const tick = () => new Promise(r => setTimeout(r, 0))

describe('useAgentScriptRunner（原語）', () => {
  it('say：推一則 agent 泡泡；sayUser 會跳脫 HTML', async () => {
    const r = make()
    await r.say('嗨，<b>你好</b>')
    r.sayUser('<script>alert(1)</script>')
    expect(r.entries.value).toHaveLength(2)
    expect(r.entries.value[0]).toMatchObject({ role: 'agent', msg: { kind: 'text', html: '嗨，<b>你好</b>' } })
    expect((r.entries.value[1]!.msg as any).html).not.toContain('<script>')
  })

  it('askChoices：按有效選項 → 回值＋長使用者泡泡；按不存在的值 → 當沒發生', async () => {
    const r = make()
    const p = r.askChoices([{ label: '好', value: 'ok', primary: true }])
    await tick()
    expect(r.ask.value.kind).toBe('choices')
    r.onChoice('stale-value') // 舊按鈕的值:不能被當成這一題的答案
    expect(r.ask.value.kind).toBe('choices')
    r.onChoice('ok')
    await expect(p).resolves.toBe('ok')
    expect(r.entries.value.at(-1)).toMatchObject({ role: 'user', msg: { kind: 'text', html: '好' } })
    expect(r.ask.value.kind).toBe('idle')
  })

  it('askInput：validate 打回票會重問；secret 泡泡遮罩；skip 回 null', async () => {
    const r = make()
    const p = r.askInput({
      inputType: 'secret',
      validate: v => v.length < 5 ? '太短了' : null,
    })
    await tick()
    r.onSubmit('abc') // 不合格 → say 錯誤 → 重問
    await vi.waitFor(() => {
      if (r.ask.value.kind !== 'input')
        throw new Error('尚未重問')
    })
    expect(r.entries.value.some(e => (e.msg as any).html === '太短了')).toBe(true)
    // 遮罩:泡泡不能出現剛打的密鑰
    expect(r.entries.value.some(e => (e.msg as any).html?.includes('abc'))).toBe(false)
    r.onSubmit('long-enough-secret')
    await expect(p).resolves.toBe('long-enough-secret')

    const p2 = r.askInput({ inputType: 'text', skippable: true })
    await tick()
    r.onSkip()
    await expect(p2).resolves.toBeNull()
  })

  it('游離的 skip（目前是按鈕題）不能憑空冒出「先跳過」', async () => {
    const r = make()
    void r.askChoices([{ label: 'A', value: 'a' }])
    await tick()
    r.onSkip()
    expect(r.entries.value.some(e => (e.msg as any).html === '先跳過')).toBe(false)
  })

  it('apiRetry：失敗 → 如實說明＋再試一次 → 成功回值；選跳過回 null', async () => {
    const r = make()
    const fn = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('done')
    const p = r.apiRetry(fn, { failText: '存檔失敗' })
    await vi.waitFor(() => {
      if (r.ask.value.kind !== 'choices')
        throw new Error('還沒問')
    })
    expect(r.entries.value.some(e => String((e.msg as any).html).startsWith('存檔失敗'))).toBe(true)
    r.onChoice('retry')
    await expect(p).resolves.toBe('done')

    const p2 = r.apiRetry(() => Promise.reject(new Error('x')), { failText: '失敗', skipLabel: '先跳過' })
    await vi.waitFor(() => {
      if (r.ask.value.kind !== 'choices')
        throw new Error('還沒問')
    })
    r.onChoice('skip')
    await expect(p2).resolves.toBeNull()
  })

  it('pollUntil：probe 回非 null 就結束；stop 後醒來退出回 null', async () => {
    const r = make()
    let n = 0
    const h = r.pollUntil(async () => (++n >= 3 ? 'got' : null), 1)
    await expect(h.promise).resolves.toBe('got')

    const h2 = r.pollUntil(async () => null, 1)
    h2.stop()
    await expect(h2.promise).resolves.toBeNull()
  })
})

describe('useAgentScriptRunner（取消語意，G-14）', () => {
  it('dispose 讓等待中的劇本鏈就地停下，不再長出下一句話', async () => {
    const r = make()
    let ranAfter = false
    const script = r.runScript(async () => {
      await r.say('第一句')
      await r.askChoices([{ label: '好', value: 'ok' }]) // 停在這裡等
      ranAfter = true
      await r.say('不該出現的下一句')
    })
    await vi.waitFor(() => {
      if (r.ask.value.kind !== 'choices')
        throw new Error('還沒問')
    })
    r.dispose()
    await script // 不 throw、靜默收掉
    expect(ranAfter).toBe(false)
    expect(r.entries.value.some(e => (e.msg as any).html === '不該出現的下一句')).toBe(false)
  })

  it('dispose 後 say 直接丟 AgentScriptCancelled（runScript 之外呼叫要自己接）', async () => {
    const r = make()
    r.dispose()
    await expect(r.say('hi')).rejects.toBeInstanceOf(AgentScriptCancelled)
  })

  it('runSteps：guard 回 true 靜默跳過；其餘依序執行；中途 dispose 靜默收掉', async () => {
    const r = make()
    const ran: string[] = []
    await r.runSteps([
      { id: 'a', run: async () => { ran.push('a') } },
      { id: 'b', guard: () => true, run: async () => { ran.push('b') } },
      { id: 'c', run: async () => { ran.push('c') } },
    ], {})
    expect(ran).toEqual(['a', 'c'])

    const ran2: string[] = []
    const p = r.runSteps([
      { id: 'x', run: async () => { ran2.push('x'); await r.askChoices([{ label: 'k', value: 'k' }]) } },
      { id: 'y', run: async () => { ran2.push('y') } },
    ], {})
    await vi.waitFor(() => {
      if (r.ask.value.kind !== 'choices')
        throw new Error('還沒問')
    })
    r.dispose()
    await p
    expect(ran2).toEqual(['x'])
  })

  it('runSteps：劇本自己的錯誤照拋，不會被取消處理吞掉', async () => {
    const r = make()
    await expect(r.runSteps([{ id: 'bad', run: async () => { throw new Error('real bug') } }], {}))
      .rejects.toThrow('real bug')
  })
})
