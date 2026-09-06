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
 * 使用者做了半天進度一格都沒動。拆成拿鑰匙／讓訊息進來之後，最長的那段進度會前進三次。
 * 「開 AI」同輪拍板整段移出開通引導（剛開通知識庫是空的，那時開 AI 客人問什麼都答不出來，
 * 第一印象反而是「這 AI 很笨」）——AI 由右下角小幫手的開通清單接手盯，時機到了再開。
 *
 * ⚠️ 第三格 2026-09-02 從「接線」改成「讓訊息進來」：五格裡只有那格是**工程隱喻**，
 * 使用者不知道自己在接什麼線（其他四格講的都是他做的事）。改成講結果，不是講手段。
 * 改的時候要連內文一起改（劇本裡好幾句都用「接線」當主詞），別只換這一行。
 */
/**
 * ⚠️ 2026-09-06 再改一次字（老闆回饋）：「拿鑰匙」→「取得連線資訊」（比喻全面退場，見檔頭下方）、
 * 其餘三格跟著開場那句話用**同一組字**——開場說「取得連線資訊」而進度條寫「拿鑰匙」是自己打自己。
 * ⛔ 改這一行**一定要連開場白一起改**（`stepWelcomeFresh` 那句四步）。
 */
export const ONBOARDING_PROGRESS_LABELS = ['建立帳號', '取得連線資訊', '接收 LINE 訊息', '傳訊息測試', '完成'] as const

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
const WEBHOOK_COMMON_CAUSES = '最常見是網址還沒按「儲存」，或「回應設定」那頁的 <b>Webhook</b> 開關沒打開'

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
    // 2026-09-02 三件事一起改：
    // ①開場兩則併一則——人還沒做任何事就要讀兩段
    // ②拿掉「大約 8 分鐘」——這段全文 2,100 多字，光讀就超過 6 分鐘，還沒算去 LINE 後台
    //   做事的時間；第一次的人做到 20 分鐘還在拿第二把鑰匙，這個數字就從「安心」變成
    //   「我是不是很笨」。承諾步數不會破功，承諾時間會。
    // ③「隨時可以離開，下次回來接著帶」搬到頁首「之後再說」旁邊——那是全流程最能降低
    //   壓力的一句，埋在開場句尾沒人讀得到，要在他想跑的那一刻才看得見（onboarding.vue）
    await say('嗨，我是小幫手 👋 我會一步一步陪你把客服機器人接上 LINE，不用懂程式也沒關係。<br>只要完成四個步驟：<b>建立帳號</b> → <b>取得連線資訊</b> → <b>接收 LINE 訊息</b> → <b>傳訊息測試</b>。<br>完成後，你就可以在 LINE 上跟你的 MiniMe 成功對話了 🎉')
    // 2026-09-07 老闆拍板**加回**出口鈕（推翻我 09-06「跟頁首『之後再說』去同一個地方就拿掉」）：
    // 同一個目的地≠同一個功能——頁首那顆藏在對話焦點之外、而且講不出「怎麼回來」；
    // 這顆按下去會補一句回來的路，那正是第一個畫面就決定不做的人最需要的資訊。
    // 全流程每一排按鈕都有出路（略過檢查／先跳過測試…），第一個畫面不該是唯一的例外。
    // ⛔ 字從「我想先自己逛逛」換成「我晚點再弄」：按下去落在帳號選擇頁＝沒什麼可逛，
    //    原本那句在承諾我們沒給的東西。
    const c = await askChoices([
      { label: '開始吧', value: 'go', primary: true },
      { label: '我晚點再弄', value: 'later', escape: true },
    ])
    if (c === 'later') {
      await say('沒問題！想開始的時候，從「我想開始使用」進來就行。')
      await navigateTo('/admin/workspaces')
      return false
    }
    return true
  }

  async function stepCreate(): Promise<boolean> {
    // ⛔ 這裡不可以叫「官方帳號」（2026-09-06 老闆拍板）：這一刻他**還沒接 LINE**，
    //    而三句話之後就要問「你已經有 LINE 官方帳號了嗎？」——同一個詞指兩個東西。
    //    我們自己的一律叫 MiniMe，「官方帳號」四個字只留給 LINE 那邊的帳號。
    await say('先幫你的 <b>MiniMe</b> 取個名字吧！通常用品牌名，之後隨時能改。')
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
        // 方案／額度／綁卡搬到結尾成績單（2026-09-02）：取完名字那一刻他只想知道下一步，
        // 這裡塞計費資訊會讓人停下來想「我是不是要付錢」
        await say(`「${escapeHtml(name)}」建好了 ✓`)
        // 2026-09-06 補過場：老闆反映「建好之後怎麼突然跳出 LINE 官方帳號」。
        // 缺的不是圖是**交代**——下一則就要問他有沒有 LINE 官方帳號，這裡先說一句要換場地了。
        // ⛔ 這一步刻意不配圖：它沒有任何按鈕要按，而下一則本來就配著帳號一覽的圖，
        //    連兩張圖會把一句「換場地了」講成一段教學（老闆原本要的三格漫畫因此不做）。
        await say('接下來，我們要把你的 MiniMe 和你的 <b>LINE 官方帳號</b>連在一起。<br>從這一步開始會帶你到 LINE 的後台操作，照著畫面一步一步做就可以。')
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
      progress.value = 2 // 兩組連線資訊都在了 → 接收 LINE 訊息
    else
      progress.value = 3 // 都做完了停在傳話測試那格，「完成」由 stepDone 點亮
  }

  async function stepHasOA() {
    // 2026-08-28 拍板：不加第三顆「不確定」鈕，改成當場點得到的連結——按鈕要多繞一趟才拿到答案。
    // 2026-09-02：原本「問題」與「不確定的話…」拆成兩則泡泡，一個問題佔兩顆；併成一則、
    // 問句放最後（緊接著下面的選項鈕）。⛔「同事／老闆申請的」那段不能刪，只能收起來——
    // 自己登入看到空列表就再建一個新帳號，好友得從頭加，代價比走錯流程大得多。
    await say(
      '不確定的話，<a href="https://manager.line.biz/" target="_blank" rel="noopener">打開官方帳號後台看一眼 ↗</a>——列表裡有帳號就是有。<br><b>你已經有 LINE 官方帳號了嗎？</b>',
      { summary: '列表是空的，但同事說有？', html: '帳號多半是老闆或前同事用<b>他的</b> LINE 申請的，你自己登入會看到空列表。先問一聲比較快——自己再建一個新的，好友要從頭加。' },
    )
    // 2026-09-02 補圖：這是最早的分岔、答錯整條路白走，原本一張圖都沒有。
    // 圖檔沒進來也不會壞（卡片載不到就只顯示文字）
    card({ kind: 'image', src: ONBOARDING_SHOTS.oamAccountList, alt: '官方帳號後台的帳號一覽：表格列出帳號名稱、好友數、權限與方案；列表裡有帳號就是「有」' })
    const c = await askChoices([
      { label: '有', value: 'yes', primary: true },
      { label: '還沒', value: 'no' },
    ])
    if (c === 'no') {
      // 2026-09-06 拆兩步：原本一句話塞了**跨兩個地方的兩件事**（申請帳號／啟用 Messaging API）、
      // 一個連結、零張圖就把人丟出去——跟「貼網址／開開關」拆兩步是同一個理由。
      // ⛔「大約 5 分鐘」拿掉（同拿掉「8 分鐘」「3 分鐘」的原則，而且申請根本不只 5 分鐘），
      //    改講「是免費的」——那才是他這一刻真正想知道的事。
      // ⛔ 更重要的是圖擺錯地方了：啟用那張圖原本**只掛在岔路「清單裡沒看到我的帳號？」**上，
      //    也就是他**已經漏做、卡住了**才看得到；而這條路是 100% 需要做這件事的人走的，
      //    卻一張圖都沒有。順序是反的。
      await walkNodes([
        {
          html: '先去申請一個 <b>LINE 官方帳號</b>，是<b>免費</b>的。申請時要填店名、聯絡信箱跟行業別，跟著畫面走就好。',
          href: 'https://tw.linebiz.com/entry/',
          hrefLabel: '前往申請 LINE 官方帳號（台灣） ↗',
        },
        {
          html: `申請好之後還有一個小步驟：到官方帳號後台的「<b>設定 → Messaging API</b>」按「<b>啟用</b>」——按下去要連過三個小視窗，都很快。<br>${OAM_ENABLE_STEPS}`,
          aside: { summary: '為什麼要按啟用？', html: '沒按啟用的話，等一下要取得連線資訊的地方<b>找不到你的帳號</b>——那份清單只列出已經啟用的。' },
          href: 'https://manager.line.biz/',
          hrefLabel: '打開官方帳號後台 ↗',
          image: ONBOARDING_SHOTS.oamEnableAnim,
          alt: '循環動畫四格：①按「啟用Messaging API」、②建立服務提供者並填名稱、③隱私權兩欄可不填按確定、④最後確認按確定',
        },
      ], '')
      await askChoices([{ label: '都好了，繼續', value: 'ok', primary: true }])
    }
  }

