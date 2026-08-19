/**
 * agent 劇本 runner——「帶著做」對話的共用引擎（C-31 Phase 1）。
 *
 * 從開通引導精靈（useOnboardingChat）抽出的 driver 無關原語：
 * say（打字節奏）/ card / ask 三態（按鈕、輸入、選人）/ apiRetry（失敗如實說明＋重試）/
 * pollUntil（換代計數輪詢）。開通精靈與小幫手的「帶你修好」引導劇本共用這一份，
 * 訊息合約＝shared/types/agent-messages（與 AgentMessageRenderer / AgentAskDock 成對）。
 *
 * 設計約束：
 * - 零 LLM、零 Nuxt 依賴（只吃 vue reactivity）——vitest node 環境直接可測。
 * - 取消（dispose）是一等公民：dispose 之後任何 say/waitAsk 會丟 AgentScriptCancelled，
 *   劇本鏈就地停下——修掉 G-14「離頁後 async 鏈繼續跑到下一個提問才停」的殘留。
 *   跑劇本一律走 runSteps / runScript，它們會把 AgentScriptCancelled 靜默吞掉。
 * - html 欄位僅限劇本文案；任何使用者輸入先過 escapeHtml（合約層的既有警語）。
 */

import { ref } from 'vue'
import type {
  AgentAsk,
  AgentChatEntry,
  AgentChoice,
  AgentMsg,
  AgentPickerOption,
} from '~~/shared/types/agent-messages'
import { escapeHtml } from '~~/shared/types/agent-messages'

/** dispose 之後劇本原語一律丟這個：讓 async 鏈就地停下，由 runSteps/runScript 靜默收掉 */
export class AgentScriptCancelled extends Error {
  constructor() {
    super('agent script cancelled')
    this.name = 'AgentScriptCancelled'
  }
}

/** 使用者對輸入區的回應 */
export type AgentAskResult =
  | { type: 'choice', value: string }
  | { type: 'text', value: string }
  | { type: 'pick', option: AgentPickerOption }
  | { type: 'skip' }
  | { type: 'cancelled' }

/**
 * 宣告式劇本步驟：guard 回 true＝這步已完成或不適用，靜默跳過。
 * 「resume＝逐步自我檢查，不存進行到第幾步」的機制就落在 guard 上。
 */
export interface AgentScriptStep<Ctx> {
  id: string
  guard?: (ctx: Ctx) => boolean | Promise<boolean>
  run: (ctx: Ctx) => Promise<void>
}

const DEFAULT_SAY_DELAY_MS = 420
const DEFAULT_POLL_INTERVAL_MS = 4000

