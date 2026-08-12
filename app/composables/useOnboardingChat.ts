/**
 * 開通引導對話 agent：劇本狀態機（零 LLM）。
 *
 * 設計釘死（docs/ONBOARDING-CHAT-DESIGN-20260807.md）：
 * - 對話感來自 UI 節奏，不來自模型——整段流程是寫死的劇本，永遠不會「說你設好了但其實沒有」。
 * - 每一步「完成了沒」由後端真實訊號判定（setup-status / line-workspace / ai settings），
 *   劇本只轉述；續走（resume）= 逐步自我檢查「已完成就靜默跳過」，不存「進行到第幾步」。
 * - 憑證只在這裡收、走既有 PUT 端點（admin 權限），不落 log、不進 LLM。
 * - 每一步可跳過；跳過記 localStorage（純 UX 記憶，不當事實來源），加分項之後由健康卡盯。
 */

import type {
  AgentAsk,
  AgentChatEntry,
  AgentChoice,
  AgentMsg,
  AgentPickerOption,
} from '~~/shared/types/agent-messages'
import { escapeHtml } from '~~/shared/types/agent-messages'
import type { SetupCapabilityId, SetupItemStatus, SetupStatusResponse } from '~~/shared/types/setup'
import { BILLING_PLANS } from '~~/shared/billing/plans'

export const ONBOARDING_PROGRESS_LABELS = ['建立', '接 LINE', '測試', '開 AI', '完成'] as const

/** 使用者對輸入區的回應（內部用） */
type AskResult =
  | { type: 'choice', value: string }
  | { type: 'text', value: string }
  | { type: 'pick', option: AgentPickerOption }
  | { type: 'skip' }
  | { type: 'cancelled' }

interface LineStatus {
  tokenConfigured: boolean
  secretConfigured: boolean
  liffConfigured: boolean
  publicBaseUrl: string
}

interface FirstMessageRes {
  received: boolean
  text?: string
  messageType?: string
  at?: string
}

const SAY_DELAY_MS = 420
const POLL_INTERVAL_MS = 4000
/** 等第一則訊息多久沒動靜，就主動開口排障（別讓人乾瞪著轉圈） */
const FIRST_MSG_HINT_MS = 45_000