/**
 * 「按啟用 Messaging API」按下去要連過的三關——**兩處共用同一份字**
 *（「還沒有官方帳號」那條路，以及「清單裡沒看到我的帳號？」那條岔路）。
 *
 * 走到這兩處的人**都沒做過這件事**，所以兩邊都給同一支動畫，不是一邊動畫一邊靜圖。
 * ⚠️ ①②③④要跟 `oam-enable-messaging-api.webp` 上的紅色編號一致（改順序要一起改產圖腳本）。
 */
const OAM_ENABLE_STEPS = '照下面的動畫做：<b>①</b> 按「<b>啟用Messaging API</b>」→ <b>②</b> 選「<b>建立服務提供者</b>」，名稱<b>用你的店名就好</b>，按「同意」→ <b>③</b> 隱私權那兩欄<b>可以不填</b>，直接按「確定」→ <b>④</b> 最後那句「無法變更或解除」是正常的，按「<b>確定</b>」。'

  /** 節點式教學的一步：一句話＋（選配）連結／示意圖／岔路 */
  interface WalkNode {
    html: string
    href?: string
    hrefLabel?: string
    image?: string
    alt?: string
    /** 岔路按鈕：走完岔路回到同一步（例：清單裡沒看到帳號） */
    detour?: { label: string, run: () => Promise<void> }
    /** 預設收合的「為什麼／萬一沒做」——照著做需要的字留在外面，解釋收進來 */
    aside?: { summary: string, html: string, image?: string, alt?: string }
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
      await say(`${stepno}${n.html}`, n.aside)
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
        // exitLabel 空字串＝這支教學沒有中途出口（單節點的那幾支都是）。
        // ⛔ 不能無條件 push：現在單節點會在上面就 return，碰不到這裡，但只要有人日後
        //    幫那幾支加第二個節點，就會多出一顆**沒有字**的按鈕，而且不會有任何測試變紅。
        if (exitLabel)
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
    // 「都在 LINE Developers 後台」下一則教學第一句就會再講一次（2026-09-02 刪）
    await say('接下來，我們要讓你的 MiniMe 可以透過 LINE 幫你收發訊息，所以要先從 LINE 取得<b>兩組連線資訊</b>。<br>第一組叫做 <b>Channel Access Token</b>，用途很簡單：讓 MiniMe 可以用你的 LINE 官方帳號幫你傳訊息。')
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

  /** 拿第一組連線資訊的節點式教學（stepToken 可能重複進出，抽出來） */
  async function walkTokenNodes() {
    await walkNodes([
        {
          // 2026-09-02：「打開後台並登入」原本是獨立一個節點，但它只是一個連結——
          // 為了它多一次「下一步」不划算，併進「選對卡」這則（那則本來就配著清單動畫，
          // 開後台之後第一眼看到的就是那個畫面）。
          // 登入方式刻意不指定：不是每個人都用 LINE 帳號（也可能用電子郵件的商用帳號）。
          // 真實畫面查證過的陷阱：同一個帳號會有兩張同名卡（Messaging API／LINE Login），
          // 靠名字選五五開會選錯——選錯的下場是拿到另一把不能用的鑰匙。
          // ⚠️①②要跟動畫上的紅色編號一致。①那一格框的是**整組三顆登入鈕**不是單顆——
          // 08-19 拍板「登入頁不圈按鈕」的理由（圈哪顆都會誤導用其他方式登入的人）照樣守住，
          // 文案也維持「用你平常的方式」不指定。
          html: '打開 LINE Developers，照下面的動畫做：<b>①</b> 先登入——<b>用你平常的方式</b>就可以（第一次通常選「LINE帳號」）→ <b>②</b> 進去之後選你的官方帳號：<b>同名卡片可能有兩張</b>，認卡片下面<b>寫著</b>「Messaging API」小字的那張，點進去。',
          // 2026-09-02：兩個後台的差別原本要等到第 20 幾則（關自動回應）才講，但人從這裡
          // 就開始在兩個後台之間跳了——會在錯的後台找 Messaging API 分頁找到懷疑人生
          // ⚠️ 2026-09-06 分工整個變了（第二組連線資訊與貼網址都搬到中文後台），這段話跟著改
          aside: { summary: 'LINE 怎麼有兩個後台？', html: '對，兩個都會用到，分工很清楚：<br><b>LINE Developers</b>＝<b>只用來拿第一組連線資訊</b>，也就是現在這個，做完就不用再回來了。<br><b>LINE 官方帳號後台</b>＝<b>後面全部</b>——第二組連線資訊、貼網址、把回應方式設好。' },
          href: 'https://developers.line.biz/console/',
          hrefLabel: '打開 LINE Developers ↗',
          image: ONBOARDING_SHOTS.consoleChannelAnim,
          alt: '循環動畫兩格：①登入頁（三種登入方式框成一組）、②帳號清單聚焦卡片下方的 Messaging API 小字',
          detour: {
            label: '清單裡沒看到我的帳號？',
            run: async () => {
              // ⚠️ 跟「還沒有官方帳號」那條路是**同一件事**，用同一支動畫與同一份步驟字——
              //    走到這裡的人也從來沒做過，不是「回去再看一眼」，不能只給一張「按這裡」的靜圖
              await say(`那是還沒啟用的關係。到官方帳號後台的「設定 → Messaging API」按<b>啟用</b>，它才會出現在剛剛的清單裡。<br>${OAM_ENABLE_STEPS}`)
              card({ kind: 'link', label: '打開官方帳號後台', href: 'https://manager.line.biz/' })
              card({ kind: 'image', src: ONBOARDING_SHOTS.oamEnableAnim, alt: '循環動畫四格：①按「啟用Messaging API」、②建立服務提供者並填名稱、③隱私權兩欄可不填按確定、④最後確認按確定' })
            },
          },
        },
        {
          // 老闆拍板：切分頁→捲到底→發鑰匙→複製是一氣呵成的動作，合成一節點配循環動畫。
          // ⚠️①②③要跟動畫上的紅色編號一致（2026-09-02）——動畫循環播放，中途接上的人
          // 靠號碼才知道自己看到的是哪一句。「捲到最下面」刻意不編號：那是捲動不是停格。
          // 「動畫上的紅色號碼就是順序」原本三支教學各寫一次（2026-09-02 刪）：
          // 兩邊都有號碼，一看就對得起來，不需要每次解釋
          html: '照下面的動畫做：<b>①</b> 切到「<b>Messaging API</b>」分頁 → 捲到最下面 → <b>②</b> Channel access token 按「<b>Issue</b>」（發行）產生一組 → <b>③</b> 按<b>複製</b>圖示整串複製。',
          // 2026-09-06 換掉原本的「第二把鑰匙在哪？」——第二組已經不在隔壁分頁了（搬到中文後台），
          // 那句話會把人帶錯地方。改成擋另一個真實情況：發過的帳號按鈕寫的是 Reissue。
          aside: { summary: '我的按鈕寫的是「Reissue」？', html: '那代表這個帳號以前發過一次，按下去會<b>重新發一組新的</b>、舊的當場失效。如果舊的沒有別的地方在用，按下去就可以；不確定的話先問一下之前設定的人。' },
          image: ONBOARDING_SHOTS.getTokenAnim,
          alt: '循環動畫三格：①切到 Messaging API 分頁、②按 Issue 發行一組、③按複製圖示',
        },
      ], '我拿到了，直接貼上')
  }

  async function stepSecret(line: LineStatus) {
    if (line.secretConfigured)
      return
    await say('接下來是<b>第二組連線資訊：Channel Secret</b>。<br>它的用途很簡單，就是幫忙確認：收到的訊息真的來自 LINE，而不是其他地方假冒傳來的。<br>加油，已經快完成了！拿完這組，剩下就是<b>貼一串網址</b>、<b>傳一句話測試</b>。')
    // 2026-09-02 拍板：這一步**不問「要不要教你拿」**，教學直接播。
    // 理由是這支教學只有一則——選「我會拿，直接貼上」的人省下的就是那一則，
    // 閘門本身反而多收了一次點擊和一個決定。⛔ 這個結論不能無條件套到別步：
    // 拿第一組跨兩頁、接線那組是動作選單（含幫我檢查／略過檢查），兩邊都要留。
    //
    // 空出來的「跳過」位子給「回上一步：重貼第一組」——那是剛存完第一組就發現貼錯
    //（例如回顯的帳號名不對）的回頭路；過了這個窗口，接線檢查會用真訊號診斷出是哪一組
    // 錯、並給重貼入口。⛔ 這裡刻意不再給「再看一次教學」：圖就在輸入格正上方那一則。
    await walkSecretNodes()
    while (!line.secretConfigured) {
      const ok = await askAndSaveSecret(line, { escapeLabel: '回上一步：重貼第一組' })
      if (ok)
        break
      if (await redoKeyFlow(line, 'token', '不換了，回來貼第二組'))
        await say('第一組換好了 ✓ 回到第二組。')
      // 繞完回頭路，教學已經被推到很上面——重播一次再問，不要叫人往上滑
      await walkSecretNodes()
    }
  }

  /**
   * 拿第二組連線資訊的教學。
   *
   * ⛔ **2026-09-06 整段換地方**：從 LINE Developers 的 Basic settings 搬到
   * **官方帳號後台（中文）→ 設定 → Messaging API**。老闆實機驗過兩邊是同一份設定
   * （顯示、寫入雙向都驗），也確認過 Channel secret **會一直顯示**在那一頁（啟用後第 4 天仍在）。
   *
   * **為什麼非搬不可**：LINE Developers 的同名雙卡是全流程**唯一「照著做也會錯」**的地方——
   * 點到 `LINE Login` 那張，它的 Basic settings **也有**一個 Channel secret，貼進來系統照收、
   * 還回一句「收到 ✓ 已經幫你存好」，然後客人每句話都被當成假冒的丟掉，**畫面上一切正常**。
   * 我們為它做了對照圖、紅字警告、收合說明、專門診斷——**四層補丁都在防同一件事**。
   * 中文後台那一頁**沒有卡片可以挑**（它就是「這個帳號」的設定頁），錯誤機會直接消失，
   * 四層補丁一起退場（`whichCard` 那張圖與那段警告已不再被這裡引用）。
   *
   * ⚠️ 新的風險小得多但還是有：`Channel ID` 與 `Channel secret` 上下相鄰、**各有一顆複製鈕**，
   *    所以圖上框的是**整列**不是按鈕，文案也明講「上面那列是 Channel ID，別按錯」。
   */
  async function walkSecretNodes() {
    await walkNodes([
      {
        // ⚠️①②③要跟動畫上的紅色編號一致（改順序要一起改產圖腳本重跑）
        // 2026-09-07 老闆回饋：不要解釋英文／中文哪個後台，「越解釋越糊塗」——講「換一個後台」就好
        html: '接下來要換到<b>另一個後台</b>：<b>LINE 官方帳號後台</b>。<br>照下面的動畫做：<b>①</b> 點右上角「<b>設定</b>」→ <b>②</b> 左邊選「<b>Messaging API</b>」→ <b>③</b> 找到 <b>Channel secret</b> 那一列，按右邊的「<b>複製</b>」。<br>⚠️ 上面一列是 <b>Channel ID</b>，也有一顆複製鈕，別按錯。',
        href: 'https://manager.line.biz/',
        hrefLabel: '打開官方帳號後台 ↗',
        image: ONBOARDING_SHOTS.oamChannelSecretAnim,
        alt: '循環動畫三格：①右上角「設定」、②左欄「Messaging API」、③Channel secret 那一列與它右邊的「複製」',
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
   * 收第一組連線資訊：貼上 → **先問 LINE 這組是真的嗎** → 才存檔。
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
        await say('這組連線資訊 LINE 不認得 ⛔ 常見兩種原因：①複製時漏頭漏尾（要<b>整串</b>）②在 LINE 後台按過重發，舊的那把當場失效。回 Messaging API 分頁重新複製一次，再貼上來。')
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
        await say(`收到 ✓ 這組是「<b>${escapeHtml(check.displayName)}</b>」的連線資訊，我已經幫你存好了！`)
      else
        await say('收到 ✓ 已經幫你存好。')
      return true
    }
  }

  /** 收第二組連線資訊。⚠️這組沒辦法單獨驗真假（LINE 沒有這種 API），只能靠接線測試才驗得出來 */
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
    await say('來見證一下。拿手機<b>加你的 LINE 官方帳號好友</b>，隨便傳一句話給它——我在這裡等。')
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
      { label: '重貼連線資訊或網址', value: 'redo' },
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
      { label: '重貼連線資訊或網址', value: 'redo' },
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
          // 2026-09-02 改格式不改內容：原本是 175 字、四個編號擠成一段的**段落**。
          // 這是整段流程最有價值的一則，但出現的時機正好是人卡住又焦慮的時候，
          // 而那時最讀不下去的就是一整段文字。排成清單，字一個都沒少，但變成
          // 可以一條一條對著檢查。
          await say('還沒等到訊息——最常見的是這四種，按下面「幫我再驗一次」我全部幫你看一遍。這段時間我也還在聽，訊息一進來就會告訴你。')
          card({
            kind: 'help',
            summary: '照這四條檢查',
            steps: [
              { text: '網址貼進「Webhook網址」了，但還沒按「<b>儲存</b>」' },
              { text: '「回應設定」那一頁的 <b>Webhook</b> 開關沒打開' },
              { text: '手機加好友加到別的帳號了' },
              { text: '第二組連線資訊（Channel Secret）貼錯——訊息其實有送到，被我們當成假冒的丟掉' },
            ],
            // 2026-09-02 補：這張卡原本一個連結都沒有。前三條都要人回 LINE Developers
            // 才檢查得了，卡住的人照著念完卻沒有一個地方點得過去——這一段正好是全流程
            // 最需要「當場點過去」的時刻。第四條在同一個後台的另一個分頁，同一個連結到得了。
            href: 'https://developers.line.biz/console/',
            hrefLabel: '打開 LINE Developers 對照',
          })
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
          await say('這條線是通的——再用手機傳一句話試試，我繼續等。')
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
      await say('收到了！你的 MiniMe 正式活起來了 🎉 之後客人傳的每一句話，都會出現在 <b>MiniMe 後台</b>的「對話」頁。')
      setup.firstMessageReceived = 'done'
    }
    else {
      updateMsg(waitId, { kind: 'status', state: 'skipped', text: '略過測試——之後隨時可以加好友傳一句話試試' })
    }
    progress.value = 3
  }

  /**
   * 重貼某一組連線資訊的統一入口（2026-08-20 拍板：回頭重做也要有教學，忘記怎麼拿的人
   * 正是最需要教的人；所有重貼入口一律同這套規則，跟主流程一致）：
   * 先問「教我一步步拿／直接貼新的／不換了」，輸入格的後門直達教學。
   * 回傳有沒有真的換（診斷路徑要靠它決定要不要說「再檢查一次」）。
   */
  async function redoKeyFlow(line: LineStatus, kind: 'token' | 'secret', cancelLabel = '不換了'): Promise<boolean> {
    const isToken = kind === 'token'
    // 2026-09-02：主鈕從「教我一步步拿」換成「直接貼新的」。會走到重貼的人**已經走過
    // 一遍教學了**，八成是貼錯要換一把，這時主要需求是貼；教學降為次要（標籤還在，
    // 只是不再佔著主鈕的位置）。
    const how = await askChoices([
      { label: '我會拿，直接貼新的', value: 'paste', primary: true },
      { label: '教我一步步拿', value: 'walk' },
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
        { label: '重貼第一組連線資訊', value: 'token' },
        { label: '重貼第二組連線資訊', value: 'secret' },
      ])
      if (c === 'token' || c === 'secret') {
        await redoKeyFlow(line, c)
        continue
      }
      return
    }
  }

  /** Webhook 檢查判定是「LINE 不認得我們的 Token」時的出口：讓人當場重貼第一組連線資訊 */
  async function reenterToken(line: LineStatus) {
    if (await redoKeyFlow(line, 'token', '先不換了'))
      await say('再檢查一次看看。')
    else
      await say('好，先不換。想換的時候再按一次檢查就行。')
  }

  /**
   * 判定是「我們自己把 LINE 的測試訊息擋掉」時的出口：重貼第二組連線資訊。
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
    const cardId = card({ kind: 'status', state: 'pending', text: '正在問 LINE 收不收得到…' })
    const v = await verifyWebhook(webhookUrl)
    if (v?.cause === 'ok') {
      updateMsg(cardId, { kind: 'status', state: 'ok', text: '接上了，LINE 那邊確認收得到' })
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
        await say('LINE <b>不認得我們手上這組連線資訊</b>——就是第一組（Channel Access Token），多半是在 LINE 後台被重新發過一次，舊的當場失效。要重貼一把新的嗎？')
        const r = await askChoices([
          { label: '重貼第一組連線資訊', value: 'retoken', primary: true },
          { label: '我再檢查看看', value: 'later' },
        ])
        if (r === 'retoken')
          await reenterToken(line)
        break
      }
      case 'signature': {
        await say('好消息是 LINE <b>有把訊息送過來</b>，但被我們自己擋掉了：<b>第二組連線資訊</b>（<b>Channel Secret</b>）跟 LINE 後台不是同一組，訊息會被當成假冒的丟掉。要重貼一次嗎？')
        const r = await askChoices([
          { label: '重貼第二組連線資訊', value: 'resecret', primary: true },
          { label: '我再檢查看看', value: 'later' },
        ])
        if (r === 'resecret')
          await reenterSecret(line)
        break
      }
      case 'nourl':
        await say('LINE 那邊<b>還沒收到這串網址</b>——通常是貼進「Webhook網址」但沒按「<b>儲存</b>」。再貼一次、按儲存，好了再驗一次。')
        break
      case 'inactive':
        await say('網址有了，剩「<b>Webhook</b>」開關沒打開——在官方帳號後台的「設定 → <b>回應設定</b>」那一頁。開了再驗一次。')
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
    progress.value = Math.max(progress.value, 2) // 兩組連線資訊到手，進「接收 LINE 訊息」格
    let verified = false

    // 續走模式先靜默驗一次：之前就接好 Webhook 的人不用再被叫去貼一次網址。
    // ⚠️ 2026-09-06 起 `resumedConnected` 這個旗標不需要了——關自動回應的教學已經併進
    //    `teachConnect()`，而它只在 `!verified` 時播，回來的人自然跳過（原本要靠旗標擋）。
    if (opts.preVerify && line.tokenConfigured && line.secretConfigured) {
      const v = await verifyWebhook(webhookUrl)
      if (v?.cause === 'ok') {
        await say('Webhook 之前就接好了 ✓ 直接來測試。')
        verified = true
      }
    }

    if (!verified) {
      // 「兩組連線資訊都到手 ✓」原本是 stepSecret 結尾獨立的一則，跟這一則連著講兩次
      // 「最後一步」（2026-09-02）。併過來還順便修好一個舊漏洞：續走、連線資訊早就都在的人
      // 會直接跳過 stepSecret，那句話他本來一輩子看不到。
      await say('兩組連線資訊都完成了 ✓ 只剩最後一段——<b>都在你剛剛那個官方帳號後台裡</b>就能做完。')
      card({ kind: 'copy', label: '你的訊息接收網址（Webhook URL）', value: webhookUrl })
      await teachConnect()
    }

    while (!verified) {
      // ⛔ primary 不可以隨狀態換人（2026-08-28 code review 修）：選項鈕的排版規則是
      //    「主要動作排最後（靠右）」，所以 primary 一換人，**兩顆鈕就互換位置**——
      //    走完教學回來要按的那顆會從第 2 顆跑到第 4 顆，手指停的地方剛好是他才剛做完的事。
      //    這一步真正要完成的事永遠是「幫我檢查」，主要動作就固定給它。
      const c = await askChoices([
        { label: '都設好了，幫我檢查', value: 'check', primary: true },
        { label: '再看一次教學', value: 'walk' },
        { label: '略過檢查，直接測試', value: 'skip', escape: true },
        { label: '重貼連線資訊或網址', value: 'redo' },
      ])
      if (c === 'redo') {
        await offerRedo(line)
        continue
      }
      if (c === 'walk') {
        await teachConnect()
        continue
      }
      if (c === 'skip') {
        // 2026-09-02：跳過的東西要說得出丟了什麼（跳過測試那顆本來就有寫，這顆漏了）。
        // 同一條流程兩顆跳過鈕、一顆講一顆不講，正是那條「沉默死亡」慣例要防的事。
        await say('好，先不檢查。<b>如果等一下沒收到訊息，多半就是這一步沒設好</b>——那時我會再帶你驗一次。')
        break
      }
      const res = await verifyAndAdvise(webhookUrl, line)
      if (res === 'ok') {
        await say('連線成功了！🎉 你的 LINE 官方帳號已經成功連上系統，可以正式使用 MiniMe 了。')
        verified = true
      }
    }

    // 沒驗過就進測試（按了「略過檢查」）＝排障入口提前給，不用等 90 秒
    await stepFirstMessageWait(line, setup, webhookUrl, { offerVerifyUpfront: !verified })
  }

  /**
   * 接線教學：貼網址、把回應方式設好——**兩步都在官方帳號後台（中文）**。
   *
   * ⛔ **2026-09-06 整段改道**（老闆實機驗過兩邊設定同步）。原本三個節點全在 LINE Developers：
   * 打開 → 選對卡／切分頁／按 Edit／按 Update → 再開 `Use webhook`。現在：
   * ①在他剛剛複製 Channel secret 的**同一頁**貼網址按「儲存」
   * ②在「回應設定」把 `Webhook` 打開，順便把回應方式改成「手動聊天」——**一頁做完兩件事**。
   *
   * ⛔ **順序不可以反**（這次改動最容易踩的坑）：`Webhook` 開關現在跟「關自動回應」同一頁，
   *    如果照舊在開關之前就叫人「幫我檢查」，一定驗不過——人會被一個「其實只是還沒做到」
   *    的失敗嚇到。所以檢查移到這兩步**都做完之後**。
   *
   * ⛔ 這一段**不問「要不要教你」**、教學直接播：這兩步沒有任何東西要貼回來，教學不擋在
   *    輸入框前面；而且 100% 的人都得做。（原本 08-28 留閘門的理由是「接線那組是動作選單」，
   *    那個選單還在——只是移到教學之後，變成「做完了沒」而不是「要不要教」。）
   */
  async function teachConnect() {
    await walkNodes([
      {
        // ⚠️①②③④要跟動畫上的紅色編號一致。
        // 2026-09-07 老闆拍板恢復①②導航（中間離開過去貼 secret，回來可能已經迷路），
        // 所以這則的字也從「回到剛剛那一頁」改成整條路重新帶一次。
        html: '先按上面那張卡的「<b>複製</b>」把網址複製起來，再回到<b>官方帳號後台</b>。<br>照動畫做：<b>①</b> 點右上角「<b>設定</b>」→ <b>②</b> 左邊選「<b>Messaging API</b>」→ <b>③</b> 把網址貼進「<b>Webhook網址</b>」那一格 → <b>④</b> 按右邊的「<b>儲存</b>」。',
        aside: { summary: '為什麼特別強調存檔？', html: '貼了沒按「儲存」是接不通的<b>第一名</b>——網址看起來在格子裡，其實沒存進去。' },
        href: 'https://manager.line.biz/',
        hrefLabel: '打開官方帳號後台 ↗',
        image: ONBOARDING_SHOTS.oamWebhookUrlAnim,
        alt: '循環動畫四格：①右上角「設定」、②左欄「Messaging API」、③「Webhook網址」輸入格、④它右邊的「儲存」鈕',
      },
      {
        // 2026-08-19 對實際畫面校正過：新版介面沒有「聊天機器人」那組選項了，
        // 正確操作是回應方式選「手動聊天」——照舊講法找「聊天機器人」的人會找不到。
        // ⚠️ 寫「把它打開」不是「確認它是開的」：`src-webhook-saved.jpg` 是同一個帳號**剛按完
        //    存檔**的畫面，那顆開關**還是灰的**＝預設關閉。但補一句「已經是綠的就不用動」，
        //    因為「在 OA 後台存網址會不會順手把它打開」沒驗過，這樣兩種情況講的都成立。
        // ⛔ 這裡用的是**不含「點右上角設定」**的那一支（2026-09-06）：他前兩步都在設定裡，
        //    再叫他點一次是叫他去他已經站著的地方。⚠️但補一句給「重新點連結進去」的人——
        //    我們的連結落在「主頁」，那種情況左邊那排選單還沒展開。
        html: '<b>還在同一個後台</b>，這一頁要做<b>兩件事</b>。<br>照動畫做：<b>①</b> 左邊選「<b>回應設定</b>」→ <b>②</b> 把「<b>Webhook</b>」<b>打開</b>（開好像圖上那樣是綠的；已經是綠的就不用動）→ <b>③</b>「聊天的回應方式」選「<b>手動聊天</b>」。<br>⛔ 不要選「手動聊天＋自動回應訊息」——那等於沒關。<br>（如果左邊沒有那排選單，先點右上角的「設定」。）',
        aside: { summary: '為什麼要關掉自動回應？', html: 'LINE 內建的自動回應預設是開的，不關的話客人每句話都會收到<b>兩套回覆</b>——LINE 那句制式回覆，再加上 MiniMe 的回覆。' },
        href: 'https://manager.line.biz/',
        hrefLabel: '打開官方帳號後台 ↗',
        image: ONBOARDING_SHOTS.oamResponseSettingsAnim,
        alt: '循環動畫三格：①側欄「回應設定」、②打開 Webhook 開關、③選手動聊天',
      },
    ], '')
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
        // 方案／額度／綁卡從「剛取完名字」搬來這裡（2026-09-02）：那一刻他只想知道
        // 下一步，計費資訊會讓人停下來想「我是不是要付錢」；擺在成績單上才是他
        // 「做完了、接下來呢」會想知道的事
        { label: `${freePlanName}方案，每月 ${freeQuota} 則 AI 回覆`, done: true, note: '不需綁卡' },
      ],
    })
    // 結尾刻意一個字都不提知識庫／AI（2026-08-19 拍板二修：AI 的事完全不進開通，
    // 連結尾指路也不要）——接下來要做什麼，由右下角小幫手的清單接手盯
    // 2026-09-02：這則與下一則「要不要認識後台」併成一則——成績單卡＋交棒＋推銷導覽
    // 三連發，剛做完一件事的人連讀三段。「點它隨時找得到我」與前半句重複，一併收掉。
    await say('接通完成 🎉 接下來我會待在<b>右下角</b>——下一步要做什麼、哪裡怪怪的，我都會主動說。<br>要不要先花 <b>2 分鐘認識一下 MiniMe 後台</b>？我帶你逛一圈，知道東西都放在哪。')
    // 2026-08-28 拍板（**翻掉 08-19「結尾連指路都不要」**）：當時擋的是「催人開 AI，
    // 但那時知識庫是空的、只會答不出來」——介紹後台地圖不踩那個雷。剛做完一件事、
    // 下一步是空白，是整段旅程裡唯一「介紹不會打斷任何事」的時機。
    // ⛔ 仍然一個字都不提知識庫／AI：那些由小幫手的開通清單接手盯，這裡只給地圖。
    // 這頁也要有上一步（2026-08-20 老闆抓到：成績單擺著「已跳過」卻只有離開鈕＝卡死）：
    // 跳過的測試可以當場回去做、鑰匙可以當場重貼，改完成績單會重新整理
    // 2026-09-02 分層（⛔**不是刪**）：五顆按鈕每一顆都有拍板紀錄，但剛做完一件事的人
    // 一次面對五個選項會呆住。所以主要的兩顆直接擺，其餘三顆收進「還有別的問題？」——
    // 需要的人多按一次，不需要的人少讀三行。
    let showMore = false
    while (true) {
      const options: AgentChoice[] = []
      if (showMore) {
        if (setup.firstMessageReceived !== 'done')
          options.push({ label: '回去做傳話測試', value: 'test' })
        options.push(
          { label: '重貼連線資訊或網址', value: 'redo' },
          // 設定頁進場會實跑一次連線檢查，各欄位旁還有「教我怎麼拿」求救鈕
          { label: '好像有設定錯？幫我檢查', value: 'check' },
          { label: '沒事了，回上一頁', value: 'back', escape: true },
        )
      }
      else {
        options.push(
          { label: '帶你認識後台（約 2 分鐘）', value: 'tour', primary: true },
          // 2026-09-02 老闆拍板**翻掉 08-28**：那顆「去看剛剛那則對話／開始設定」拿掉了，
          // 第一次進來一定要看導覽。08-28 留它的理由是「唯一不看導覽直接進去的出口」，
          // 現在改成**由導覽自己把人送到那則對話**（OVERVIEW 最後一步），所以那顆的
          // 工作有人接手了，不是單純把出口砍掉。
          // ⛔ 導覽中途的「✕」不可以跟著拿掉：每一步都指真實元素，指不到就會停在暗畫面上，
          //    那顆是防卡死的安全閥，跟「一開始就跳過」是兩件事。
          { label: '還有別的問題？', value: 'more' },
        )
      }
      const c = await askChoices(options)
      if (c === 'more') {
        showMore = true
        continue
      }
      if (c === 'back') {
        showMore = false
        continue
      }
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
