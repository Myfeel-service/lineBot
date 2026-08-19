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

import type { AgentChoice } from '~~/shared/types/agent-messages'
import { escapeHtml } from '~~/shared/types/agent-messages'
import type { SetupCapabilityId, SetupItemStatus, SetupStatusResponse } from '~~/shared/types/setup'
import { BILLING_PLANS } from '~~/shared/billing/plans'
import { leadEndpointUrl } from '~~/shared/liff-lead-path'
import { type LineWebhookCause, diagnoseLineWebhook } from '~~/shared/line-webhook-diagnosis'
import { ONBOARDING_SHOTS } from '~/utils/onboarding-shots'
import type { AgentAskResult, AgentScriptStep } from '~/composables/useAgentScriptRunner'

/**
 * 進度條五格（2026-08-19 拍板重切）：舊版「接 LINE」一格塞四件事、佔整段八成時間，
 * 使用者做了半天進度一格都沒動。拆成拿鑰匙／接線之後，最長的那段進度會前進三次。
 * 「開 AI」同輪拍板整段移出開通引導（剛開通知識庫是空的，那時開 AI 客人問什麼都答不出來，
 * 第一印象反而是「這 AI 很笨」）——AI 由右下角小幫手的開通清單接手盯，時機到了再開。
 */
export const ONBOARDING_PROGRESS_LABELS = ['建帳號', '拿鑰匙', '接線', '傳話測試', '完成'] as const

/** 開通流程所有出口一律落「對話」頁：新帳號統計全 0，空的對話清單比空報表誠實（2026-08-12 拍板 G-11） */
export function onboardingLandingPath(workspaceId: string): string {
  return `/admin/${workspaceId}/conversations`
}

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

const POLL_INTERVAL_MS = 4000
/**
 * 等第一則訊息多久沒動靜，就主動開口排障（別讓人乾瞪著轉圈）。
 * 別調太短：拿手機、找官方帳號、加好友、打一句話，第一次做通常就要一分多鐘——
 * 45 秒實測會讓排障變成常態路徑，對一切正常的人喊「還沒等到」。
 */
const FIRST_MSG_HINT_MS = 90_000

/** Webhook 驗不過、訊息又看不出病因時的通用建議（只寫這一份，之前三處各一版已經漂掉） */
const WEBHOOK_COMMON_CAUSES = '最常見是還沒按存檔、或 <b>Use webhook</b> 開關沒打開'

/** 第一則訊息的型別 → 白話標籤；對不上的型別一律只說「收到」，不猜內容（寧可講少，不能講錯） */
const FIRST_MSG_TYPE_LABELS: Record<string, string> = {
  sticker: '貼圖',
  image: '圖片',
  video: '影片',
  audio: '語音',
  file: '檔案',
  location: '位置',
}