export function useAgentScriptRunner(opts: { sayDelayMs?: number, pollIntervalMs?: number } = {}) {
  const sayDelayMs = opts.sayDelayMs ?? DEFAULT_SAY_DELAY_MS
  const defaultPollMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS

  const entries = ref<AgentChatEntry[]>([])
  const ask = ref<AgentAsk>({ kind: 'idle' })
  const typing = ref(false)
  const busy = ref(false)

  let nextId = 1
  let resolveAsk: ((r: AgentAskResult) => void) | null = null
  let disposed = false
  // 停輪詢用換代計數，不用共用布林：布林會被下一輪重設，讓還睡在 sleep 裡的
  // 舊輪詢器醒來復活，一場等待疊出好幾支（2026-08-12 開通精靈踩過的雷，機制原樣搬來）
  let pollGen = 0

  // ── 基本原語 ────────────────────────────────────────────────

  function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms))
  }

  function isDisposed(): boolean {
    return disposed
  }

  /** dispose 後劇本不該再往下走：每個「會停下來」的原語進場先過這關 */
  function checkpoint() {
    if (disposed)
      throw new AgentScriptCancelled()
  }

  function push(role: 'agent' | 'user', msg: AgentMsg): number {
    const id = nextId++
    entries.value.push({ id, role, msg })
    return id
  }

  function updateMsg(id: number, msg: AgentMsg) {
    const e = entries.value.find(x => x.id === id)
    if (e)
      e.msg = msg
  }

  /** agent 說一句話（打字節奏 → 泡泡）。html 僅限劇本文案＋已跳脫的輸入 */
  async function say(html: string) {
    checkpoint()
    typing.value = true
    await sleep(sayDelayMs)
    typing.value = false
    checkpoint()
    push('agent', { kind: 'text', html })
    await sleep(sayDelayMs > 0 ? 120 : 0) // 句與句之間的小停頓；測試把 sayDelayMs 設 0 時一併歸零
  }

  function card(msg: AgentMsg): number {
    return push('agent', msg)
  }

  function sayUser(text: string) {
    push('user', { kind: 'text', html: escapeHtml(text) })
  }

  // ── 提問／回答 ──────────────────────────────────────────────

  async function waitAsk(a: AgentAsk): Promise<AgentAskResult> {
    checkpoint()
    ask.value = a
    const r = await new Promise<AgentAskResult>((res) => { resolveAsk = res })
    // dispose 造成的 cancelled 要讓劇本鏈停下（丟例外），
    // 劇本自己 settle({cancelled}) 收按鈕（例如等待卡收到訊息）則照常回傳
    if (disposed && r.type === 'cancelled')
      throw new AgentScriptCancelled()
    return r
  }

  function settle(r: AgentAskResult) {
    const res = resolveAsk
    resolveAsk = null
    ask.value = { kind: 'idle' }
    res?.(r)
  }

  // 頁面事件 → 回填目前的提問（給 AgentAskDock 的四個 emit 接）
  function onChoice(value: string) {
    if (ask.value.kind !== 'choices')
      return
    const opt = ask.value.options.find(o => o.value === value)
    // 對不上目前的選項（例如點到剛被換掉的舊按鈕）：整個當沒發生，
    // 不能默默 settle——上一組選單的值被當成這一組的答案，就是「沒人按過卻跳過了」
    if (!opt)
      return
    sayUser(opt.label)
    settle({ type: 'choice', value })
  }

  function onSubmit(text: string) {
    if (ask.value.kind !== 'input')
      return
    sayUser(ask.value.inputType === 'secret' ? '••••••••••（已輸入）' : text)
    settle({ type: 'text', value: text })
  }

  function onPick(option: AgentPickerOption) {
    if (ask.value.kind !== 'picker')
      return
    sayUser(option.label)
    settle({ type: 'pick', option })
  }

  function onSkip() {
    // 只有輸入格／選人格有跳過鈕；游離的 skip 事件不能憑空冒出「先跳過」泡泡
    if (ask.value.kind !== 'input' && ask.value.kind !== 'picker')
      return
    // 泡泡跟按鈕字樣一致：輸入格可以自訂跳過鈕字樣（例：等等，我想看教學）
    sayUser((ask.value.kind === 'input' && ask.value.skipLabel) || '先跳過')
    settle({ type: 'skip' })
  }

  async function askChoices(options: AgentChoice[]): Promise<string> {
    const r = await waitAsk({ kind: 'choices', options })
    return r.type === 'choice' ? r.value : ''
  }

  /** 問一格輸入。回 null = 使用者跳過。validate 回錯誤文案時會重問。 */
  async function askInput(o: {
    inputType: 'text' | 'secret' | 'url'
    placeholder?: string
    maxLength?: number
    skippable?: boolean
    skipLabel?: string
    validate?: (v: string) => string | null
  }): Promise<string | null> {
    while (true) {
      const r = await waitAsk({
        kind: 'input',
        inputType: o.inputType,
        placeholder: o.placeholder,
        maxLength: o.maxLength,
        skippable: o.skippable,
        skipLabel: o.skipLabel,
      })
      if (r.type === 'skip')
        return null
      if (r.type !== 'text')
        continue
      const err = o.validate?.(r.value)
      if (err) {
        await say(err)
        continue
      }
      return r.value
    }
  }

  async function askPicker(options: AgentPickerOption[], skippable: boolean): Promise<AgentPickerOption | null> {
    const r = await waitAsk({ kind: 'picker', options, skippable })
    return r.type === 'pick' ? r.option : null
  }

  /**
   * 包一個 API 呼叫：失敗時如實說明並讓使用者「再試一次」。
   * skipLabel 有給才提供跳過出口（回 null）。
   */
  async function apiRetry<T>(fn: () => Promise<T>, o: { failText: string, skipLabel?: string } = { failText: '出了點問題' }): Promise<T | null> {
    while (true) {
      busy.value = true
      try {
        return await fn()
      }
      catch (e: unknown) {
        if (e instanceof AgentScriptCancelled)
          throw e
        const detail = (e as { data?: { statusMessage?: string }, message?: string })?.data?.statusMessage
          || (e as { message?: string })?.message || ''
        await say(`${o.failText}${detail ? `：${escapeHtml(detail)}` : '，請再試一次。'}`)
        const options: AgentChoice[] = [{ label: '再試一次', value: 'retry', primary: true }]
        if (o.skipLabel)
          options.push({ label: o.skipLabel, value: 'skip' })
        const c = await askChoices(options)
        if (c === 'skip')
          return null
      }
      finally {
        busy.value = false
      }
    }
  }

  // ── 輪詢（訊號等待卡的心臟） ────────────────────────────────

  /**
   * 每隔 intervalMs 呼叫一次 probe，回傳非 null 就結束並回傳該值；
   * stop()／dispose／新一代輪詢啟動時，醒來就退出（回 null）。
   * 頁面在背景時跳過該輪（省請求；回前景下一輪自然補上）。
   */
  function pollUntil<T>(probe: () => Promise<T | null>, intervalMs = defaultPollMs): { promise: Promise<T | null>, stop: () => void } {
    const gen = ++pollGen
    const promise = (async () => {
      while (gen === pollGen && !disposed) {
        if (typeof document === 'undefined' || document.visibilityState === 'visible') {
          try {
            const r = await probe()
            if (r != null)
              return r
          }
          catch { /* 單次失敗等下一輪，不打斷等待 */ }
        }
        await sleep(intervalMs)
      }
      return null
    })()
    return { promise, stop: () => { pollGen++ } }
  }

  // ── 劇本執行 ────────────────────────────────────────────────

  /** 依序跑宣告式步驟：guard 回 true 靜默跳過；取消（dispose）靜默收掉，其他錯誤照拋 */
  async function runSteps<Ctx>(steps: AgentScriptStep<Ctx>[], ctx: Ctx): Promise<void> {
    try {
      for (const s of steps) {
        checkpoint()
        if (s.guard && await s.guard(ctx))
          continue
        await s.run(ctx)
      }
    }
    catch (e) {
      if (e instanceof AgentScriptCancelled)
        return
      throw e
    }
  }

  /** 跑一段命令式劇本（開通精靈的 start 用）：只負責把取消靜默收掉 */
  async function runScript(fn: () => Promise<void>): Promise<void> {
    try {
      await fn()
    }
    catch (e) {
      if (e instanceof AgentScriptCancelled)
        return
      throw e
    }
  }

  function dispose() {
    disposed = true
    pollGen++ // 讓還睡在 sleep 裡的輪詢器下一次醒來就退出
    // 收掉還掛著的提問：等待中的劇本拿到 cancelled，下一個原語就丟 AgentScriptCancelled 停下
    if (resolveAsk)
      settle({ type: 'cancelled' })
    ask.value = { kind: 'idle' }
  }

  return {
    // 給頁面/面板綁的狀態
    entries,
    ask,
    typing,
    busy,
    // AgentAskDock 的四個事件
    onChoice,
    onSubmit,
    onPick,
    onSkip,
    // 劇本原語
    say,
    card,
    sayUser,
    updateMsg,
    waitAsk,
    settle,
    askChoices,
    askInput,
    askPicker,
    apiRetry,
    sleep,
    pollUntil,
    checkpoint,
    isDisposed,
    runSteps,
    runScript,
    dispose,
  }
}

export type AgentScriptRunner = ReturnType<typeof useAgentScriptRunner>