export function useOnboardingChat() {
  // 這個精靈自己管 workspaceId：建立流程一開始還沒有、續走模式來自 ?workspaceId=，
  // 都不在路由參數裡，所以不能用 useWorkspace() 的 route-based apiFetch。
  const wid = ref('')
  const { apiFetch, getBearer } = useWorkspaceApiFetch(() => wid.value)
  const { loadWorkspaceList, workspaceList } = useWorkspace()

  const entries = ref<AgentChatEntry[]>([])
  const ask = ref<AgentAsk>({ kind: 'idle' })
  const typing = ref(false)
  const busy = ref(false)
  const progress = ref(0)

  let nextId = 1
  let resolveAsk: ((r: AskResult) => void) | null = null
  let disposed = false
  let stopPolling = false

  // ── 基本動作 ────────────────────────────────────────────────

  function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms))
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
    typing.value = true
    await sleep(SAY_DELAY_MS)
    typing.value = false
    push('agent', { kind: 'text', html })
    await sleep(120)
  }

  function card(msg: AgentMsg): number {
    return push('agent', msg)
  }

  function sayUser(text: string) {
    push('user', { kind: 'text', html: escapeHtml(text) })
  }

  function waitAsk(a: AgentAsk): Promise<AskResult> {
    ask.value = a
    return new Promise((r) => { resolveAsk = r })
  }

  function settle(r: AskResult) {
    const res = resolveAsk
    resolveAsk = null
    ask.value = { kind: 'idle' }
    res?.(r)
  }

  // 頁面事件 → 回填目前的提問
  function onChoice(value: string) {
    if (ask.value.kind !== 'choices')
      return
    const opt = ask.value.options.find(o => o.value === value)
    if (opt)
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
    sayUser('先跳過')
    settle({ type: 'skip' })
  }

  async function askChoices(options: AgentChoice[]): Promise<string> {
    const r = await waitAsk({ kind: 'choices', options })
    return r.type === 'choice' ? r.value : ''
  }

  /** 問一格輸入。回 null = 使用者跳過。validate 回錯誤文案時會重問。 */
  async function askInput(opts: {
    inputType: 'text' | 'secret' | 'url'
    placeholder?: string
    maxLength?: number
    skippable?: boolean
    validate?: (v: string) => string | null
  }): Promise<string | null> {
    while (true) {
      const r = await waitAsk({
        kind: 'input',
        inputType: opts.inputType,
        placeholder: opts.placeholder,
        maxLength: opts.maxLength,
        skippable: opts.skippable,
      })
      if (r.type === 'skip')
        return null
      if (r.type !== 'text')
        continue
      const err = opts.validate?.(r.value)
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
  async function apiRetry<T>(fn: () => Promise<T>, opts: { failText: string, skipLabel?: string } = { failText: '出了點問題' }): Promise<T | null> {
    while (true) {
      busy.value = true
      try {
        return await fn()
      }
      catch (e: unknown) {
        const detail = (e as { data?: { statusMessage?: string }, message?: string })?.data?.statusMessage
          || (e as { message?: string })?.message || ''
        await say(`${opts.failText}${detail ? `：${escapeHtml(detail)}` : '，請再試一次。'}`)
        const options: AgentChoice[] = [{ label: '再試一次', value: 'retry', primary: true }]
        if (opts.skipLabel)
          options.push({ label: opts.skipLabel, value: 'skip' })
        const c = await askChoices(options)
        if (c === 'skip')
          return null
      }
      finally {
        busy.value = false
      }
    }
  }

  // ── 跳過記憶（純 UX，不當事實來源） ─────────────────────────

  type SkipKey = 'liff' | 'shopUrl' | 'handoff' | 'firstMsg'

  function skips(): Record<string, boolean> {
    try {
      return JSON.parse(localStorage.getItem(`onb-skips:${wid.value}`) || '{}')
    }
    catch {
      return {}
    }
  }

  function markSkip(key: SkipKey) {
    try {
      localStorage.setItem(`onb-skips:${wid.value}`, JSON.stringify({ ...skips(), [key]: true }))
    }
    catch { /* 無痕模式等寫不進去就算了，只影響下次會再問一次 */ }
  }

  // ── 真實訊號 ────────────────────────────────────────────────

  async function fetchLineStatus(): Promise<LineStatus> {
    const r = await apiFetch<{
      publicBaseUrl: string
      defaultLiffId: string
      channelAccessTokenConfigured: boolean
      channelSecretConfigured: boolean
    }>('/api/admin/line-workspace')
    return {
      tokenConfigured: r.channelAccessTokenConfigured,
      secretConfigured: r.channelSecretConfigured,
      liffConfigured: !!String(r.defaultLiffId || '').trim(),
      publicBaseUrl: String(r.publicBaseUrl || '').trim(),
    }
  }

  async function fetchSetup(): Promise<Partial<Record<SetupCapabilityId, SetupItemStatus>>> {
    const r = await apiFetch<SetupStatusResponse>('/api/admin/setup-status')
    const map: Partial<Record<SetupCapabilityId, SetupItemStatus>> = {}
    for (const it of r.items)
      map[it.id] = it.status
    return map
  }

  interface AiSnapshot {
    enabled: boolean
    replyMode: 'auto' | 'draft'
    shopUrl: string
    handoffReady: boolean
  }

  async function fetchAi(): Promise<AiSnapshot> {
    const r = await apiFetch<{
      enabled: boolean
      replyMode: 'auto' | 'draft'
      shopUrl?: string
      handoffNotify: { enabled: boolean, lineUserIds: string[] }
    }>('/api/ai/settings')
    return {
      enabled: r.enabled === true,
      replyMode: r.replyMode === 'draft' ? 'draft' : 'auto',
      shopUrl: String(r.shopUrl || '').trim(),
      handoffReady: r.handoffNotify?.enabled === true && (r.handoffNotify?.lineUserIds?.length ?? 0) > 0,
    }
  }

  // ── 劇本 ────────────────────────────────────────────────────

  const freePlanName = BILLING_PLANS.free.name
  const freeQuota = BILLING_PLANS.free.answeredQuota

  /** 這一輪跑完後給摘要用的紀錄 */
  const outcome = {
    aiModeLabel: '',
    testSkipped: false,
  }

  async function stepWelcomeFresh(): Promise<boolean> {
    progress.value = 0
    await say('嗨，我是小幫手 👋 接下來我用聊天的方式，帶你把客服機器人設定到可以上線，大約 10 分鐘。')
    await say('一共四步，跟上面的進度條一格一格對得上：<b>建立帳號</b> → <b>接上 LINE</b> → <b>傳一句話測試</b> → <b>打開 AI</b>，做完就亮最後一格「完成」。隨時可以離開，下次回來我會從沒做完的地方接著帶。')
    const c = await askChoices([
      { label: '開始吧', value: 'go', primary: true },
      { label: '我想先自己逛逛', value: 'browse' },
    ])
    if (c === 'browse') {
      await say('沒問題！想開始的時候，從「我想開始使用」進來就行。')
      await navigateTo('/admin/workspaces')
      return false
    }
    return true
  }

  async function stepCreate(): Promise<boolean> {
    await say('先幫你的官方帳號取個名字，通常用品牌名，之後隨時能改。')
    while (true) {
      const name = await askInput({ inputType: 'text', placeholder: '例：小福商店', maxLength: 40 })
      if (name == null)
        continue
      busy.value = true
      try {
        const token = await getBearer()
        const res = await $fetch<{ workspaceId: string }>('/api/onboarding/self-serve', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: { workspaceName: name },
        })
        wid.value = res.workspaceId
        // 剛建好的帳號還不在前端清單裡，auth middleware 靠那份清單認人——先重載，
        // 結束時導航才不會被自己的守衛擋下來
        await loadWorkspaceList().catch(() => {})
        await say(`「${escapeHtml(name)}」建好了 ✓ 已幫你開好${escapeHtml(freePlanName)}方案，每月 ${freeQuota} 則 AI 回覆免費額度、不需綁卡。`)
        progress.value = 1
        return true
      }
      catch (e: unknown) {
        const msg = (e as { data?: { statusMessage?: string } })?.data?.statusMessage || '建立失敗，請稍後再試'
        await say(escapeHtml(msg))
        const c = await askChoices([
          { label: '再試一次', value: 'retry', primary: true },
          { label: '回帳號選擇', value: 'exit' },
        ])
        if (c === 'exit') {
          await navigateTo('/admin/workspaces')
          return false
        }
        await say('好，再取一次名字。')
      }
      finally {
        busy.value = false
      }
    }
  }

  async function stepWelcomeBack(line: LineStatus, setup: Partial<Record<SetupCapabilityId, SetupItemStatus>>, ai: AiSnapshot) {
    const name = workspaceList.value.find(w => w.workspaceId === wid.value)?.name || ''
    await say(`歡迎回來${name ? `，「${escapeHtml(name)}」` : ''}！我們接著把剩下的設定做完，做過的我會直接跳過。`)
    if (!line.tokenConfigured || !line.secretConfigured)
      progress.value = 1
    else if (setup.firstMessageReceived !== 'done')
      progress.value = 2
    else
      progress.value = 3 // 開 AI 或只剩加分項都停在這格，「完成」由 stepDone 點亮
  }

  async function stepHasOA() {
    await say('你已經有 LINE 官方帳號了嗎？')
    const c = await askChoices([
      { label: '有', value: 'yes', primary: true },
      { label: '還沒', value: 'no' },
    ])
    if (c === 'no') {
      await say('先去 <b>LINE Official Account Manager</b> 免費申請一個，大約 5 分鐘。申請好之後，記得在官方帳號後台的「設定 → Messaging API」按<b>啟用</b>——沒啟用的話，等下要拿鑰匙的地方會找不到你的帳號。弄好回來按繼續。')
      card({ kind: 'link', label: '前往申請 LINE 官方帳號（台灣）', href: 'https://tw.linebiz.com/entry/' })
      await askChoices([{ label: '申請好了，繼續', value: 'ok', primary: true }])
    }
  }

  async function stepToken(line: LineStatus) {
    if (line.tokenConfigured)
      return
    await say('接下來要從 LINE 拿兩把鑰匙，都在 <b>LINE Developers</b> 後台。第一把：<b>Channel Access Token</b>——機器人要靠它替你傳訊息。')
    card({
      kind: 'help',
      summary: '怎麼拿？',
      steps: [
        '打開 LINE Developers 並登入（下面有連結）',
        '選你的官方帳號 → Messaging API 分頁',
        '（清單裡沒有你的帳號？先回官方帳號後台「設定 → Messaging API」按啟用，它才會出現）',
        '最下方 Channel access token 按「Issue」',
        '整串複製，回來貼上',
      ],
      href: 'https://developers.line.biz/console/',
      hrefLabel: '打開 LINE Developers ↗',
    })
    while (true) {
      const v = await askInput({
        inputType: 'secret',
        placeholder: '貼上 Channel Access Token',
        validate: t => t.length < 20 ? '這串看起來太短了，Channel Access Token 是很長的一串，請整串複製過來。' : null,
      })
      if (v == null)
        continue
      const ok = await apiRetry(
        () => apiFetch('/api/admin/line-workspace', { method: 'PUT', body: { channelAccessToken: v } }),
        { failText: '存檔失敗' },
      )
      if (ok !== null) {
        line.tokenConfigured = true
        await say('收到 ✓ 已經幫你存好。')
        return
      }
    }
  }

  async function stepSecret(line: LineStatus) {
    if (line.secretConfigured)
      return
    await say('第二把：<b>Channel Secret</b>——用來確認訊息真的來自 LINE、不是別人假冒的。')
    card({
      kind: 'help',
      summary: '怎麼拿？',
      steps: ['同一個後台 → Basic settings 分頁', '找到 Channel secret，複製過來'],
      href: 'https://developers.line.biz/console/',
      hrefLabel: '打開 LINE Developers ↗',
    })
    while (true) {
      const v = await askInput({
        inputType: 'secret',
        placeholder: '貼上 Channel Secret',
        validate: t => t.length < 10 ? '這串看起來太短了，請到 Basic settings 分頁整串複製 Channel secret。' : null,
      })
      if (v == null)
        continue
      const ok = await apiRetry(
        () => apiFetch('/api/admin/line-workspace', { method: 'PUT', body: { channelSecret: v } }),
        { failText: '存檔失敗' },
      )
      if (ok !== null) {
        line.secretConfigured = true
        await say('好了 ✓ 兩把鑰匙都到手，剩最後一步接線。')
        return
      }
    }
  }

  /** 加分題（2026-08-07 拍板選填；刻意排在魔法時刻之後，不擋主線） */
  async function stepLiff(line: LineStatus) {
    if (line.liffConfigured || skips().liff)
      return
    await say('加分題：<b>LIFF ID</b>（選填）——之後要做活動頁、會員綁定頁才會用到。第一天用不到的話，先跳過完全沒問題。')
    card({
      kind: 'help',
      summary: '怎麼拿？',
      steps: [
        'LINE Developers → LIFF 分頁按「Add」',
        'Endpoint URL 貼下面那串專用網址（不是你的官網——填錯的話之後活動連結會打不開）',
        '建好後複製 LIFF ID（長得像 1234567890-Abcdefgh）',
      ],
      href: 'https://developers.line.biz/console/',
      hrefLabel: '打開 LINE Developers ↗',
    })
    // 口徑必須跟 liff-endpoint-check 的 expectedUrl 一致（appBaseUrl + /liff/lead）——
    // 教一套、健康檢查驗另一套的話，照著做的人剛開通完就會被亮紅
    card({ kind: 'copy', label: 'LIFF 的 Endpoint URL（活動頁專用）', value: `${line.publicBaseUrl || window.location.origin}/liff/lead` })
    const v = await askInput({
      inputType: 'text',
      placeholder: '例：1234567890-Abcdefgh',
      skippable: true,
    })
    if (v == null) {
      markSkip('liff')
      await say('沒問題，先跳過。之後要辦活動時，右下角的小幫手會帶你補。')
      return
    }
    const ok = await apiRetry(
      () => apiFetch('/api/admin/line-workspace', { method: 'PUT', body: { defaultLiffId: v } }),
      { failText: '存檔失敗', skipLabel: '先跳過' },
    )
    if (ok === null)
      markSkip('liff')
    else
      await say('存好了 ✓ 之後活動頁就能直接用。')
  }

  /** 呼叫既有的 verifyWebhookOnSave，回 {ok, message}；丟錯回 null（查不到≠沒接好） */
  async function verifyWebhook(webhookUrl: string): Promise<{ ok: boolean, message: string } | null> {
    busy.value = true
    try {
      const r = await apiFetch<{ webhookVerification?: { ok: boolean, message: string } }>(
        '/api/admin/line-workspace',
        { method: 'PUT', body: { verifyWebhookOnSave: true, compareWebhookUrl: webhookUrl } },
      )
      return r.webhookVerification ?? null
    }
    catch {
      return null
    }
    finally {
      busy.value = false
    }
  }

  /** Webhook 檢查一直過不了、而且錯誤長得像憑證問題時的出口：讓人當場重貼 Token */
  async function reenterToken(line: LineStatus) {
    await say('好，把新的 <b>Channel Access Token</b> 整串貼上來（LINE Developers → Messaging API 最下方可以重發一組）。')
    while (true) {
      const v = await askInput({
        inputType: 'secret',
        placeholder: '貼上 Channel Access Token',
        validate: t => t.length < 20 ? '這串看起來太短了，請整串複製過來。' : null,
      })
      if (v == null)
        continue
      const ok = await apiRetry(
        () => apiFetch('/api/admin/line-workspace', { method: 'PUT', body: { channelAccessToken: v } }),
        { failText: '存檔失敗' },
      )
      if (ok !== null) {
        line.tokenConfigured = true
        await say('換好了 ✓ 再檢查一次看看。')
        return
      }
    }
  }

  async function stepWebhookAndFirstMsg(
    line: LineStatus,
    setup: Partial<Record<SetupCapabilityId, SetupItemStatus>>,
    opts: { preVerify?: boolean } = {},
  ) {
    if (setup.firstMessageReceived === 'done') {
      progress.value = Math.max(progress.value, 3)
      return
    }

    // ── 接線：Webhook ──
    const webhookUrl = `${line.publicBaseUrl || window.location.origin}/webhook`
    let verified = false

    // 續走模式先靜默驗一次：之前就接好 Webhook 的人不用再被叫去貼一次網址
    if (opts.preVerify && line.tokenConfigured && line.secretConfigured) {
      const v = await verifyWebhook(webhookUrl)
      if (v?.ok) {
        await say('Webhook 之前就接好了 ✓ 直接來測試。')
        verified = true
      }
    }

    if (!verified) {
      await say('最後一步接線：把下面這串網址，貼到 LINE Developers → Messaging API 的 <b>Webhook URL</b> 欄位，存檔後打開 <b>Use webhook</b> 開關。')
      card({ kind: 'copy', label: '你的 Webhook 網址', value: webhookUrl })
      card({ kind: 'link', label: '打開 LINE Developers（Messaging API 分頁）', href: 'https://developers.line.biz/console/' })
    }

    while (!verified) {
      const c = await askChoices([
        { label: '貼好了，幫我檢查', value: 'check', primary: true },
        { label: '略過檢查，直接測試', value: 'skip' },
      ])
      if (c === 'skip')
        break
      const cardId = card({ kind: 'status', state: 'pending', text: '正在跟 LINE 確認 Webhook…' })
      const v = await verifyWebhook(webhookUrl)
      if (v?.ok) {
        updateMsg(cardId, { kind: 'status', state: 'ok', text: 'Webhook 已接通，LINE 回應正常' })
        await say('接線完成！你的官方帳號已經連上系統了。')
        verified = true
        continue
      }
      updateMsg(cardId, { kind: 'status', state: 'fail', text: v?.message || '檢查失敗，請再試一次' })
      const msg = v?.message || ''
      // 依真實錯誤分流建議——別叫使用者去查一個不是病因的地方
      if (/HTTP 401|查詢 Webhook 失敗/.test(msg)) {
        await say('這種錯誤通常是 <b>Channel Access Token 貼錯</b>——LINE 不認得我們帶的鑰匙。要重貼一次嗎？')
        const r = await askChoices([
          { label: '重貼 Token', value: 'retoken', primary: true },
          { label: '再檢查一次', value: 'again' },
        ])
        if (r === 'retoken')
          await reenterToken(line)
      }
      else if (/不一致/.test(msg)) {
        await say('LINE 後台填的網址跟上面那串不一樣——再複製一次、<b>整串</b>貼上並存檔，好了再按檢查。')
      }
      else {
        await say('照上面的訊息調整一下（最常見是還沒按存檔、或 <b>Use webhook</b> 開關沒打開），好了再按一次檢查。')
      }
    }

    // LINE 內建「自動回應訊息」預設開啟，會跟機器人搶話（客人每句話收到兩套回覆）。
    // 這個開關 LINE 沒開 API、系統偵測不到，只能在這裡教。
    await say('測試前還有一個小開關：LINE 官方帳號內建的「自動回應訊息」預設是開的，不關的話客人每句話都會收到<b>兩套回覆</b>（LINE 的罐頭訊息＋我們的回覆）。')
    card({
      kind: 'help',
      summary: '怎麼關？',
      steps: [
        '打開 LINE 官方帳號後台（下面有連結）',
        '設定 → 回應設定',
        '把「自動回應訊息」關掉（回應方式選聊天機器人／Webhook 那組）',
      ],
      href: 'https://manager.line.biz/',
      hrefLabel: '打開官方帳號後台 ↗',
    })

    // ── 見證時刻：等第一則訊息 ──
    progress.value = 2
    await say('來見證一下。拿手機<b>加你的官方帳號好友</b>，隨便傳一句話給它——我在這裡等。')
    const waitId = card({ kind: 'status', state: 'pending', text: '等待第一則訊息…' })

    let received: FirstMessageRes | null = null
    let skipped = false
    while (!received && !skipped) {
      stopPolling = false
      const polled = pollFirstMessage()
      const asked = waitAsk({ kind: 'choices', options: [{ label: '先跳過測試', value: 'skip' }] })

      const winner = await Promise.race([
        polled.then(r => ({ kind: 'received' as const, r })),
        asked.then(() => ({ kind: 'skipped' as const })),
        // 等太久不能只讓人乾等——時間到主動講常見原因、給檢查的出口
        sleep(FIRST_MSG_HINT_MS).then(() => ({ kind: 'stalled' as const })),
      ])

      if (disposed)
        return

      if (winner.kind === 'received') {
        stopPolling = true
        if (winner.r) {
          settle({ type: 'cancelled' }) // 收掉「先跳過測試」按鈕
          received = winner.r
        }
        continue
      }
      if (winner.kind === 'skipped') {
        // 使用者按了「先跳過測試」：echo 與收按鈕 onChoice 已經做掉了，這裡只收尾
        stopPolling = true
        skipped = true
        continue
      }
      // stalled：先收掉輪詢與跳過按鈕，再主動排障
      stopPolling = true
      settle({ type: 'cancelled' })
      await say('還沒等到訊息。最常見的原因有三個：① LINE Developers 那邊 Webhook URL 貼了但<b>忘了按存檔</b> ②「Use webhook」開關沒打開 ③手機加好友加到別的帳號。檢查一下，我也可以再幫你驗一次。')
      const c = await askChoices([
        { label: '幫我再驗一次 Webhook', value: 'verify', primary: true },
        { label: '檢查好了，繼續等', value: 'wait' },
        { label: '先跳過測試', value: 'skip' },
      ])
      if (c === 'skip') {
        skipped = true
        continue
      }
      if (c === 'verify') {
        const vId = card({ kind: 'status', state: 'pending', text: '正在跟 LINE 確認 Webhook…' })
        const v = await verifyWebhook(webhookUrl)
        if (v?.ok) {
          updateMsg(vId, { kind: 'status', state: 'ok', text: 'Webhook 沒問題，LINE 回應正常' })
          await say('接線是通的——再用手機傳一句話試試，我繼續等。')
        }
        else {
          updateMsg(vId, { kind: 'status', state: 'fail', text: v?.message || '檢查失敗' })
          await say('看起來就是卡在這裡——照上面的訊息調整（最常見是沒按存檔、或 <b>Use webhook</b> 開關沒開），好了之後我這邊會自動收到。')
        }
      }
      // 「繼續等」或驗完：回到迴圈重新掛上輪詢與跳過按鈕
    }

    if (received) {
      const at = received.at ? new Date(received.at) : null
      const timeLabel = at ? `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` : ''
      const title = received.messageType === 'text' && received.text
        ? `「${received.text}」`
        : '（貼圖／圖片訊息）'
      updateMsg(waitId, {
        kind: 'highlight',
        label: '收到第一則訊息',
        title,
        meta: timeLabel ? `${timeLabel} · 來自你的 LINE` : '來自你的 LINE',
      })
      await say('收到了！你的機器人正式活起來了 🎉 之後客人傳的每一句話，都會出現在後台的「對話」頁。')
      setup.firstMessageReceived = 'done'
    }
    else {
      updateMsg(waitId, { kind: 'status', state: 'skipped', text: '略過測試——之後隨時可以加好友傳一句話試試' })
      outcome.testSkipped = true
      markSkip('firstMsg')
    }
    progress.value = 3
  }

  async function pollFirstMessage(): Promise<FirstMessageRes | null> {
    while (!stopPolling && !disposed) {
      // 頁面在背景時不打（照 TutorialAgent 的既有做法），回到前景下一輪就會查
      if (document.visibilityState === 'visible') {
        try {
          const r = await apiFetch<FirstMessageRes>('/api/admin/onboarding/first-message')
          if (r.received)
            return r
        }
        catch { /* 單次失敗就等下一輪，不打斷等待 */ }
      }
      await sleep(POLL_INTERVAL_MS)
    }
    return null
  }

  async function stepAiMode(ai: AiSnapshot) {
    if (ai.enabled) {
      outcome.aiModeLabel = ai.replyMode === 'draft' ? '草稿模式' : '全自動'
      return
    }
    await say('最後把 AI 客服打開。建議先用<b>草稿模式</b>：AI 先擬好回覆、你看過再按送出，觀察幾天穩了再切全自動。')
    const c = await askChoices([
      { label: '先用草稿模式（建議）', value: 'draft', primary: true },
      { label: '直接全自動', value: 'auto' },
    ])
    const mode = c === 'auto' ? 'auto' : 'draft'
    const ok = await apiRetry(
      () => apiFetch('/api/ai/settings', { method: 'PUT', body: { enabled: true, replyMode: mode } }),
      { failText: '開啟失敗', skipLabel: '先跳過' },
    )
    if (ok !== null) {
      ai.enabled = true
      ai.replyMode = mode
      outcome.aiModeLabel = mode === 'draft' ? '草稿模式' : '全自動'
      await say(mode === 'draft'
        ? '好選擇 👍 草稿模式開好了。AI 擬的回覆會出現在「對話」頁等你送出。'
        : '全自動開好了。之後想改，「AI 設定」裡隨時能切。')
    }
    else {
      await say('先跳過。之後在「AI 設定」隨時可以打開。')
    }
  }

  async function stepShopUrl(ai: AiSnapshot) {
    if (ai.shopUrl || skips().shopUrl)
      return
    await say('你的商店網址是？客人問「多少錢」的時候，AI 會即時去查商品和價格——這是客人最常問的問題，沒填會答不出來。')
    const v = await askInput({
      inputType: 'url',
      placeholder: 'https://…',
      skippable: true,
      validate: t => /^https?:\/\/\S+$/i.test(t) ? null : '網址要以 http:// 或 https:// 開頭，直接從瀏覽器網址列複製過來最保險。',
    })
    if (v == null) {
      markSkip('shopUrl')
      await say('先跳過。之後在「AI 設定」補上就行——沒填之前，價格類問題 AI 會答不出來喔。')
      return
    }
    const ok = await apiRetry(
      () => apiFetch('/api/ai/settings', { method: 'PUT', body: { shopUrl: v } }),
      { failText: '存檔失敗', skipLabel: '先跳過' },
    )
    if (ok === null)
      markSkip('shopUrl')
    else {
      ai.shopUrl = v
      await say('存好了 ✓ 價格類問題交給 AI 沒問題了。')
    }
  }

  async function stepHandoff(ai: AiSnapshot) {
    if (ai.handoffReady || skips().handoff)
      return
    // 草稿模式＋沒設通知＝AI 擬了稿沒有任何人知道要去送——兩個「跳過」疊起來才會踩到的洞，跳過時要講
    const draftHint = ai.enabled && ai.replyMode === 'draft'
      ? '另外你選了草稿模式——AI 擬好的回覆要有人按送出才會發給客人，記得每天開「對話」頁看一眼。'
      : ''
    await say('當客人指名要找真人、或 AI 接不住的時候，要通知誰？從你官方帳號的好友裡選——收通知的人必須加了這個官方帳號好友，之後隨時能在「AI 設定」加更多人。')

    busy.value = true
    let options: AgentPickerOption[] = []
    try {
      const r = await apiFetch<{ users: { lineUserId?: string, displayName?: string, pictureUrl?: string }[] }>(
        '/api/users/list?limit=20',
      )
      options = (r.users || [])
        .map(u => ({
          id: String(u.lineUserId || '').trim(),
          label: String(u.displayName || '').trim() || '（未提供暱稱）',
          pictureUrl: String(u.pictureUrl || '').trim() || undefined,
        }))
        .filter(o => o.id)
        .slice(0, 8)
    }
    catch { /* 抓不到就走下面的空清單出口 */ }
    finally {
      busy.value = false
    }

    if (!options.length) {
      await say(`目前還抓不到好友清單（通常是還沒有人加這個官方帳號好友）。先跳過，之後在「AI 設定 → 轉真人通知」裡設定就行。${draftHint}`)
      markSkip('handoff')
      return
    }

    // 清單可能被截斷（只列最近 8 位）：先講清楚找不到人時的出路，別讓人卡在這格
    if (options.length >= 8)
      await say('下面列的是最近的好友。要通知的人不在裡面的話，先按「先跳過」——進後台到「AI 設定 → 轉真人通知」有完整的搜尋選人。')

    const picked = await askPicker(options, true)
    if (!picked) {
      markSkip('handoff')
      await say(`先跳過。提醒一下：通知沒設的話，客人要找真人時不會有人知道——之後記得在「AI 設定」補。${draftHint}`)
      return
    }
    const ok = await apiRetry(
      () => apiFetch('/api/ai/settings', {
        method: 'PUT',
        body: {
          handoffNotify: {
            enabled: true,
            lineUserIds: [picked.id],
            displayNames: { [picked.id]: picked.label },
          },
        },
      }),
      { failText: '存檔失敗', skipLabel: '先跳過' },
    )
    if (ok === null)
      markSkip('handoff')
    else {
      ai.handoffReady = true
      await say('設好了 ✓ 之後有客人要找真人，這支 LINE 會跳通知。')
    }
  }

  async function stepDone() {
    progress.value = 4
    // 摘要不用劇本自己的記憶，重新跟後端要一次真實訊號——原則：agent 只轉述，不臆測。
    // 查不到就「不出成績單」：把剛做完的事顯示成沒做，比沒有摘要嚴重得多（查不到≠沒做）。
    let setup: Partial<Record<SetupCapabilityId, SetupItemStatus>> = {}
    let ai: AiSnapshot | null = null
    while (true) {
      busy.value = true
      let checked = false
      try {
        ;[setup, ai] = await Promise.all([fetchSetup(), fetchAi()])
        checked = true
      }
      catch { /* 走下面的誠實出口 */ }
      finally {
        busy.value = false
      }
      if (checked)
        break
      await say('咦，跟伺服器要開通結果沒成功——<b>查不到不代表沒做好</b>，你剛完成的設定都已經存起來了。')
      const c = await askChoices([
        { label: '再檢查一次', value: 'retry', primary: true },
        { label: '直接進後台', value: 'exit' },
      ])
      if (c === 'exit') {
        await say('好！進後台後，右下角的小幫手會隨時告訴你哪些項目還沒完成。')
        await navigateTo(`/admin/${wid.value}/conversations`)
        return
      }
    }

    card({
      kind: 'summary',
      items: [
        { label: 'LINE 官方帳號已接通', done: setup.lineConnected === 'done' },
        {
          label: '收到第一則訊息',
          done: setup.firstMessageReceived === 'done',
          note: setup.firstMessageReceived === 'done' ? undefined : '已跳過，之後加好友傳一句話試試',
        },
        {
          label: `AI 自動回覆${ai?.enabled && outcome.aiModeLabel ? `（${outcome.aiModeLabel}）` : ''}`,
          done: ai?.enabled === true,
        },
        {
          label: 'LIFF（活動頁入口）',
          done: setup.liffReady === 'done',
          note: setup.liffReady === 'done' ? undefined : '加分項，要辦活動再補',
        },
        {
          label: '商店網址',
          done: !!ai?.shopUrl,
          note: ai?.shopUrl ? undefined : '已跳過，AI 設定裡可補',
        },
        {
          label: '轉真人通知',
          done: ai?.handoffReady === true,
          note: ai?.handoffReady ? undefined : '已跳過，AI 設定裡可補',
        },
      ],
    })
    await say('設定完成 🎉 之後把常見問題匯入<b>知識庫</b>，AI 會答得更好。')
    await say('右下角的小幫手不會消失——哪裡沒做完、哪裡怪怪的，它都會主動說，點它也能隨時找我。')
    // 落地在「對話」頁不落統計頁：新帳號 KPI 全 0，剛見證完第一則訊息就接冷場；
    // 對話頁裡就有他剛傳的那句話，敘事接得上（2026-08-12 拍板 G-11）
    const c = await askChoices([
      { label: setup.firstMessageReceived === 'done' ? '去看剛剛那則對話' : '進入後台', value: 'workspace', primary: true },
      { label: '帶我去匯入知識庫', value: 'knowledge' },
    ])
    await navigateTo(c === 'knowledge'
      ? `/admin/${wid.value}/knowledge/sources`
      : `/admin/${wid.value}/conversations`)
  }

  // ── 入口 ────────────────────────────────────────────────────

  /**
   * 開跑。continueWorkspaceId 有給 = 續走模式（從健康卡「繼續完成開通」進來），
   * 逐步自我檢查、做過的靜默跳過；沒給 = 全新開通（建 org + workspace）。
   */
  async function start(continueWorkspaceId?: string) {
    if (continueWorkspaceId) {
      wid.value = continueWorkspaceId
      busy.value = true
      let line: LineStatus
      let setup: Partial<Record<SetupCapabilityId, SetupItemStatus>>
      let ai: AiSnapshot
      try {
        ;[line, setup, ai] = await Promise.all([fetchLineStatus(), fetchSetup(), fetchAi()])
      }
      catch {
        busy.value = false
        await say('現在連不上伺服器，等一下再試一次。')
        await askChoices([{ label: '重新載入', value: 'reload', primary: true }])
        window.location.reload()
        return
      }
      busy.value = false
      await stepWelcomeBack(line, setup, ai)
      await stepToken(line)
      await stepSecret(line)
      // LIFF 是加分題，排在魔法時刻之後——別讓選填項延後高潮
      await stepWebhookAndFirstMsg(line, setup, { preVerify: true })
      await stepAiMode(ai)
      await stepLiff(line)
      await stepShopUrl(ai)
      await stepHandoff(ai)
      await stepDone()
      return
    }

    if (!(await stepWelcomeFresh()))
      return
    if (!(await stepCreate()))
      return
    await stepHasOA()
    // 全新帳號：LINE 欄位一定是空的，不用先查
    const line: LineStatus = { tokenConfigured: false, secretConfigured: false, liffConfigured: false, publicBaseUrl: '' }
    // Webhook 網址需要 publicBaseUrl，補查一次（拿不到就用瀏覽器網址）
    try {
      const s = await fetchLineStatus()
      line.publicBaseUrl = s.publicBaseUrl
    }
    catch { /* 用 window.location.origin 兜底 */ }
    const setup: Partial<Record<SetupCapabilityId, SetupItemStatus>> = {}
    const ai: AiSnapshot = { enabled: false, replyMode: 'draft', shopUrl: '', handoffReady: false }
    await stepToken(line)
    await stepSecret(line)
    // LIFF 是加分題，排在魔法時刻之後——別讓選填項延後高潮
    await stepWebhookAndFirstMsg(line, setup)
    await stepAiMode(ai)
    await stepLiff(line)
    await stepShopUrl(ai)
    await stepHandoff(ai)
    await stepDone()
  }

  function dispose() {
    disposed = true
    stopPolling = true
    resolveAsk = null
  }

  return {
    entries,
    ask,
    typing,
    busy,
    progress,
    /** 這一場對話作用中的 workspaceId（建立後才有值）；給頁面算「之後再說」的出口用 */
    activeWorkspaceId: readonly(wid),
    onChoice,
    onSubmit,
    onPick,
    onSkip,
    start,
    dispose,
  }
}