export function useOnboardingChat() {
  // 這個精靈自己管 workspaceId：建立流程一開始還沒有、續走模式來自 ?workspaceId=，
  // 都不在路由參數裡，所以不能用 useWorkspace() 的 route-based apiFetch。
  const wid = ref('')
  const { apiFetch, getBearer } = useWorkspaceApiFetch(() => wid.value)
  const { loadWorkspaceList, workspaceList } = useWorkspace()

  // 原語（say/ask/apiRetry/輪詢/取消）全部來自共用 runner——「帶你修好」引導劇本
  // 也吃同一顆引擎（C-31 Phase 1 抽出）。這裡只留開通情境專屬的東西：
  // 步驟劇本、真實訊號 fetch、跳過記憶、進度條。
  const { brandName } = useSiteIdentity()
  const runner = useAgentScriptRunner()
  const { entries, ask, typing, busy } = runner
  const {
    say,
    card,
    updateMsg,
    waitAsk,
    settle,
    askChoices,
    askInput,
    apiRetry,
    pollUntil,
    isDisposed,
    runSteps,
    runScript,
    onChoice,
    onSubmit,
    onPick,
    onSkip,
  } = runner
  const progress = ref(0)

  // ── 跳過記憶（純 UX，不當事實來源） ─────────────────────────

  type SkipKey = 'firstMsg' // 舊的 liff/shopUrl/handoff 鍵已隨步驟移出（殘留的 localStorage 值無害）

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

  // ── 劇本 ────────────────────────────────────────────────────

  const freePlanName = BILLING_PLANS.free.name
  const freeQuota = BILLING_PLANS.free.answeredQuota

  async function stepWelcomeFresh(): Promise<boolean> {
    progress.value = 0
    await say('嗨，我是小幫手 👋 接下來我用聊天的方式，帶你把客服機器人接上 LINE、收到第一句話，大約 8 分鐘。')
    await say('一共四步，跟上面的進度條一格一格對得上：<b>建帳號</b> → <b>拿鑰匙</b> → <b>接線</b> → <b>傳一句話測試</b>，做完就亮最後一格「完成」。隨時可以離開，下次回來我會從沒做完的地方接著帶。')
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

  async function stepWelcomeBack(line: LineStatus, setup: Partial<Record<SetupCapabilityId, SetupItemStatus>>) {
    const name = workspaceList.value.find(w => w.workspaceId === wid.value)?.name || ''
    await say(`歡迎回來${name ? `，「${escapeHtml(name)}」` : ''}！我們接著把剩下的設定做完，做過的我會直接跳過。`)
    if (!line.tokenConfigured || !line.secretConfigured)
      progress.value = 1
    else if (setup.firstMessageReceived !== 'done')
      progress.value = 2 // 鑰匙都在了 → 接線
    else
      progress.value = 3 // 都做完了停在傳話測試那格，「完成」由 stepDone 點亮
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

  /** 節點式教學的一步：一句話＋（選配）連結／示意圖／岔路 */
  interface WalkNode {
    html: string
    href?: string
    hrefLabel?: string
    image?: string
    alt?: string
    /** 岔路按鈕：走完岔路回到同一步（例：清單裡沒看到帳號） */
    detour?: { label: string, run: () => Promise<void> }
  }

  /**
   * 節點式教學（2026-08-19 老闆拍板）：一次只亮一步、按「下一步」前進，
   * 一步一張大圖不用為卡片長度縮圖。⛔跟先前否決的「問好了嗎」不同——
   * 這裡不假裝驗證任何事，只是使用者自己控節奏的翻頁；每一步都留「直接貼上」的出口，
   * 會的人不用被牽著走完。
   */
  async function walkNodes(nodes: WalkNode[], exitLabel: string) {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!
      const isLast = i === nodes.length - 1
      // 單節點不標步數（「1/1」很傻）；多節點用小徽章標，別用粗體＋直線硬拼
      const stepno = nodes.length > 1 ? `<span class="agm-stepno">${i + 1} / ${nodes.length}</span>` : ''
      await say(`${stepno}${n.html}`)
      // 連結卡模板會自己補「 ↗」，字樣裡不能再帶（會變雙箭頭）
      if (n.href)
        card({ kind: 'link', label: (n.hrefLabel || '打開連結').replace(/\s*↗\s*$/, ''), href: n.href })
      if (n.image)
        card({ kind: 'image', src: n.image, alt: n.alt || '' })
      // 最後一步不再多一顆確認鈕（2026-08-19 老闆實測嫌多）：內容亮完直接返回，
      // 由呼叫端接手——貼鑰匙的直接亮輸入格、接線的直接回「幫我檢查」選單
      if (isLast)
        return
      while (true) {
        const options: AgentChoice[] = [{ label: '下一步', value: 'next', primary: true }]
        if (n.detour)
          options.push({ label: n.detour.label, value: 'detour' })
        options.push({ label: exitLabel, value: 'exit' })
        const c = await askChoices(options)
        if (c === 'detour' && n.detour) {
          await n.detour.run()
          continue // 岔路走完回到同一步，繼續問「下一步」
        }
        if (c === 'exit')
          return
        break
      }
    }
  }

  async function stepToken(line: LineStatus) {
    if (line.tokenConfigured)
      return
    await say('接下來要從 LINE 拿兩把鑰匙，都在 <b>LINE Developers</b> 後台。第一把：<b>Channel Access Token</b>——機器人要靠它替你傳訊息。')
    const how = await askChoices([
      { label: '教我一步步拿', value: 'walk', primary: true },
      { label: '我會拿，直接貼上', value: 'paste' },
    ])
    let taught = how === 'walk'
    if (taught)
      await walkTokenNodes()
    // 教學走完（或選直接貼）就亮輸入格；輸入格的後門「我想看教學」按了直接切教學，
    // 不再回選單繞一圈（2026-08-19 老闆實測：回選單要多按一次，泡泡疊一排很吵）
    while (!line.tokenConfigured) {
      const ok = await askAndSaveToken(line, { escapeLabel: taught ? '再看一次教學' : '等等，我想看教學' })
      if (!ok && !line.tokenConfigured) {
        taught = true
        await walkTokenNodes()
      }
    }
  }

  /** 拿第一把鑰匙的節點式教學（stepToken 可能重複進出，抽出來） */
  async function walkTokenNodes() {
    await walkNodes([
        {
          // 登入方式刻意不指定：不是每個人都用 LINE 帳號（也可能用電子郵件的商用帳號）
          html: '打開 LINE Developers 並登入——用你平常的方式登入就可以（第一次通常選「LINE帳號」）。',
          href: 'https://developers.line.biz/console/',
          hrefLabel: '打開 LINE Developers ↗',
        },
        {
          // 真實畫面查證過的陷阱：同一個帳號會有兩張同名卡（Messaging API／LINE Login），
          // 靠名字選五五開會選錯——選錯的下場是拿到另一把不能用的鑰匙
          html: '選你的官方帳號。<b>同名卡片可能有兩張</b>——認卡片下面掛著「Messaging API」小字的那張，點進去。',
          image: ONBOARDING_SHOTS.consoleChannelAnim,
          alt: '循環動畫：帳號清單頁，聚焦卡片下方的 Messaging API 小字',
          detour: {
            label: '清單裡沒看到我的帳號？',
            run: async () => {
              await say('那是還沒啟用的關係。到官方帳號後台的「設定 → Messaging API」按<b>啟用</b>，它才會出現在剛剛的清單裡。弄好回來按「下一步」繼續。')
              card({ kind: 'link', label: '打開官方帳號後台', href: 'https://manager.line.biz/' })
              card({ kind: 'image', src: ONBOARDING_SHOTS.oamEnableMessagingApi, alt: '官方帳號後台的設定頁，圈出 Messaging API 的啟用按鈕' })
            },
          },
        },
        {
          // 老闆拍板：切分頁→捲到底→發鑰匙→複製是一氣呵成的動作，合成一節點配循環動畫
          html: '照下面的動畫做：切到「<b>Messaging API</b>」分頁 → 捲到最下面 → Channel access token 按「<b>Issue</b>」發一把 → 按<b>複製</b>圖示整串複製。',
          image: ONBOARDING_SHOTS.getTokenAnim,
          alt: '循環動畫：切到 Messaging API 分頁、捲到最下方、按 Issue 發鑰匙、按複製',
        },
      ], '我拿到了，直接貼上')
  }

  async function stepSecret(line: LineStatus) {
    if (line.secretConfigured)
      return
    await say('第二把：<b>Channel Secret</b>——用來確認訊息真的來自 LINE、不是別人假冒的。')
    let taught = false
    // 選單只出現一次；「回上一步」是剛存完第一把就發現貼錯（例如回顯的帳號名不對）的回頭路——
    // 過了這個窗口，接線檢查會用真訊號診斷出是哪把鑰匙錯、並給重貼入口
    while (!line.secretConfigured && !taught) {
      const how = await askChoices([
        { label: '教我怎麼拿', value: 'walk', primary: true },
        { label: '我會拿，直接貼上', value: 'paste' },
        { label: '回上一步：重貼第一把', value: 'redo-token' },
      ])
      if (how === 'redo-token') {
        // 回頭換第一把也要有教學可看（2026-08-19 老闆回饋）——貼錯的人多半正是不熟流程的人
        const r = await askChoices([
          { label: '直接貼新的第一把', value: 'paste', primary: true },
          { label: '重看第一把的教學', value: 'walk' },
          { label: '不換了，回第二把', value: 'back' },
        ])
        if (r === 'back')
          continue
        if (r === 'walk')
          await walkTokenNodes()
        if (await askAndSaveToken(line, { escapeLabel: '不換了，回來貼第二把' }))
          await say('第一把換好了 ✓ 回到第二把。')
        continue
      }
      if (how === 'walk') {
        taught = true
        await walkSecretNodes()
      }
      break
    }
    while (!line.secretConfigured) {
      const ok = await askAndSaveSecret(line, { escapeLabel: taught ? '再看一次教學' : '等等，我想看教學' })
      if (!ok && !line.secretConfigured) {
        taught = true
        await walkSecretNodes()
      }
    }
    await say('好了 ✓ 兩把鑰匙都到手，剩最後一步接線。')
  }

  /** 拿第二把鑰匙的教學：動畫從分頁帶到目標列——緊裁的列圖缺「從哪裡來」的定位 */
  async function walkSecretNodes() {
    await walkNodes([
      {
        html: '同一個後台，照下面的動畫做：切到「<b>Basic settings</b>」分頁 → 捲下來找到 <b>Channel secret</b> → 整串複製過來。',
        href: 'https://developers.line.biz/console/',
        hrefLabel: '打開 LINE Developers ↗',
        image: ONBOARDING_SHOTS.channelSecretAnim,
        alt: '循環動畫：切到 Basic settings 分頁、捲到 Channel secret 那一列',
      },
    ], '')
  }

  /**
   * 問 LINE「Webhook 接好了沒」，回 {ok, message}；查不到（自己 API 掛）回 null（查不到≠沒接好）。
   * 走唯讀的 line-webhook-verify，不走 PUT line-workspace：那支每按一次都會寫一次 workspace doc
   * ＋清掉「全租戶」的憑證快取——卡住的人連按幾次驗證，會害所有租戶的 webhook 熱路徑重讀整批資料。
   */
  async function verifyWebhook(webhookUrl: string): Promise<{ cause: LineWebhookCause, message: string } | null> {
    busy.value = true
    try {
      const r = await apiFetch<{
        getOk: boolean
        getStatus?: number
        getMessage?: string
        lineActive: boolean | null
        urlMatchesCompare: boolean | null
        endpointUnreachable: boolean | null
        test: { success: boolean, reason?: string, statusCode?: number | null } | null
        testSkipped: boolean
        testError?: string
      }>('/api/admin/line-webhook-verify', {
        method: 'POST',
        body: { compareUrl: webhookUrl },
      })
      // 病因判讀走 shared/line-webhook-diagnosis（設定頁徽章吃同一份）——
      // 這裡曾經自己用 /HTTP 401/ 比對訊息字串，把「LINE 不認得我們的 Token」和
      // 「我們把 LINE 的測試訊息擋掉（Channel Secret 對不上）」判成同一種病，
      // 結果是叫人去重貼一把根本沒壞的鑰匙，重貼完再驗還是同一句話
      const v = diagnoseLineWebhook(r)
      return { cause: v.cause, message: v.badge }
    }
    catch (e: unknown) {
      // 唯一能下定論的失敗：後端明說缺 Channel Access Token（400）。
      // 其他（網路斷、500、token 過期）一律回 null＝查不到，不能拿來當診斷
      const msg = String((e as { data?: { statusMessage?: string } })?.data?.statusMessage || '')
      if (msg.includes('Channel Access Token'))
        return { cause: 'token', message: msg }
      return null
    }
    finally {
      busy.value = false
    }
  }

  /**
   * 問 LINE：這把 Channel Access Token 是真的嗎、是誰的？（免費，不佔 webhook 測試次數）
   * 問不到回 null——不能因為我們自己連不出去，就說人家的鑰匙是壞的。
   */
  async function checkToken(token: string): Promise<{ valid: boolean | null, displayName?: string } | null> {
    busy.value = true
    try {
      return await apiFetch<{ valid: boolean | null, displayName?: string }>('/api/admin/line-token-check', {
        method: 'POST',
        body: { channelAccessToken: token },
      })
    }
    catch {
      return null
    }
    finally {
      busy.value = false
    }
  }

  /**
   * 收第一把鑰匙：貼上 → **先問 LINE 這把是真的嗎** → 才存檔。
   *
   * 原本只擋「字串太短」，所以貼到別家帳號的鑰匙、或已經在 LINE 後台被重發作廢的舊鑰匙，
   * 都會被回「收到 ✓ 已經幫你存好」，一路到兩步之後的接線檢查才爆——那時人早就不會
   * 聯想到是鑰匙的問題。驗過的還會回顯帳號名，「貼成另一個官方帳號」也當場看得出來。
   */
  async function askAndSaveToken(line: LineStatus, opts: { escapeLabel?: string } = {}): Promise<boolean> {
    while (true) {
      const v = await askInput({
        inputType: 'secret',
        placeholder: '貼上 Channel Access Token',
        // 後門：一開始選「直接貼上」的人，對話裡沒有教學也叫不出來——輸入格不能是死路
        skippable: !!opts.escapeLabel,
        skipLabel: opts.escapeLabel,
        validate: t => t.length < 20 ? '這串看起來太短了，Channel Access Token 是很長的一串，請整串複製過來。' : null,
      })
      if (v == null)
        return false
      const check = await checkToken(v)
      if (check?.valid === false) {
        await say('這把鑰匙 LINE 不認得 ⛔ 常見兩種原因：①複製時漏頭漏尾（要<b>整串</b>）②在 LINE 後台按過重發，舊的那把當場失效。回 Messaging API 分頁重新複製一次，再貼上來。')
        continue
      }
      const ok = await apiRetry(
        () => apiFetch('/api/admin/line-workspace', { method: 'PUT', body: { channelAccessToken: v } }),
        { failText: '存檔失敗' },
      )
      if (ok === null)
        continue
      line.tokenConfigured = true
      // 問不到（check 是 null，或 valid 是 null）就只說存好了——不假裝驗過
      if (check?.valid === true && check.displayName)
        await say(`收到 ✓ 這把鑰匙是「<b>${escapeHtml(check.displayName)}</b>」的，已經幫你存好。`)
      else
        await say('收到 ✓ 已經幫你存好。')
      return true
    }
  }

  /** 收第二把鑰匙。⚠️這把沒辦法單獨驗真假（LINE 沒有這種 API），只能靠接線測試才驗得出來 */
  async function askAndSaveSecret(line: LineStatus, opts: { escapeLabel?: string } = {}): Promise<boolean> {
    while (true) {
      const v = await askInput({
        inputType: 'secret',
        placeholder: '貼上 Channel Secret',
        skippable: !!opts.escapeLabel,
        skipLabel: opts.escapeLabel,
        validate: t => t.length < 10 ? '這串看起來太短了，請到 Basic settings 分頁整串複製 Channel secret。' : null,
      })
      if (v == null)
        return false
      const ok = await apiRetry(
        () => apiFetch('/api/admin/line-workspace', { method: 'PUT', body: { channelSecret: v } }),
        { failText: '存檔失敗' },
      )
      if (ok !== null) {
        line.secretConfigured = true
        return true
      }
    }
  }

  /** Webhook 檢查判定是「LINE 不認得我們的 Token」時的出口：讓人當場重貼第一把鑰匙 */
  async function reenterToken(line: LineStatus) {
    await say('好，把新的 <b>Channel Access Token</b> 整串貼上來（LINE Developers → Messaging API 最下方按重發，可以拿一把新的）。')
    if (await askAndSaveToken(line, { escapeLabel: '先不換了' }))
      await say('再檢查一次看看。')
    else
      await say('好，先不換。想換的時候再按一次檢查就行。')
  }

  /**
   * 判定是「我們自己把 LINE 的測試訊息擋掉」時的出口：重貼第二把鑰匙。
   * 這條路以前不存在——同一個 401 被當成 Token 的問題，人被指去重貼一把根本沒壞的鑰匙。
   */
  async function reenterSecret(line: LineStatus) {
    await say('好，回 LINE Developers 的 <b>Basic settings</b> 分頁，把 <b>Channel secret</b> 整串重新複製一次貼上來。')
    card({
      kind: 'help',
      summary: '在哪裡？',
      steps: [
        {
          text: '照動畫做：切到 Basic settings 分頁，捲下來找到 Channel secret，整串複製過來',
          image: ONBOARDING_SHOTS.channelSecretAnim,
          alt: '循環動畫：切到 Basic settings 分頁、捲到 Channel secret 那一列',
        },
      ],
      href: 'https://developers.line.biz/console/',
      hrefLabel: '打開 LINE Developers ↗',
    })
    if (await askAndSaveSecret(line, { escapeLabel: '先不換了' }))
      await say('換好了 ✓ 再檢查一次看看。')
    else
      await say('好，先不換。想換的時候再按一次檢查就行。')
  }

  /**
   * 驗一次 Webhook 並把結果講清楚：出檢查卡 → 驗 → 依真實錯誤分診建議。
   * 主迴圈跟 90 秒排障共用這一份——之前排障那份自己重寫，掉了「401→重貼 Token」的出口，
   * Token 貼錯又略過前面檢查的人會被指去查一個不是病因的地方，唯一能按的只剩跳過。
   */
  async function verifyAndAdvise(webhookUrl: string, line: LineStatus): Promise<'ok' | 'fail' | 'unknown'> {
    const cardId = card({ kind: 'status', state: 'pending', text: '正在跟 LINE 確認 Webhook…' })
    const v = await verifyWebhook(webhookUrl)
    if (v?.cause === 'ok') {
      updateMsg(cardId, { kind: 'status', state: 'ok', text: 'Webhook 已接通，LINE 回應正常' })
      return 'ok'
    }
    if (v == null || v.cause === 'unknown') {
      // 問不到就不能對 Webhook 下結論——查不到≠沒接好，別把非答案講成確診
      updateMsg(cardId, { kind: 'status', state: 'skipped', text: '這次沒檢查成功（不代表 Webhook 有問題）' })
      await say('剛剛沒問到結果，這<b>不代表</b> Webhook 有問題——等一下再驗一次就好。')
      return 'unknown'
    }
    updateMsg(cardId, { kind: 'status', state: 'fail', text: v.message || '檢查失敗' })
    // 依真實病因分流——別叫使用者去改一個沒壞的東西。
    // 兩種 401 一定要分開講：LINE 不認得我們的鑰匙（第一把）vs 我們把 LINE 擋掉（第二把）
    switch (v.cause) {
      case 'token': {
        await say('LINE <b>不認得我們手上的鑰匙</b>——就是第一把（Channel Access Token），多半是在 LINE 後台被重新發過一次，舊的當場失效。要重貼一把新的嗎？')
        const r = await askChoices([
          { label: '重貼第一把鑰匙', value: 'retoken', primary: true },
          { label: '我再檢查看看', value: 'later' },
        ])
        if (r === 'retoken')
          await reenterToken(line)
        break
      }
      case 'signature': {
        await say('好消息是 LINE <b>有把訊息送過來</b>，但被我們自己擋掉了：第二把鑰匙（<b>Channel Secret</b>）跟 LINE 後台不是同一組，訊息會被當成假冒的丟掉。要重貼一次嗎？')
        const r = await askChoices([
          { label: '重貼第二把鑰匙', value: 'resecret', primary: true },
          { label: '我再檢查看看', value: 'later' },
        ])
        if (r === 'resecret')
          await reenterSecret(line)
        break
      }
      case 'nourl':
        await say('LINE 後台<b>還沒收到這串網址</b>——通常是貼了但沒按 Update 存檔。再貼一次、存檔，好了再驗一次。')
        break
      case 'inactive':
        await say('網址有了，剩「<b>Use webhook</b>」開關沒打開——就在網址欄位下面。開了再驗一次。')
        break
      case 'mismatch':
      case 'mismatchDead':
        await say('LINE 後台填的網址跟上面那串不一樣——再複製一次、<b>整串</b>蓋掉貼上並存檔，好了再驗一次。')
        break
      default:
        await say(`照上面的訊息調整一下（${WEBHOOK_COMMON_CAUSES}），好了再驗一次。`)
    }
    return 'fail'
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
    // 上次明確按過「先跳過測試」的人回來，不重坐一次教學＋等待——
    // 跟 liff/shopUrl/handoff 同一套跳過記憶；之後由健康卡盯（那邊才是事實來源）
    if (skips().firstMsg) {
      progress.value = Math.max(progress.value, 3)
      return
    }

    // ── 接線：Webhook ──
    // 進場那次 publicBaseUrl 查詢失敗會被吞掉：教網址前補查一次，
    // 直接兜瀏覽器網址會教錯（正式網址有設的人幾分鐘後就被健康檢查亮紅）
    if (!line.publicBaseUrl) {
      try {
        line.publicBaseUrl = (await fetchLineStatus()).publicBaseUrl
      }
      catch { /* 真的拿不到才退回瀏覽器網址 */ }
    }
    const webhookUrl = `${line.publicBaseUrl || window.location.origin}/webhook`
    progress.value = Math.max(progress.value, 2) // 鑰匙到手，進「接線」格
    let verified = false

    // 續走模式先靜默驗一次：之前就接好 Webhook 的人不用再被叫去貼一次網址
    if (opts.preVerify && line.tokenConfigured && line.secretConfigured) {
      const v = await verifyWebhook(webhookUrl)
      if (v?.cause === 'ok') {
        await say('Webhook 之前就接好了 ✓ 直接來測試。')
        verified = true
      }
    }

    if (!verified) {
      await say('最後一步接線：把下面這串網址交給 LINE，客人的訊息才知道要送到哪裡。')
      card({ kind: 'copy', label: '你的 Webhook 網址', value: webhookUrl })
    }

    let taught = false
    while (!verified) {
      const c = await askChoices([
        { label: taught ? '再看一次教學' : '教我一步步貼', value: 'walk', primary: !taught },
        { label: '貼好了，幫我檢查', value: 'check', primary: taught },
        { label: '略過檢查，直接測試', value: 'skip' },
      ])
      if (c === 'walk') {
        taught = true
        await walkNodes([
          {
            html: '先按上面那張卡的「複製」拿到網址，然後打開 LINE Developers。',
            href: 'https://developers.line.biz/console/',
            hrefLabel: '打開 LINE Developers ↗',
          },
          {
            // 選對卡的前導放進動畫裡——同名雙卡是最大雷點，教學開頭就要處理
            html: '照動畫做：選掛「<b>Messaging API</b>」小字的那張卡 → 切到 <b>Messaging API</b> 分頁 → Webhook URL 按「<b>Edit</b>」打開輸入格 → 貼上網址按「<b>Update</b>」存檔 → 打開「<b>Use webhook</b>」開關。做完回來按「貼好了，幫我檢查」。',
            image: ONBOARDING_SHOTS.webhookAnim,
            alt: '循環動畫：選 Messaging API 卡、切分頁、貼 Webhook 網址、開 Use webhook',
          },
        ], '我貼好了，直接檢查')
        // 教學走完不自動驗（人可能還在 LINE 那邊操作），回選單時「幫我檢查」已是主鈕
        continue
      }
      if (c === 'skip')
        break
      const res = await verifyAndAdvise(webhookUrl, line)
      if (res === 'ok') {
        await say('接線完成！你的官方帳號已經連上系統了。')
        verified = true
      }
    }

    // LINE 內建「自動回應訊息」預設開啟，會跟機器人搶話（客人每句話收到兩套回覆）。
    // 這個開關 LINE 沒開 API、系統偵測不到，只能在這裡教。
    await say('測試前還有一個小開關：LINE 官方帳號內建的「自動回應訊息」預設是開的，不關的話客人每句話都會收到<b>兩套回覆</b>（LINE 的罐頭訊息＋我們的回覆）。')
    const howOff = await askChoices([
      { label: '教我一步步關', value: 'walk', primary: true },
      { label: '我會關，直接測試', value: 'skip' },
    ])
    if (howOff === 'walk') {
      await walkNodes([
        {
          html: '打開 <b>LINE 官方帳號後台</b>——注意，這是<b>另一個後台</b>，跟剛剛拿鑰匙那個不一樣。',
          href: 'https://manager.line.biz/',
          hrefLabel: '打開官方帳號後台 ↗',
        },
        {
          // 2026-08-19 對實際畫面校正過：新版介面沒有「聊天機器人」那組選項了，
          // 正確操作是回應方式選「手動聊天」——照舊講法找「聊天機器人」的人會找不到
          html: '照動畫做：點右上角「<b>設定</b>」→ 左邊選「<b>回應設定</b>」→「聊天的回應方式」裡選「<b>手動聊天</b>」（不要選「手動聊天＋自動回應訊息」）。',
          image: ONBOARDING_SHOTS.oamAutoReplyAnim,
          alt: '循環動畫：右上設定、側欄回應設定、選手動聊天',
        },
      ], '我會關，直接測試')
    }

    // ── 見證時刻：等第一則訊息 ──
    progress.value = 3
    await say('來見證一下。拿手機<b>加你的官方帳號好友</b>，隨便傳一句話給它——我在這裡等。')
    const waitId = card({ kind: 'status', state: 'pending', text: '等待第一則訊息…' })

    // 輪詢整段等待只開這一支：排障選單開著、驗 Webhook 期間都照樣在聽，
    // 訊息一到下一輪 race 就接走——「我在這裡等」必須是真的。
    // （之前排障選單一開輪詢就全停，訊息真的來了還在對人喊「還沒等到」）
    const poll = pollFirstMessage()
    const polled = poll.promise.then(r => ({ kind: 'received' as const, r }))

    // 等太久不能只讓人乾等——時間到主動講常見原因、給檢查的出口（只提醒一次，計時器記得清）
    let hintTimer: ReturnType<typeof setTimeout> | undefined
    const stalledHint = new Promise<{ kind: 'stalled' }>((r) => {
      hintTimer = setTimeout(() => r({ kind: 'stalled' }), FIRST_MSG_HINT_MS)
    })
    let hintPending = true

    const waitOptions: AgentChoice[] = [{ label: '先跳過測試', value: 'skip' }]
    const stallOptions: AgentChoice[] = [
      { label: '幫我再驗一次 Webhook', value: 'verify', primary: true },
      { label: '檢查好了，繼續等', value: 'wait' },
      { label: '先跳過測試', value: 'skip' },
    ]
    let askOptions = waitOptions

    let received: FirstMessageRes | null = null
    while (true) {
      // 使用者的回答另存一份：race 被計時器搶贏的那一刻人可能剛好按了按鈕，
      // 只看 race 結果會把人家剛說的話整個無視掉。
      // （讀取走 answer()：TS 的流程分析看不到 closure 裡的賦值，直接讀會被窄化成 null）
      let answered: AgentAskResult | null = null
      const answer = () => answered
      const asked = waitAsk({ kind: 'choices', options: askOptions })
      // dispose 時 waitAsk 會 reject（取消例外）：這裡接住當成「answered」，
      // 下一行的 isDisposed() 檢查會直接 break——別讓它變成 unhandled rejection
      void asked.then((r) => { answered = r }).catch(() => {})

      const arms: Promise<{ kind: 'received', r: FirstMessageRes | null } | { kind: 'answered' } | { kind: 'stalled' }>[] = [
        polled,
        asked.then(() => ({ kind: 'answered' as const }), () => ({ kind: 'answered' as const })),
      ]
      if (hintPending)
        arms.push(stalledHint)
      const winner = await Promise.race(arms)

      if (isDisposed())
        break

      if (winner.kind === 'received') {
        settle({ type: 'cancelled' }) // 收掉待答按鈕
        received = winner.r
        break
      }

      if (winner.kind === 'stalled') {
        hintPending = false
        if (!answer()) {
          settle({ type: 'cancelled' })
          // ④ 是真實災情：第二把鑰匙貼錯時，訊息其實有送到、被我們自己丟掉，
          //    人在這裡乾等而三個原因沒有一個是他的病因。現在「幫我再驗一次」查得出來了
          await say('還沒等到訊息。最常見的原因有四個：① LINE Developers 那邊 Webhook URL 貼了但<b>還沒按存檔</b> ②「Use webhook」開關沒打開 ③手機加好友加到別的帳號 ④第二把鑰匙（Channel Secret）貼錯，訊息會被我們當成假冒的丟掉。按下面「幫我再驗一次」，這四種我都會幫你看——這段時間我也還在聽，訊息一進來就會告訴你。')
          askOptions = stallOptions
          continue
        }
        // 撞上使用者同一刻的點擊：往下照使用者的選擇處理
      }

      const a = answer()
      const val = a?.type === 'choice' ? a.value : ''
      if (val === 'skip')
        break
      if (val === 'verify') {
        const res = await verifyAndAdvise(webhookUrl, line)
        if (res === 'ok')
          await say('接線是通的——再用手機傳一句話試試，我繼續等。')
        askOptions = stallOptions
        continue
      }
      if (val === 'wait') {
        askOptions = waitOptions
        continue
      }
      // 其他（cancelled／不認得的值）：重掛按鈕繼續等
    }
    poll.stop() // 舊輪詢器到此必停（跳過出口時它還睡在 sleep 裡，換代後醒來就會退出）
    clearTimeout(hintTimer)
    if (isDisposed())
      return

    if (received) {
      const at = received.at ? new Date(received.at) : null
      const timeLabel = at ? `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` : ''
      const typeLabel = FIRST_MSG_TYPE_LABELS[received.messageType || '']
      // 三分法：有原文引原文；認得的非文字型別講型別；其他（客人只點了選單、
      // 原文被最近 10 則洗掉…）只說「收到」——這張卡是開通的情感高點，寧可講少，不能講錯
      const title = received.messageType === 'text' && received.text
        ? `「${received.text}」`
        : typeLabel ? `（${typeLabel}訊息）` : '（收到你的訊息）'
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
      markSkip('firstMsg')
    }
    progress.value = 3
  }

  /** 等第一則訊息：runner 的換代輪詢（背景分頁不打、單次失敗不打斷、stop／dispose 即退） */
  function pollFirstMessage() {
    return pollUntil<FirstMessageRes>(async () => {
      const r = await apiFetch<FirstMessageRes>('/api/admin/onboarding/first-message')
      return r.received ? r : null
    }, POLL_INTERVAL_MS)
  }

  async function stepDone() {
    progress.value = 4
    // 摘要不用劇本自己的記憶，重新跟後端要一次真實訊號——原則：agent 只轉述，不臆測。
    // 查不到就「不出成績單」：把剛做完的事顯示成沒做，比沒有摘要嚴重得多（查不到≠沒做）。
    let setup: Partial<Record<SetupCapabilityId, SetupItemStatus>> = {}
    while (true) {
      busy.value = true
      let checked = false
      try {
        setup = await fetchSetup()
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
        await navigateTo(onboardingLandingPath(wid.value))
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
      ],
    })
    // 結尾刻意一個字都不提知識庫／AI（2026-08-19 拍板二修：AI 的事完全不進開通，
    // 連結尾指路也不要）——接下來要做什麼，由右下角小幫手的清單接手盯
    await say('接通完成 🎉 接下來交給右下角的<b>小幫手</b>——下一步要做什麼、哪裡怪怪的，它都會主動說，點它隨時找得到我。')
    // 落地在「對話」頁不落統計頁：新帳號 KPI 全 0，剛見證完第一則訊息就接冷場；
    // 對話頁裡就有他剛傳的那句話，敘事接得上（2026-08-12 拍板 G-11，路徑見 onboardingLandingPath）
    const c = await askChoices([
      { label: setup.firstMessageReceived === 'done' ? '去看剛剛那則對話' : `開始設定 ${brandName}`, value: 'workspace', primary: true },
      // 設錯了不能卡死（2026-08-19 老闆抓到）：給回頭修的路——設定頁進場會實跑一次連線檢查，
      // 各欄位旁還有「教我怎麼拿」求救鈕
      { label: '好像有設定錯？幫我檢查', value: 'check' },
    ])
    await navigateTo(c === 'check'
      ? `/admin/${wid.value}/settings/organization?verify=webhook`
      : onboardingLandingPath(wid.value))
  }

  // ── 入口 ────────────────────────────────────────────────────

  interface MainFlowCtx {
    line: LineStatus
    setup: Partial<Record<SetupCapabilityId, SetupItemStatus>>
    preVerify?: boolean
  }

  /**
   * 主線步驟順序的單一來源：新建與續走共用同一份（之前 start() 內重複兩份，
   * 加一步要改兩個地方）。guard 不放在表上——每步開頭本來就用後端真實訊號
   * 自我檢查、已完成就靜默跳過（resume 機制），這張表只管「順序」。
   */
  // 2026-08-19 拍板：開 AI／LIFF／商店網址／轉真人通知整批移出開通引導——
  // 剛開通知識庫是空的，那時開 AI 只會答不出來；這些全由右下角小幫手的開通清單接手盯
  const MAIN_FLOW: AgentScriptStep<MainFlowCtx>[] = [
    { id: 'token', run: c => stepToken(c.line) },
    { id: 'secret', run: c => stepSecret(c.line) },
    { id: 'webhook-first-message', run: c => stepWebhookAndFirstMsg(c.line, c.setup, { preVerify: c.preVerify }) },
    { id: 'done', run: () => stepDone() },
  ]

  /**
   * 開跑。continueWorkspaceId 有給 = 續走模式（從健康卡「繼續完成開通」進來），
   * 逐步自我檢查、做過的靜默跳過；沒給 = 全新開通（建 org + workspace）。
   * 整段包在 runScript 裡：離頁 dispose 後劇本鏈就地停下（G-14），取消靜默收掉。
   */
  async function start(continueWorkspaceId?: string) {
    await runScript(async () => {
      if (continueWorkspaceId) {
        wid.value = continueWorkspaceId
        busy.value = true
        let line: LineStatus
        let setup: Partial<Record<SetupCapabilityId, SetupItemStatus>>
        try {
          ;[line, setup] = await Promise.all([fetchLineStatus(), fetchSetup()])
        }
        catch {
          busy.value = false
          await say('現在連不上伺服器，等一下再試一次。')
          await askChoices([{ label: '重新載入', value: 'reload', primary: true }])
          window.location.reload()
          return
        }
        busy.value = false
        await stepWelcomeBack(line, setup)
        await runSteps(MAIN_FLOW, { line, setup, preVerify: true })
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
      await runSteps(MAIN_FLOW, { line, setup })
    })
  }

  function dispose() {
    runner.dispose()
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
