/**
 * 開通引導對話 agent：劇本狀態機（零 LLM）。
 *
 * 設計釘死（docs/ONBOARDING-CHAT-DESIGN-20260807.md）：
 * - 對話感來自 UI 節奏，不來自模型——整段流程是寫死的劇本，永遠不會「說你設好了但其實沒有」。
 * - 每一步「完成了沒」由後端真實訊號判定（setup-status / line-workspace / ai settings），
 *   劇本只轉述；續走（resume）= 逐步自我檢查「已完成就靜默跳過」，不存「進行到第幾步」。
 * - 憑證只在這裡收、走既有 PUT 端點（admin 權限），不落 log、不進 LLM。
 * - 每一步可跳過，但只作用當下這一輪（⛔跳過記憶已拆：它跟「沒做完每次都拉回」互相打架）。
 */

import type { AgentChoice } from '~~/shared/types/agent-messages'
import { escapeHtml } from '~~/shared/types/agent-messages'
import type { SetupCapabilityId, SetupItemStatus, SetupStatusResponse } from '~~/shared/types/setup'
import { BILLING_PLANS } from '~~/shared/billing/plans'
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
  /** 「要加哪個帳號」那張卡出過了沒——傳話測試可以從成績單再進來一次，卡不要重複出 */
  let oaInviteShown = false

  // 「跳過記憶」已整組拆除（2026-08-20）：它跟「開通沒做完每次進後台都拉回」的拍板
  // 直接打架——系統一邊說你有事沒做完把人拉進來，一邊又用舊記憶把人快轉到完成頁。
  // 現在跳過只作用當下這一輪；回來就停在沒做完的那一步，照樣可以再跳過。

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
      { label: '我想先自己逛逛', value: 'browse', escape: true },
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
    // 2026-08-28 拍板：不加第三顆「不確定」鈕，改成當場點得到的連結——按鈕要多繞一趟才拿到答案。
    // ⛔ 第二句不能省：帳號多半是老闆／前同事用**他的** LINE 申請的，自己登入看到空列表就會
    //    再建一個新帳號，好友得從頭加，代價比走錯流程大得多。
    await say('不確定的話，<a href="https://manager.line.biz/" target="_blank" rel="noopener">打開官方帳號後台看一眼 ↗</a>——列表裡有帳號就是有。如果是同事或老闆申請的，要用<b>他的</b> LINE 登入才看得到，先問一聲比較快。')
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
  async function walkNodes(nodes: WalkNode[], exitLabel: string): Promise<'done' | 'exit'> {
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
        return 'done'
      while (true) {
        const options: AgentChoice[] = [{ label: '下一步', value: 'next', primary: true }]
        if (n.detour)
          options.push({ label: n.detour.label, value: 'detour' })
        options.push({ label: exitLabel, value: 'exit', escape: true })
        const c = await askChoices(options)
        if (c === 'detour' && n.detour) {
          await n.detour.run()
          continue // 岔路走完回到同一步，繼續問「下一步」
        }
        if (c === 'exit')
          return 'exit'
        break
      }
    }
    return 'done'
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
        if (await redoKeyFlow(line, 'token', '不換了，回來貼第二把'))
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


  /**
   * 見證時刻：等第一則訊息（含 90 秒排障、驗 webhook、改前面的設定）。
   * 抽成獨立段落是為了可重入——結尾成績單的「回去做傳話測試」要能直接跳回這裡
   *（2026-08-20 老闆抓到：最需要上一步的正是結尾那頁，之前只有中途選單能回頭）。
   */
  async function stepFirstMessageWait(
    line: LineStatus,
    setup: Partial<Record<SetupCapabilityId, SetupItemStatus>>,
    webhookUrl: string,
    opts: { offerVerifyUpfront?: boolean } = {},
  ) {
    progress.value = 3
    await say('來見證一下。拿手機<b>加你的官方帳號好友</b>，隨便傳一句話給它——我在這裡等。')
    const waitId = card({ kind: 'status', state: 'pending', text: '等待第一則訊息…' })

    // 輪詢整段等待只開這一支：排障選單開著、驗 Webhook 期間都照樣在聽，
    // 訊息一到下一輪 race 就接走——「我在這裡等」必須是真的。
    // （之前排障選單一開輪詢就全停，訊息真的來了還在對人喊「還沒等到」）
    const poll = pollFirstMessage()

    // 「加好友」要說得出**加哪一個**：剛開通的帳號零好友，只講一句「加你的官方帳號」
    // 等於沒講。查不到就維持上面那句純文字，不要生半殘的卡。
    //
    // ⛔ 這張卡**不可以 await 在等待卡與輪詢之前**（2026-08-28 code review 抓到）：
    // 它要去問 LINE 拿官方帳號代號，那支請求沒有逾時。LINE 慢的時候「等待第一則訊息…」
    // 還沒畫、輪詢也還沒開始——人已經被告知「我在這裡等」、照做傳了訊息，畫面卻毫無反應；
    // 請求一直不回來的話，輪詢根本不會開始。所以：先開始等，卡片自己晚點補上來。
    void showOaInvite().catch(() => {}) // 拿不到就算了，上面那句純文字仍然成立
    const polled = poll.promise.then(r => ({ kind: 'received' as const, r }))

    // 等太久不能只讓人乾等——時間到主動講常見原因、給檢查的出口（只提醒一次，計時器記得清）
    let hintTimer: ReturnType<typeof setTimeout> | undefined
    const stalledHint = new Promise<{ kind: 'stalled' }>((r) => {
      hintTimer = setTimeout(() => r({ kind: 'stalled' }), FIRST_MSG_HINT_MS)
    })
    let hintPending = true

    // 90 秒才給排障選單，是為了不讓排障變成常態路徑（見 FIRST_MSG_HINT_MS 的註解）——
    // 但那個前提是「接線已經驗過是通的」。**自己按了「略過檢查，直接測試」的人多半就是
    // 接線還沒好的那群**，讓他乾等 90 秒只是延後發現（2026-08-28 拍板：只對這群人提前給）。
    const waitOptions: AgentChoice[] = opts.offerVerifyUpfront
      ? [
          { label: '幫我再驗一次 Webhook', value: 'verify', primary: true },
          { label: '先跳過測試', value: 'skip', escape: true },
        ]
      : [{ label: '先跳過測試', value: 'skip', escape: true }]
    const stallOptions: AgentChoice[] = [
      { label: '幫我再驗一次 Webhook', value: 'verify', primary: true },
      { label: '檢查好了，繼續等', value: 'wait' },
      { label: '改前面的設定', value: 'redo' },
      { label: '先跳過測試', value: 'skip', escape: true },
    ]
    /**
     * 排障過之後選「繼續等」的安靜狀態（2026-08-28 code review 修）。
     *
     * ⛔ 不可以退回最初的 `waitOptions`：接線驗過的人那一份只有「先跳過測試」一顆，
     * 而「等太久」提示是一次性的（`hintPending` 已經 false），按下去就再也回不到排障選單——
     * 正在排障的人畫面上只剩「放棄測試」一條路。所以這一份保留兩個回頭的入口，
     * 只把「檢查好了」自己收掉，而且**一顆都不設 primary**：他剛說要安靜等，
     * 不該再有一顆填色按鈕在旁邊催。
     */
    const quietOptions: AgentChoice[] = [
      { label: '還是沒收到？再驗一次', value: 'verify' },
      { label: '改前面的設定', value: 'redo' },
      { label: '先跳過測試', value: 'skip', escape: true },
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
        // ⛔驗過就把「等太久」那份提示關掉（2026-08-28 code review 抓到）：
        // 提前給驗證出口的人（按過「略過檢查，直接測試」那群）會在 90 秒前就驗完，
        // 而那段提示列的正是「Webhook 沒存檔／開關沒開／Secret 貼錯」——
        // 剛檢查過的四件事又照本宣科念一次，還叫他按剛按過的按鈕。
        // 驗證結果本身已經把該講的話講完了（不通的話 verifyAndAdvise 會逐項指路）。
        hintPending = false
        const res = await verifyAndAdvise(webhookUrl, line)
        if (res === 'ok')
          await say('接線是通的——再用手機傳一句話試試，我繼續等。')
        askOptions = stallOptions
        continue
      }
      if (val === 'wait') {
        askOptions = quietOptions
        continue
      }
      if (val === 'redo') {
        // 重貼期間輪詢照跑（訊息一進來下一輪 race 就接走），改完回排障選單
        await offerRedo(line)
        askOptions = stallOptions
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
    }
    progress.value = 3
  }

  /**
   * 重貼某把鑰匙的統一入口（2026-08-20 拍板：回頭重做也要有教學，忘記怎麼拿的人
   * 正是最需要教的人；所有重貼入口一律同這套規則，跟主流程一致）：
   * 先問「教我一步步拿／直接貼新的／不換了」，輸入格的後門直達教學。
   * 回傳有沒有真的換（診斷路徑要靠它決定要不要說「再檢查一次」）。
   */
  async function redoKeyFlow(line: LineStatus, kind: 'token' | 'secret', cancelLabel = '不換了'): Promise<boolean> {
    const isToken = kind === 'token'
    const how = await askChoices([
      { label: '教我一步步拿', value: 'walk', primary: true },
      { label: '我會拿，直接貼新的', value: 'paste' },
      { label: cancelLabel, value: 'cancel', escape: true },
    ])
    if (how === 'cancel')
      return false
    let taught = how === 'walk'
    if (taught)
      await (isToken ? walkTokenNodes() : walkSecretNodes())
    while (true) {
      const escapeLabel = taught ? '再看一次教學' : '等等，我想看教學'
      const ok = isToken
        ? await askAndSaveToken(line, { escapeLabel })
        : await askAndSaveSecret(line, { escapeLabel })
      if (ok)
        return true
      taught = true
      await (isToken ? walkTokenNodes() : walkSecretNodes())
    }
  }

  /**
   * 「改前面的設定」：聊天中主動回頭重做（2026-08-20 拍板）。
   * 不做精靈式的每步上一步——聊天不是表單，回上一步的實際需求是「重做某個動作」。
   * 檢查失敗的自動診斷仍是主要回頭路；這裡接的是「不等檢查失敗、自己想改」的情境
   * （例：頻道雙綁時錯的 Secret 也能通過檢查，人只能主動回頭換）。改完回原地繼續。
   */
  async function offerRedo(line: LineStatus) {
    while (true) {
      const c = await askChoices([
        { label: '都不用，回來繼續', value: 'back', primary: true },
        { label: '重貼第一把鑰匙', value: 'token' },
        { label: '重貼第二把鑰匙', value: 'secret' },
      ])
      if (c === 'token' || c === 'secret') {
        await redoKeyFlow(line, c)
        continue
      }
      return
    }
  }

  /** Webhook 檢查判定是「LINE 不認得我們的 Token」時的出口：讓人當場重貼第一把鑰匙 */
  async function reenterToken(line: LineStatus) {
    if (await redoKeyFlow(line, 'token', '先不換了'))
      await say('再檢查一次看看。')
    else
      await say('好，先不換。想換的時候再按一次檢查就行。')
  }

  /**
   * 判定是「我們自己把 LINE 的測試訊息擋掉」時的出口：重貼第二把鑰匙。
   * 這條路以前不存在——同一個 401 被當成 Token 的問題，人被指去重貼一把根本沒壞的鑰匙。
   */
  async function reenterSecret(line: LineStatus) {
    if (await redoKeyFlow(line, 'secret', '先不換了'))
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
    let resumedConnected = false
    if (opts.preVerify && line.tokenConfigured && line.secretConfigured) {
      const v = await verifyWebhook(webhookUrl)
      if (v?.cause === 'ok') {
        await say('Webhook 之前就接好了 ✓ 直接來測試。')
        verified = true
        resumedConnected = true
      }
    }

    if (!verified) {
      await say('最後一步接線：把下面這串網址交給 LINE，客人的訊息才知道要送到哪裡。')
      card({ kind: 'copy', label: '你的 Webhook 網址', value: webhookUrl })
    }

    let taught = false
    while (!verified) {
      // ⛔ primary 不可以隨狀態換人（2026-08-28 code review 修）：選項鈕的排版規則是
      //    「主要動作排最後（靠右）」，所以 primary 一換人，**兩顆鈕就互換位置**。
      //    原本 walk/check 的 primary 跟著 `taught` 翻轉，實際後果是：使用者按「教我一步步貼」
      //    走完三個節點回來，接下來要按的「貼好了，幫我檢查」從第 2 顆跑到第 4 顆，
      //    而它原本的位置變成「再看一次教學」——手指停的地方剛好是他才剛做完的事。
      //    這一步真正要完成的事永遠是「貼好了，幫我檢查」，主要動作就固定給它；
      //    教學是輔助，標籤照 `taught` 換字沒問題（換字不換位置）。
      const c = await askChoices([
        { label: '貼好了，幫我檢查', value: 'check', primary: true },
        { label: taught ? '再看一次教學' : '教我一步步貼', value: 'walk' },
        { label: '略過檢查，直接測試', value: 'skip', escape: true },
        { label: '改前面的設定', value: 'redo' },
      ])
      if (c === 'redo') {
        await offerRedo(line)
        continue
      }
      if (c === 'walk') {
        taught = true
        // 2026-08-28 拍板：貼網址與開開關**拆成兩步**——這兩件事正好就是接不通時
        // 排障文案的原因①②（貼了沒按存檔／Use webhook 沒開），擠在同一步等於把最常出錯的
        // 兩件事一起唸完。⛔動圖不必重裁：第三步用現成的 webhookUrl 靜圖，它本來就是
        // 「Webhook URL 欄位①＋Use webhook 開關②」那張。
        await walkNodes([
          {
            html: '先按上面那張卡的「複製」拿到網址，然後打開 LINE Developers。',
            href: 'https://developers.line.biz/console/',
            hrefLabel: '打開 LINE Developers ↗',
          },
          {
            // 選對卡的前導放進動畫裡——同名雙卡是最大雷點，教學開頭就要處理
            html: '照動畫做：選掛「<b>Messaging API</b>」小字的那張卡 → 切到 <b>Messaging API</b> 分頁 → Webhook URL 按「<b>Edit</b>」打開輸入格 → 貼上網址 → 按「<b>Update</b>」<b>存檔</b>。<br>貼了沒按 Update 是接不通的第一名，存好再按下一步。<br>（動畫最後會順手把下面那個開關也打開——那是下一步要做的事，先做完也沒關係。）',
            image: ONBOARDING_SHOTS.webhookAnim,
            // ⚠️ alt 只描述**這一步**教的動作（2026-08-28 code review 修）：拆成兩步之後，
            // 這張動畫的最後還是會演到「開 Use webhook」——那是下一步的事。
            // 讀螢幕的人拿到的描述不能跟他正在讀的指令互相矛盾。
            // ⚠️動畫本身尚未重裁，看得見畫面的人仍會提前看到開關被打開；重裁前先把
            // 下一步的指令講在前面（見下一節點的文案），至少不會變成「做完了才被教」。
            alt: '循環動畫：選 Messaging API 卡、切到 Messaging API 分頁、把 Webhook 網址貼進去並按 Update 存檔',
          },
          {
            html: '最後把網址欄位下面的「<b>Use webhook</b>」開關<b>打開</b>。<br>這個開關沒開的話，網址貼得再對訊息也不會進來（接不通的第二名）。做完回來按「貼好了，幫我檢查」。',
            image: ONBOARDING_SHOTS.webhookUrl,
            alt: '靜態圖：Webhook URL 欄位①與 Use webhook 開關②',
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
    // 續走且接線本來就通的人不重坐這課（第一次走過時教過了；設定頁也有「教我怎麼關」）——
    // 回來的人要直接落在沒做完的傳話測試（2026-08-20 老闆抓到：不能每次回來都重演一遍）
    if (!resumedConnected) {
      await teachAutoReplyOff()
    }

    // 沒驗過就進測試（按了「略過檢查」）＝排障入口提前給，不用等 90 秒
    await stepFirstMessageWait(line, setup, webhookUrl, { offerVerifyUpfront: !verified })
  }

  /** 教關掉 LINE 內建自動回應（開通接線後的必修課；抽出來是為了續走時可跳過） */
  async function teachAutoReplyOff() {
    await say('測試前還有一個小開關：LINE 官方帳號內建的「自動回應訊息」預設是開的，不關的話客人每句話都會收到<b>兩套回覆</b>（LINE 的罐頭訊息＋我們的回覆）。')
    const howOff = await askChoices([
      { label: '教我一步步關', value: 'walk', primary: true },
      // escape：跳過類固定排最左，遠離主要鈕與拇指落點（漏標會讓它緊貼主要鈕，
      // 而兩頁前語意相同的「先跳過測試」在最左邊＝同一條流程兩種位置）
      { label: '我會關，直接測試', value: 'skip', escape: true },
    ])
    if (howOff === 'walk') {
      const how = await walkNodes([
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
      // 2026-08-28 拍板：關完先收一個確認，再叫人拿手機——這是**跨兩個後台的兩件事**，
      // 疊在一起會有人漏掉其中一件。
      // ⛔ 只在真的走完教學時擋（'exit' ＝ 他按了「我會關，直接測試」，已經表態，別再攔一次）。
      // ⚠️ 與 08-19「最後一步不再多一顆確認鈕」不衝突：那條治的是同一段教學**內部**多餘的
      //    「下一步」，這裡是兩段任務的交界。
      if (how === 'done')
        await askChoices([{ label: '關好了，來測試', value: 'ok', primary: true }])
    }
  }

  /**
   * 出「要加哪個帳號」的卡（QR＋帳號 ID＋連結）。
   * ⛔ 查不到帳號 ID 就什麼都不出——「查不到」不等於「沒有」，畫一張空 QR 比不畫更糟；
   *    這時上面那句「加你的官方帳號好友」仍然成立，只是少了捷徑。
   */
  async function showOaInvite() {
    // ⛔ 一場對話只出一張（2026-08-28 code review 修）：成績單的「回去做傳話測試」會把
    //    stepFirstMessageWait 整段再跑一次，不擋的話同一段對話裡會出現兩張一模一樣的卡。
    if (oaInviteShown)
      return
    try {
      const r = await apiFetch<{ basicId: string, addFriendUrl: string, qrDataUrl: string }>(
        '/api/admin/onboarding/oa-invite',
      )
      // ⛔ 回來時先確認這場對話還在（同一輪 review 修）：這支是 fire-and-forget，
      //    使用者可能早就離頁了。`card()` 不像 `say()` 會過 checkpoint，直接推就會寫進
      //    一個已經被 dispose 的 transcript。
      if (r?.basicId && !isDisposed()) {
        oaInviteShown = true
        card({
          kind: 'oaInvite',
          basicId: r.basicId,
          addFriendUrl: r.addFriendUrl,
          qrDataUrl: r.qrDataUrl,
        })
      }
    }
    catch {
      // 拿不到就算了：這是加分項，不該讓它擋住見證時刻
    }
  }

  /** 等第一則訊息：runner 的換代輪詢（背景分頁不打、單次失敗不打斷、stop／dispose 即退） */
  function pollFirstMessage() {
    return pollUntil<FirstMessageRes>(async () => {
      const r = await apiFetch<FirstMessageRes>('/api/admin/onboarding/first-message')
      return r.received ? r : null
    }, POLL_INTERVAL_MS)
  }

  async function stepDone(line: LineStatus) {
    // ⛔進度不可以在「確認完成」之前就跳到最後一格（2026-08-28 code review 抓到）：
    // 頁首那個「之後再說」的出口在最後一格會被藏起來，而下面這段要去問後端「真的完成了嗎」。
    // 提前跳格＝在等答案的那段時間，出口已經沒了、畫面也沒有待答按鈕；那支查詢一卡住
    // （伺服器剛醒、手機訊號不穩），人就坐在開通頁上沒有任何離開的方法。
    // 改成拿到答案（或走到誠實出口）之後才跳格——在那之前出口一直都在。
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

    // 到這裡才是真的走到最後一格（成績單即將畫出來）：頁首的出口從這一刻才收掉，
    // 而這一刻畫面上馬上就有成績單與那排「接下來做什麼」的按鈕，不會出現沒出路的空窗。
    progress.value = 4

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
    // 2026-08-28 拍板（**翻掉 08-19「結尾連指路都不要」**）：當時擋的是「催人開 AI，
    // 但那時知識庫是空的、只會答不出來」——介紹後台地圖不踩那個雷。剛做完一件事、
    // 下一步是空白，是整段旅程裡唯一「介紹不會打斷任何事」的時機。
    // ⛔ 仍然一個字都不提知識庫／AI：那些由小幫手的開通清單接手盯，這裡只給地圖。
    await say('要不要先花 <b>2 分鐘認識一下後台</b>？我帶你逛一圈，知道東西都放在哪。')
    // 這頁也要有上一步（2026-08-20 老闆抓到：成績單擺著「已跳過」卻只有離開鈕＝卡死）：
    // 跳過的測試可以當場回去做、鑰匙可以當場重貼，改完成績單會重新整理
    while (true) {
      const options: AgentChoice[] = [
        { label: '帶你認識後台（約 2 分鐘）', value: 'tour', primary: true },
        // ⛔ 這顆留著（2026-08-28 拍板）：它是這一頁唯一「不看導覽、直接進去」的出口，
        //    而且收到訊息時的說法（去看剛剛那則對話）是這一刻唯一講得對的話
        { label: setup.firstMessageReceived === 'done' ? '去看剛剛那則對話' : `開始設定 ${brandName}`, value: 'workspace' },
      ]
      if (setup.firstMessageReceived !== 'done')
        options.push({ label: '回去做傳話測試', value: 'test' })
      options.push(
        { label: '改前面的設定', value: 'redo' },
        // 設定頁進場會實跑一次連線檢查，各欄位旁還有「教我怎麼拿」求救鈕
        { label: '好像有設定錯？幫我檢查', value: 'check' },
      )
      const c = await askChoices(options)
      if (c === 'redo') {
        await offerRedo(line)
        continue
      }
      if (c === 'test') {
        const webhookUrl = `${line.publicBaseUrl || window.location.origin}/webhook`
        await stepFirstMessageWait(line, setup, webhookUrl)
        // 收到（或再次跳過）後回成績單重新整理：遞迴重跑 stepDone 會重抓真實訊號
        return stepDone(line)
      }
      if (c === 'check') {
        await navigateTo(`/admin/${wid.value}/settings/organization?verify=webhook`)
        return
      }
      if (c === 'tour') {
        // 導覽本體要高亮側欄、小幫手這些**後台版型裡的真實元素**，開通頁是 layout:false 沒有它們。
        // 所以先落地、帶 ?tour= 進去，由 TutorialAgent 掛載後接手開跑。
        await navigateTo(`${onboardingLandingPath(wid.value)}?tour=${OVERVIEW_TOPIC_ID}`)
        return
      }
      // 落地在「對話」頁不落統計頁：新帳號 KPI 全 0，剛見證完第一則訊息就接冷場；
      // 對話頁裡就有他剛傳的那句話，敘事接得上（2026-08-12 拍板 G-11）
      await navigateTo(onboardingLandingPath(wid.value))
      return
    }
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
    { id: 'done', run: c => stepDone(c.line) },
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
