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

import type { AgentChoice, AgentMsg } from '~~/shared/types/agent-messages'
import { escapeHtml } from '~~/shared/types/agent-messages'
import type { SetupCapabilityId, SetupItemStatus, SetupStatusResponse } from '~~/shared/types/setup'
import { BILLING_PLANS } from '~~/shared/billing/plans'
import { type LineWebhookCause, diagnoseLineWebhook } from '~~/shared/line-webhook-diagnosis'
import { ONBOARDING_CAROUSELS } from '~/utils/onboarding-shots'
import type { AgentAskResult, AgentScriptStep } from '~/composables/useAgentScriptRunner'
import {
  describeMissing,
  describeSiteRead,
  filledFieldCount,
  STORE_PROFILE_FIELDS,
  STORE_PROFILE_SOURCE_LABELS,
  STORE_PROFILE_VALUE_MAX,
  storeProfileAskSteps,
  type StoreProfileDoc,
  type StoreProfileFieldId,
} from '~~/shared/types/store-profile'
import {
  buildStoreDrafts,
  canBuildDrafts,
  REWORD_MAX_PER_CARD,
  REWORDABLE_DRAFTS,
  summarizeDraftApply,
  type DraftApplyStep,
  type StoreDraft,
  type StoreDraftKey,
} from '~~/shared/store-profile-drafts'
import { buildFollowWelcomeScript, followWelcomeRow } from '~~/shared/follow-welcome'
import { type ScriptNode, scriptTriggerEvent } from '~~/shared/types/ai-script'
import { suggestTagCode } from '~~/shared/tag-code-suggest'
import { daysBetween, taipeiDate } from '~~/shared/time'
import { storeBizWording, storeProfileLabelFor } from '~~/shared/store-profile-biz'
import { TAIWAN_FESTIVALS } from '~~/shared/taiwan-festivals'
import { clearLineFlowInProgress, markLineFlowInProgress } from '~/utils/onboarding-line-flag'
import { LANDING_FROM_BUILD, LANDING_FROM_LINE, liveTourStepCount, saveOnboardingBuilt } from '~/utils/onboarding-landing'
import { lineFlowEntry } from '~~/shared/onboarding-events'
import { useOnboardingEvents } from '~/composables/useOnboardingEvents'

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
/**
 * ⚠️ 2026-09-22 多一格「認識你的店」（`D-85` / `C-219`）：擺在**建立帳號之後、
 * 取得連線資訊之前**。理由是那一刻他人人答得出來、還沒撞到金鑰那道牆，而答案
 * 存進工作區不會白做；讀網站在背景跑，正好塞進接 LINE 的等待時間。
 * ⛔ 官網首頁的示範動畫有一份**抄過去的**同名陣列（`app/pages/index.vue` 的
 *    `OB_PROGRESS_LABELS`），改這裡要一起改，不然網站演五格、產品是六格。
 */
/**
 * 🔴 2026-09-26（`C-250`，示意頁 v80 定稿）**拆成兩趟，各自四格**：
 *   - 「打造你的 MiniMe」：建立帳號 → 認識你的店 → 看看成果 → 完成打造（全在自己頁面裡、零外部依賴）
 *   - 「接上 LINE，讓客人找得到你」：取得連線資訊 → 接收 LINE 訊息 → 用手機測試 → 上線完成
 *     （要登入別人的後台、要手機——**他之後自己決定什麼時候做**，從紅帶／小幫手／組織頁進來）
 * 為什麼：原本一條六格把「填我們自己的表」跟「串別人家的系統」畫成同一條路，走到第三格就撞上
 * 要登入兩個別人的後台——前面的成功率被後面拖著走（`D-88`）。
 * ⛔ **不寫「第 1 段／第 2 段」**（老闆 09-25：「第一段第二段不好理解」）：拆兩趟是我們內部的設計，
 *    對他只有兩件各自獨立的事；講「第 1 段」等於暗示還有第 2 段在等他。
 * ⛔ 官網首頁的示範動畫有一份抄過去的陣列（`app/pages/index.vue` 的 `OB_PROGRESS_LABELS`），
 *    它演的是打造那一趟——改這裡要一起改。
 * ⚠️ 第三格「傳訊息測試」→「用手機測試」（v79）：那一步現在是加好友（`D-101`），
 *    頭頂寫傳訊息、卡片叫他加好友＝兩個地方講不同的事。
 */
export const ONBOARDING_BUILD_LABELS = ['建立帳號', '認識你的店', '看看成果', '完成打造'] as const
export const ONBOARDING_LINE_LABELS = ['取得連線資訊', '接收 LINE 訊息', '用手機測試', '上線完成'] as const

export type OnboardingFlow = 'build' | 'line'

/** 兩趟各自的名字、要多久、四格——**同一份資料**（⛔ 三者分散的話，改一處就開始各說各話） */
export const ONBOARDING_FLOWS: Record<OnboardingFlow, { name: string, time: string, labels: readonly string[] }> = {
  build: { name: '打造你的 MiniMe', time: '約 5 分鐘 · 不用離開這一頁', labels: ONBOARDING_BUILD_LABELS },
  line: { name: '接上 LINE，讓客人找得到你', time: '約 10–15 分鐘 · 要登入 LINE 官方帳號後台', labels: ONBOARDING_LINE_LABELS },
}

/** 進度條的格子索引（⛔ 別在劇本裡散落 magic number，加一格就要全檔重數一次） */
export const BUILD_STEP = { create: 0, profile: 1, reveal: 2, done: 3 } as const
export const LINE_STEP = { credentials: 0, receive: 1, testMessage: 2, done: 3 } as const

/** 接 LINE 那一趟的出口落「對話」頁：新帳號統計全 0，空的對話清單比空報表誠實（2026-08-12 拍板 G-11） */
export function onboardingLandingPath(workspaceId: string): string {
  return `/admin/${workspaceId}/conversations`
}

/**
 * 打造那一趟的出口落「測試對話」（`D-88` 風險 D／`D-95`）。
 * ⛔ 不落「客服對話」：那一頁的理由是「他剛傳的那句話就在裡面」，而打造這條路上他一句都還沒傳；
 *    測試對話是唯一不接 LINE 也完整可用、而且第一個「哇」就發生在那裡的頁。
 */
export function onboardingBuiltLandingPath(workspaceId: string): string {
  return `/admin/${workspaceId}/ai-playground`
}

interface LineStatus {
  tokenConfigured: boolean
  secretConfigured: boolean
  liffConfigured: boolean
  publicBaseUrl: string
}

/**
 * 這段時間內新加好友（或早就是好友、剛傳訊息）的那一位（`C-250`③，`GET /api/admin/onboarding/new-follower`）。
 * ⚠️ 取代原本只認「真的訊息」的 first-message：加好友那一下就算測通。
 */
interface NewFollowerRes {
  found: boolean
  lineUserId?: string
  displayName?: string
  pictureUrl?: string
  via?: 'follow' | 'message'
  at?: number
}

/** 按鈕題的出口「都不是，我自己講」的值（⛔ 不可以跟任何選項同名） */
const FREE_ANSWER = '__free'

const POLL_INTERVAL_MS = 4000
/**
 * 等第一則訊息多久沒動靜，就主動開口排障（別讓人乾瞪著轉圈）。
 * 別調太短：拿手機、找官方帳號、加好友、打一句話，第一次做通常就要一分多鐘——
 * 45 秒實測會讓排障變成常態路徑，對一切正常的人喊「還沒等到」。
 */
const FIRST_MSG_HINT_MS = 90_000

/** 讀網站工作的輪詢間隔。每次輪詢＝伺服器那邊推進一步（抓一頁），所以間隔不能太長。 */
const SITE_JOB_POLL_MS = 1500
/**
 * 揭曉前最多等讀網站多久。
 * 走到這裡的人已經花了好幾分鐘接 LINE，讀網站通常早就跑完；這個上限是**保險**，
 * 不是常態路徑。⛔ 一定要有：沒有上限的話，網站卡住時人會坐在一個沒有任何按鈕的畫面前面。
 */
const SITE_JOB_MAX_WAIT_MS = 20_000

/** Webhook 驗不過、訊息又看不出病因時的通用建議（只寫這一份，之前三處各一版已經漂掉） */
const WEBHOOK_COMMON_CAUSES = '最常見是網址還沒按「儲存」，或「回應設定」那頁的 <b>Webhook</b> 開關沒打開'

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
  const { entries, ask, typing, busy, scrollToId, turnStartId } = runner
  const {
    say,
    card,
    scrollToEntry,
    startTurn,
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
  /** 這一場是哪一趟（頁首的名字、要多久、四格都跟著它換） */
  const flow = ref<OnboardingFlow>('build')
  const flowInfo = computed(() => ONBOARDING_FLOWS[flow.value])
  /**
   * 開通步驟紀錄（`C-250`③，`D-100` C-1「升格為上線前提」）。
   * ⛔ 只記行為不記內容：他打的答案、貼的連線資訊一個字都不進紀錄（事件表 `shared/onboarding-events.ts`）。
   */
  const { track, flush: flushEvents } = useOnboardingEvents({ workspaceId: () => wid.value, flow: () => flow.value })
  /**
   * 「要加哪個帳號」查到的東西（見證卡的第①步要用）。
   * 快取住：傳話測試可以從成績單再進來一次，那時要的是同一份資料畫到新的卡上，不是再問一次 LINE。
   */
  let oaInvite: { basicId: string, addFriendUrl: string, qrDataUrl?: string, displayName?: string, pictureUrl?: string } | null = null
  /**
   * 這一趟有沒有把他的手機加進通知名單（按了「是我」、而且名單沒滿，`C-250`③）。
   * ⛔ 成績單與「上線之後」導覽**只有這個是真的才講**「早上的摘要、客人找真人會傳到這支手機」。
   */
  let phoneNotified = false
  /** 這一趟見證到的是加好友還是傳訊息（成績單那一刻判斷他那一場在不在「客服對話」清單上） */
  let phoneTestVia: 'follow' | 'message' | null = null

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
    flow.value = 'build'
    progress.value = BUILD_STEP.create
    track('build_start', { mode: 'fresh' })
    // 2026-09-02 三件事一起改：
    // ①開場兩則併一則——人還沒做任何事就要讀兩段
    // ②拿掉「大約 8 分鐘」——這段全文 2,100 多字，光讀就超過 6 分鐘，還沒算去 LINE 後台
    //   做事的時間；第一次的人做到 20 分鐘還在拿第二把鑰匙，這個數字就從「安心」變成
    //   「我是不是很笨」。承諾步數不會破功，承諾時間會。
    // ③「隨時可以離開，下次回來接著帶」搬到頁首「之後再說」旁邊——那是全流程最能降低
    //   壓力的一句，埋在開場句尾沒人讀得到，要在他想跑的那一刻才看得見（onboarding.vue）
    // 2026-09-09 老闆指定：「客服機器人」→「MiniMe」（對外品牌統一 MiniMe，開場白跟著走；
    // 全 repo 另一處「客服機器人」在 ai-answer.ts 的交接摘要 prompt＝內部指令，刻意不動）
    // 2026-09-10 再瘦一次（示意頁定版）：**四個步驟不用在這裡念一遍**——
    // 頁首的進度條就長在上面，同一組字寫兩次，第二次是雜訊。改成指過去（「照上面那條進度」），
    // 開場從三行縮成兩行。⛔ 進度條的字（`ONBOARDING_FLOWS`）就成了唯一那份，
    // 改它之前先確認這句話還指得過去。
    // ⚠️ 2026-09-22 跟著進度條多的那一格改字（`C-219`）：流程不再只有「接上 LINE」，
    //    開場說的事要跟上面那條進度對得起來——⛔ 進度條寫六格、開場只講接 LINE，
    //    就是 08-12 那條「教一套驗一套」的同型。
    // ⭐ 2026-09-26（`C-250`，示意頁 v80 定稿）：第一個畫面是**邀請**，不是流程簡報
    //    （老闆 09-24：「就跟他說來建立專屬你的 MiniMe 之類的詞就好」）。
    //    ⛔ 不再講「再陪你接上 LINE」：接 LINE 已經不是這一趟的事（打造完直接進後台，之後自己決定）。
    //    只留進度條講不出來的那一句：**做完你當場就能問它問題**（那是他按下去的理由）。
    await say('嗨，我是小幫手 👋<br>來建立<b>專屬你的 MiniMe</b>——做完你當場就能問它問題。')
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
      track('build_later')
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
        track('workspace_created')
        // 剛建好的帳號還不在前端清單裡，auth middleware 靠那份清單認人——先重載，
        // 結束時導航才不會被自己的守衛擋下來
        await loadWorkspaceList().catch(() => {})
        // 方案／額度／綁卡搬到結尾成績單（2026-09-02）：取完名字那一刻他只想知道下一步，
        // 這裡塞計費資訊會讓人停下來想「我是不是要付錢」
        await say(`「${escapeHtml(name)}」建好了 ✓`)
        // ⛔ 2026-09-10 刪掉這裡的過場泡泡（09-06 補的那句「接下來要把 MiniMe 和你的
        //    LINE 官方帳號連在一起…」）：它要交代的事**下一則自己就說了**——`stepHasOA`
        //    的第一句就是「接下來，把你的 MiniMe 跟你的 LINE 官方帳號連在一起」，
        //    後面直接接問句。兩則連著出現＝同一句話講兩次，中間還多一次打字停頓。
        //    09-06 補它的理由（「建好之後怎麼突然跳出 LINE 官方帳號」）由那則的前半句承接。
        progress.value = BUILD_STEP.profile
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

  // ── 認識你的店（`D-85` / `C-219`）──────────────────────────────
  //
  // 為什麼擺在這裡：打造那一趟的第 2 格，建立帳號之後（`C-250` 起接 LINE 另成一趟）。
  //   ① 這五題人人答得出來，**不會撞到金鑰那道牆**——卡在金鑰的人原本是空手離開的。
  //   ② 答案存進工作區，之後接不接 LINE 都不會白做。
  //   ③ 讀網站要一分鐘：⚠️ 拆兩趟之後**不再躲在接 LINE 的等待裡**，揭曉那一步要講「正在讀」。
  // ⛔ 這一段**零 LLM**：只收答案。讀網站是另一支（背景 job），模型不參與問答。

  /** 這一輪讀網站的工作 id；接線完成後揭曉那一刻要拿它去收結果 */
  let siteJobId = ''
  /** 揭曉時拿到的輪廓——草稿那一段直接用它，⛔ 不要再打一次同一支查詢 */
  let revealedProfile: StoreProfileDoc | null = null

  /**
   * @param opts.skipFilled 已經有值的題目不要再問一次（老店反推之後只補猜不到的那幾題）
   * @param opts.intro      開場白換一句（反推之後不必再講一次「讓我認識你的店」）
   */
  async function stepStoreProfile(opts: { skipFilled?: StoreProfileDoc, intro?: string } = {}): Promise<'done' | 'skipped'> {
    progress.value = BUILD_STEP.profile

    if (opts.intro) {
      await say(opts.intro)
    }
    else {
      // ⚠️ 2026-09-23 第三版（老闆：「這些廢話還是很多，只需要呈現使用者該知道的文字」）。
      // ⛔ **這一則只留三件事**：要做什麼、要多久、一句為什麼。
      //    第二版還在解釋「你的建議 vs 通用建議差在哪」並舉例——那是**我想講的**，
      //    不是他這一刻需要知道的；他要的是決定要不要按下去。
      // ⛔ 舉例、清單、後果全部收進 aside：想知道的人點開，其餘的人少讀四行。
      await say(
        '先回答五個問題，大約 <b>3 分鐘</b>。<br>'
        // ⚠️ `C-260`：這一句在第 1 題之前，還不知道他是哪一型——⛔ 不寫「賣什麼、賣給誰」
        + '知道你做什麼、客人是誰，我給的建議才會是你的店用得上的。',
        { summary: '不做會怎樣？', html: '還是能用，只是節慶提醒和 AI 的口氣都只能用通用的。之後在「組織與 LINE」頁隨時可以補。' },
      )
    }
    const go = await askChoices([
      { label: '好，開始', value: 'go', primary: true },
      { label: '先跳過', value: 'skip', escape: true },
    ])
    if (go === 'skip') {
      track('profile_skip')
      await say('好。想做的時候，右下角的小幫手留著這一條。')
      return 'skipped'
    }

    const answers: Partial<Record<StoreProfileFieldId, string>> = {}
    // 已經有值的題目不再問（反推之後只補猜不到的那幾題）。
    // ⛔ 過濾完要**重新編號**：留著原本的 1/5、4/5 會讓人以為系統漏問了。
    const allSteps = storeProfileAskSteps()
    const steps = (opts.skipFilled
      ? allSteps
          .map(s => ({ step: s.step, fields: s.fields.filter(f => !opts.skipFilled!.fields?.[f.id]?.value) }))
          .filter(s => s.fields.length > 0)
          .map((s, i) => ({ step: i + 1, fields: s.fields }))
      : allSteps)
    track('profile_start', { steps: steps.length, inferred: !!opts.skipFilled })
    for (const { step, fields } of steps) {
      for (let i = 0; i < fields.length; i++) {
        const def = fields[i]!
        // 同一步有兩題時（「最後兩個快問快答」），只有第一題掛步驟編號。
        // ⛔ 只剩一步時不要標「1 / 1」：那是雜訊，而且看起來像系統算錯了
        //    （老店反推之後只剩旺季與最想解決，正好就是這個情況）。
        const prefix = i === 0 && steps.length > 1 ? `<span class="agm-stepno">${step} / ${steps.length}</span>` : ''
        const extra = i === 0 && fields.length > 1 ? '最後兩個快問快答。' : ''
        /**
         * 🔴 2026-09-26（`C-250`／`D-99`）第 2、4 題的問法**照第 1 題的答案換**。
         *    ⛔ 對牙醫診所問「主要賣什麼」、對補習班問「客人通常怎麼買」，他要嘛答不出來、
         *    要嘛硬塞一個怪答案進去，而那個答案會一路長到 AI 的語氣裡。
         * ⚠️ 產業別取「這一輪已經答的」，老店反推時取輪廓裡的（`skipFilled`）。
         */
        const industry = answers.industry ?? opts.skipFilled?.fields?.industry?.value ?? ''
        const wording = storeBizWording(industry)
        const question = def.id === 'products' ? wording.productsQuestion
          : def.id === 'customers' ? wording.customersQuestion
          : def.id === 'channel' ? wording.channelQuestion
          : def.question
        await say(`${prefix}${extra}${question}`)
        if (def.options?.length) {
          // ⛔ **一顆 primary 都不給**（守門測試 `agent-choice-order` 也會擋）：
          //    這幾題沒有「建議答案」——把某個選項染成主要動作，等於暗示那是對的，
          //    收上來的輪廓就會往那個選項偏。這跟「主要動作要醒目」不衝突：
          //    這一排根本沒有主要動作，只有互斥的事實。
          // ⭐ 最後那顆是**出口**（`D-89`）：選項列不完的人不該只能亂選一個；
          //    ⛔ 也不該給「其他」——那個字存下去會被原樣插進草稿。
          const picked = await askChoices([
            ...def.options.map(o => ({ label: o, value: o })),
            { label: '都不是，我自己講', value: FREE_ANSWER, escape: true },
          ])
          if (picked === FREE_ANSWER) {
            await say(def.freeAsk ?? '那你自己講講看？一句話就好。')
            const typed = await askInput({ inputType: 'text', placeholder: def.freePlaceholder ?? '', maxLength: STORE_PROFILE_VALUE_MAX })
            if (typed == null) continue
            answers[def.id] = typed
            // ⛔ 只記「怎麼答的」不記答案（選項沒列到他的＝`free`，那是選項該補的訊號）
            track('profile_answer', { field: def.id, mode: 'free' })
          }
          else {
            answers[def.id] = String(picked ?? '')
            track('profile_answer', { field: def.id, mode: 'option' })
          }
        }
        else {
          const placeholder = def.id === 'products' ? wording.productsPlaceholder : (def.placeholder ?? '')
          const typed = await askInput({ inputType: 'text', placeholder, maxLength: STORE_PROFILE_VALUE_MAX })
          if (typed == null) continue
          answers[def.id] = typed
          track('profile_answer', { field: def.id, mode: 'typed' })
        }
      }
    }

    // 網址：可跳過。⛔ 跳過的人不要再被追問——沒有網站是很正常的事。
    await say('最後給我一個<b>官網或商品頁的網址</b>，我自己去讀。沒有就跳過。')
    const siteUrl = await askInput({
      inputType: 'text',
      placeholder: '例：shop.example.tw',
      maxLength: 200,
      // ⚠️ `skipLabel` 要配 `skippable`，只給字不會長出那顆鈕
      skippable: true,
      skipLabel: '沒有網站',
    })
    track('site_given', { given: !!siteUrl })

    // 先存答案（⛔ 在讀網站之前存：讀網站可能失敗，五題的答案不該跟著陪葬）
    busy.value = true
    try {
      await apiFetch('/api/store-profile', { method: 'POST', body: { fields: answers } })
    }
    catch {
      await say('剛剛那幾題存起來的時候出了狀況——你答的內容我先留在畫面上，之後可以在「組織與 LINE」頁補。')
    }
    finally {
      busy.value = false
    }

    if (siteUrl) {
      busy.value = true
      try {
        const r = await apiFetch<{ jobId: string, status: string, error?: string }>('/api/store-profile/read-site', {
          method: 'POST',
          body: { siteUrl },
        })
        if (r.status === 'failed') {
          track('site_read', { result: 'rejected' })
          // ⛔ 讀不到要當場講：它是第一頁就撞到的錯（網址打錯、對方擋人），
          //    拖到最後才說等於讓他白等一段
          // ⚠️ 讀失敗的工作**不記 id**：揭曉那一刻不必再等它、也不必再講一次讀不到
          await say(`${escapeHtml(r.error || '這個網址我讀不到')}。之後在「組織與 LINE」頁可以換一個再試。`)
        }
        else {
          siteJobId = r.jobId
          // ⚠️ `D-88` 拆兩趟之後這句**一定要跟著改**：讀網站不再躲在接 LINE 的等待時間裡，
          //    下一步就是等它讀完。⛔ 不可以再說「先把 LINE 接起來」——那是上一版的順序。
          await say('收到 ✓ 我現在就去讀，大概不用一分鐘。')
        }
      }
      catch (e: unknown) {
        track('site_read', { result: 'error' })
        const msg = (e as { data?: { statusMessage?: string } })?.data?.statusMessage || ''
        await say(msg ? escapeHtml(msg) : '這個網址現在讀不到，之後可以在「組織與 LINE」頁再試一次。')
      }
      finally {
        busy.value = false
      }
    }

    return 'done'
  }

  // ── 五樣草稿（`D-85` / `C-221`）────────────────────────────────
  //
  // ⛔ **全部走既有端點**（建腳本／存 AI 設定／建標籤），不另刻寫入路徑：
  //    那些端點各自帶著自己的守門（例如「只准有一條啟用中的加好友流程」會回 409），
  //    另刻一份等於把那些規則重寫一遍，遲早一邊擋一邊放行。
  // ⛔ **一步失敗不中斷**：這幾樣彼此獨立（歡迎訊息沒建成，語氣照樣值得存），
  //    跟「一檔活動」精靈那種「標籤沒建成就別建活動」的鏈式依賴不同。
  //    但**失敗時一定要點名已經建好的東西**，否則人會重跑一次而多出重複的標籤。

  /**
   * 草稿卡上他改過的內容（`D-94`：草稿一開始就是可以改的框）。key＝那張卡的 entry id。
   * ⚠️ 按「採用」時用的是**這一份**，不是範本原文——他改了卻寫出去原文，是最糟的那種假按鈕。
   */
  const draftEdits = new Map<number, { body?: string, tags?: { name: string, why: string, on: boolean }[] }>()

  /** 頁面轉交的「草稿框內容變了」 */
  function onDraftInput(p: { entryId: number, body?: string, tags?: { name: string, why: string, on: boolean }[] }) {
    const prev = draftEdits.get(p.entryId) ?? {}
    draftEdits.set(p.entryId, {
      ...prev,
      ...(p.body != null ? { body: p.body } : {}),
      ...(p.tags ? { tags: p.tags } : {}),
    })
  }

  /** 這一趟真的建成了哪幾樣（成績單、痛點回扣句都要看它——⛔ 講「剛剛採用的」之前先確認真的有） */
  const builtKeys = new Set<StoreDraftKey>()

  /**
   * 「換個說法」（`D-89` ②）每張卡的狀態。key＝那張卡的 entry id。
   * ⛔ `decided`：他按了採用／先不要之後才回來的那一版**一律丟掉**——
   *    否則慢回來的結果會把已經定案的卡洗回可編輯、而寫出去的是另一版。
   */
  const rewordCards = new Map<number, {
    key: StoreDraftKey
    base: Extract<AgentMsg, { kind: 'store-draft' }>
    body: string
    used: number
    rev: number
    busy: boolean
    decided: boolean
  }>()

  /** 頁面轉交的「按了換個說法」 */
  async function onDraftReword(p: { entryId: number, body: string }) {
    const rc = rewordCards.get(p.entryId)
    if (!rc || rc.decided || rc.busy || rc.used >= REWORD_MAX_PER_CARD) return
    const render = (extra: { busy?: boolean, note?: string } = {}) => updateMsg(p.entryId, {
      ...rc.base,
      editable: 'text',
      body: rc.body,
      reword: { rev: rc.rev, left: REWORD_MAX_PER_CARD - rc.used, ...extra },
    })
    rc.busy = true
    render({ busy: true })
    try {
      const r = await apiFetch<{ body: string }>('/api/store-profile/reword', {
        method: 'POST',
        body: { key: rc.key, current: p.body },
      })
      if (rc.decided || isDisposed()) return
      rc.used++
      rc.rev++
      rc.body = r.body
      // ⚠️ 按「採用」用的是這一份（同他自己改字的那條路）
      draftEdits.set(p.entryId, { ...(draftEdits.get(p.entryId) ?? {}), body: r.body })
      track('draft_reword', { key: rc.key, ok: true, n: rc.used })
      // ⛔ 換好了不另外講一句（框裡的字換了就是結果）；**用完了才要講**，不可以變成按了沒反應
      render(rc.used >= REWORD_MAX_PER_CARD ? { note: `已經換了 ${REWORD_MAX_PER_CARD} 次；框裡的字還是可以直接改。` } : {})
    }
    catch (e: unknown) {
      if (rc.decided || isDisposed()) return
      track('draft_reword', { key: rc.key, ok: false, n: rc.used })
      const msg = (e as { data?: { statusMessage?: string } })?.data?.statusMessage
      render({ note: msg || '這次沒換成，框裡的字沒動——再按一次試試。' })
    }
    finally {
      rc.busy = false
    }
  }

  async function applyOneDraft(d: StoreDraft): Promise<DraftApplyStep> {
    const label = d.title
    try {
      if (d.key === 'welcome') {
        const { nodes, rootNodeId } = buildFollowWelcomeScript({ kind: 'text', text: d.body }, {
          triggerId: crypto.randomUUID(),
          replyId: crypto.randomUUID(),
        })
        await apiFetch('/api/ai/scripts/create', {
          method: 'POST',
          body: { name: '加好友歡迎', enabled: true, nodes, rootNodeId },
        })
        return { key: d.key, label, status: 'done' }
      }
      if (d.key === 'tone') {
        await apiFetch('/api/ai/settings', { method: 'PUT', body: { systemPrompt: d.body } })
        return { key: d.key, label, status: 'done' }
      }
      if (d.key === 'tags') {
        // ⛔ 代號由系統自己生（`D-83`③ 拍板），而且**撞號要自動換下一組**——
        //    畫面上沒有那一格，丟「請換一個代號」給他是做不到的事。
        const taken: string[] = []
        let built = 0
        for (const t of d.tags ?? []) {
          const code = suggestTagCode(t.name, taken)
          taken.push(code)
          await apiFetch('/api/tag/create', {
            method: 'POST',
            body: { code, name: t.name, category: 'custom', description: t.why },
          })
          built++
        }
        return built > 0
          ? { key: d.key, label: `建議的分眾標籤 ${built} 顆`, status: 'done' }
          : { key: d.key, label, status: 'skipped' }
      }
      return { key: d.key, label, status: 'skipped' }
    }
    catch (e: unknown) {
      const msg = (e as { data?: { statusMessage?: string } })?.data?.statusMessage
        || (e as { statusMessage?: string })?.statusMessage
        || '沒有成功'
      return { key: d.key, label, status: 'failed', error: String(msg).slice(0, 120) }
    }
  }

  /** 草稿那一段的逐樣結果（成績單要列得出「哪幾樣」，⛔ 不是只寫數字） */
  let draftSteps: DraftApplyStep[] = []

  async function stepStoreDrafts(profile: StoreProfileDoc) {
    draftSteps = []
    if (!canBuildDrafts(profile)) return
    const shopName = workspaceList.value.find(w => w.workspaceId === wid.value)?.name || ''
    const drafts = buildStoreDrafts({
      shopName,
      profile,
      today: taipeiDate(),
      pagesRead: profile.siteRead?.pagesRead ?? 0,
    })
    if (!drafts.length) return

    const adoptable = drafts.filter(d => d.kind === 'adopt').length
    // ⛔「按採用才會生效」這句留著：不留的話他會以為東西已經對客人發出去了（08-14 紅線）
    // ⚠️ 數字吃 `adoptable`（真的要他決定的那幾樣）——說「準備了 4 樣」卻只有 3 樣要按，他會一直找第 4 顆
    await say(`我照你講的準備了 <b>${adoptable} 樣</b>，按「採用」才會生效。`)

    for (const d of drafts) {
      /**
       * ⭐ `D-94`：**一開始就是可以改的**（輸入框自己就是說明；少按一次「改一下」）。
       * ⛔ 標籤不給大文字框：它是三顆名字（結構），開 textarea 等於請他把「名字——說明」的格式改壞。
       */
      const editable = d.kind !== 'adopt' ? undefined : d.key === 'tags' ? 'tags' as const : 'text' as const
      const base = {
        kind: 'store-draft' as const,
        title: d.title,
        where: d.where,
        body: d.body,
        ...(d.note ? { note: d.note } : {}),
        variant: d.kind,
      }
      // ⭐ `D-89`：只有歡迎訊息與語氣給「換個說法」（⛔ 標籤不給，理由見 `REWORDABLE_DRAFTS`）
      const canReword = editable === 'text' && REWORDABLE_DRAFTS.includes(d.key)
      const cardId = card({
        ...base,
        ...(editable ? { editable } : {}),
        ...(d.key === 'tags' && d.tags ? { tags: d.tags.map(t => ({ ...t, on: true })) } : {}),
        ...(canReword ? { reword: { rev: 0, left: REWORD_MAX_PER_CARD } } : {}),
      })
      if (canReword) rewordCards.set(cardId, { key: d.key, base, body: d.body, used: 0, rev: 0, busy: false, decided: false })
      if (d.kind === 'info') continue

      const c = await askChoices([
        { label: '採用', value: 'yes', primary: true },
        { label: '先不要', value: 'no', escape: true },
      ])
      const rc = rewordCards.get(cardId)
      if (rc) rc.decided = true
      const reworded = rc?.used ?? 0

      // 他最後決定的那一版（沒動過就是範本原文）
      const edit = draftEdits.get(cardId)
      const finalBody = (edit?.body ?? d.body).trim()
      const finalTags = d.key === 'tags'
        ? (edit?.tags ?? (d.tags ?? []).map(t => ({ ...t, on: true })))
            .filter(t => t.on && t.name.trim())
            .map(t => ({ name: t.name.trim(), why: t.why }))
        : undefined
      const shownBody = finalTags ? finalTags.map(t => `${t.name}——${t.why}`).join('\n') : finalBody
      /**
       * 他有沒有親手動過（`D-94` 要驗「一開始就能改」到底有沒有人改）。
       * ⚠️ 比的是**機器給的最後一版**（換過說法就是換出來那一版）：換說法不算他改的，那個另記 `reworded`
       */
      const edited = finalTags
        ? finalTags.map(t => t.name).join('|') !== (d.tags ?? []).map(t => t.name.trim()).join('|')
        : finalBody !== (rc?.body ?? d.body).trim()

      // 改到空的（字刪光、標籤全取消勾）＝這一樣不建，⛔ 不可以照樣送一個空的出去
      const emptied = c === 'yes' && (finalTags ? finalTags.length === 0 : !finalBody)
      if (c !== 'yes' || emptied) {
        track('draft_decision', { key: d.key, decision: emptied ? 'emptied' : 'declined', edited, reworded })
        draftSteps.push({ key: d.key, label: d.title, status: 'declined' })
        updateMsg(cardId, {
          ...base,
          state: 'declined',
          // ⛔ `D-89` 修掉的假承諾：原本寫「之後在『組織與 LINE』頁的輪廓卡還找得到」，
          //    但那張卡上根本沒有這幾樣。講一條**真的走得到**的路。
          stateText: emptied
            ? '內容是空的，這一樣先不建。'
            : `先不要。這一樣現在不會建立，之後想要可以到「${d.where}」自己加。`,
        })
        continue
      }

      busy.value = true
      const r = await applyOneDraft({ ...d, body: finalBody, ...(finalTags ? { tags: finalTags } : {}) })
      busy.value = false
      draftSteps.push(r)
      track('draft_decision', { key: d.key, decision: r.status === 'done' ? 'adopted' : 'failed', edited, reworded })
      if (r.status === 'done') builtKeys.add(d.key)
      // ⚠️ 決定完就把框收回唯讀（不帶 editable），內容換成**他最後決定的那一版**
      updateMsg(cardId, {
        ...base,
        body: shownBody,
        state: r.status === 'done' ? 'adopted' : 'failed',
        stateText: r.status === 'done'
          ? `已採用 ✓ 存在「${d.where}」，之後隨時可以改`
          : `沒有成功——${r.error}`,
      })
    }

    // ⛔ 有東西沒成時**一定要點名已經建好的**：少了這一段，人會以為什麼都沒發生而重跑，
    //    於是多出重複的標籤與重複的加好友腳本——而且他不會知道。
    // ⚠️ 全部順利時不另外講一句「都幫你準備好了」（v74：那句沒有新資訊，成績單會列）
    const outcome = summarizeDraftApply(draftSteps)
    if (outcome.leftovers.length) {
      await say(`${escapeHtml(outcome.headline)}<br>⛔ <b>不要整個重來</b>：${escapeHtml(outcome.leftovers.join('、'))}，重跑會多出重複的東西。沒成的那幾樣到後台單獨補就好。`)
    }
  }

  /*
   * ⛔ 2026-09-26（`C-250`）`stepConnectGate()`（「接上 LINE（約 7 分鐘）／我還沒有連線資訊，先進後台」）整支移除：
   *    老闆 09-25「是否打造 MiniMe 之後直接進後台，之後再讓他自己決定什麼時候要串接 LINE」。
   *    打造完一律進後台；接 LINE 只剩後台的入口（紅帶／小幫手英雄卡／組織頁），走 `?workspaceId=` 那一趟。
   *    ⚠️ 推翻 `D-88`「第一段結尾留『現在就接 LINE』當主要鈕」。
   */

  /**
   * 揭曉「我對你的店的認識」＋檢查點（`C-250`：從「接線成功那一刻」**搬到打造這一趟**）。
   * ⭐ 原本答完五題什麼都拿不到，要等接完 LINE 才看得到——選「先進後台」的人永遠等不到。
   *
   * ⛔ 三件事不可以妥協：
   *   ① 讀網站還沒跑完就**等它一下**（有上限），別在他眼前畫一張少一半的卡；
   *      ⚠️ 拆兩趟之後讀網站不再躲在接 LINE 的等待時間裡——所以要講「正在讀」、讓他看得到在等什麼；
   *   ② 等不到也要照樣揭曉，並且**講出來還在讀**——空等比少一格糟（G-10 的教訓：不能有「等不到又沒有下一步」）；
   *   ③ 猜的要看得出是猜的（卡片分組：「我猜的 N 項，幫我看一下對不對」）。
   * ⭐ 檢查點（`D-91`）**擋在草稿前面**：草稿是照輪廓生的，先生完再讓他改，下面那幾樣就全是照舊資料做的。
   */
  async function revealStoreProfile(opts: { editable?: boolean } = {}) {
    let stillReading = false
    let statusId: number | null = null
    if (siteJobId) {
      statusId = card({ kind: 'status', state: 'pending', text: '正在讀你的網站…通常不用一分鐘' })
      busy.value = true
      // ⛔ `pollUntil` 本身沒有上限（它是給「等客人傳訊息」用的，那件事可以等一整天）。
      //    這裡一定要自己封頂：讀網站卡住時，人會坐在一個沒有任何按鈕的畫面前面。
      const poll = pollUntil<{ status: string }>(async () => {
        const p = await apiFetch<{ status: string }>(`/api/store-profile/read-site/${siteJobId}`)
        return p.status === 'running' ? null : p
      }, SITE_JOB_POLL_MS)
      try {
        const done = await Promise.race([
          poll.promise,
          new Promise<null>(resolve => setTimeout(() => resolve(null), SITE_JOB_MAX_WAIT_MS)),
        ])
        stillReading = !done
      }
      catch { stillReading = true /* 等不到就照樣揭曉 */ }
      finally {
        poll.stop()
        busy.value = false
      }
    }

    let profile: StoreProfileDoc | null = null
    try {
      const r = await apiFetch<{ profile: StoreProfileDoc }>('/api/store-profile')
      profile = r.profile
    }
    catch {
      // ⛔ 查不到就不要畫卡：畫一張空的等於說「我什麼都不知道」，而那不是真的
      if (statusId != null) updateMsg(statusId, { kind: 'status', state: 'skipped', text: '網站的結果這次拿不到，之後在「組織與 LINE」頁看得到' })
      return
    }
    if (statusId != null) {
      const sr = profile?.siteRead
      // ⭐ `stillReading`＝20 秒等不到：這個數字高就是「讀網站太慢、揭曉畫了一張少一半的卡」
      track('site_read', {
        result: stillReading ? 'still_reading' : sr && sr.status !== 'failed' ? 'ok' : 'failed',
        pages: sr?.pagesRead ?? 0,
      })
      updateMsg(statusId, stillReading
        ? { kind: 'status', state: 'skipped', text: '網站還在讀，先給你看已經知道的——讀完會補進「組織與 LINE」頁' }
        : sr && sr.status !== 'failed'
          ? { kind: 'status', state: 'ok', text: describeSiteRead(sr) }
          : { kind: 'status', state: 'fail', text: describeSiteRead(sr) })
    }
    if (!profile || filledFieldCount(profile) === 0) return
    revealedProfile = profile

    // ⛔ 這裡原本還有「猜的都標出來了，不對的直接改」——`D-93` 分組之後由**組名**扛
    //    （「我猜的 N 項，幫我看一下對不對」），按鈕上又寫著「修改」，同一個指示不講第二遍。
    const siteOk = !stillReading && (profile.siteRead?.pagesRead ?? 0) > 0
    // ⭐ 讀到的頁接著整理成「等你看過」的卡（`C-250`③）：他看輪廓、採用草稿的這一兩分鐘就在背景整理
    if (siteOk) startSiteCardsPush()
    await say(siteOk ? '你的網站我讀完了。這是我認識的你。' : '這是我認識的你。')
    profileCardId = showProfileCard(profile, { grouped: true, editable: opts.editable !== false })
    // ⛔ 按鈕上就寫著「都對了，繼續」，⛔ 不再多一句「有不對的就按旁邊的改，改完按繼續」
    await askChoices([{ label: '都對了，繼續', value: 'ok', primary: true }])
    profileCardId = null
  }

  /** 揭曉那張卡的 id——就地修改時要重畫的就是它（檢查點過了之後就不再接受修改事件） */
  let profileCardId: number | null = null

  // ── 讀到的網站頁 → 等你看過的卡（`C-250`③）────────────────────────
  //
  // ⛔ 不在精靈裡讓他等（`D-90` 已嫌太長）：揭曉那一刻開始在背景推，他看輪廓、採用草稿的同時整理。
  //    一步最多 2 頁、一步約 20 秒；推不完的由知識庫頁與排程接手（伺服器有租約，不會重複整理）。

  /** 目前整理到哪（每推一步就重抓一次） */
  const siteCards = {
    total: 0,
    stillWorking: false,
    sample: null as null | { q: string, a: string },
  }
  let siteCardsRun: Promise<void> | null = null
  /** 第一步做完（或確定沒東西可做）的那一刻；成績單前等它，最多等 20 秒 */
  let siteCardsFirstStep: Promise<void> = Promise.resolve()
  let siteCardsStopped = false

  /**
   * @param withSample 要不要順便拿一張當範例（⚠️ 只有要畫那張說明卡時才讀全文；推整理的迴圈裡只數張數）
   */
  async function refreshSiteCards(withSample = false) {
    const r = await apiFetch<{
      total: number
      pages?: Array<{ cards: Array<{ title: string, content: string, questions: string[] }> }>
      generating: { status: string } | null
    }>(withSample ? '/api/ai/knowledge/drafts' : '/api/ai/knowledge/drafts?summary=1')
    siteCards.total = r.total
    siteCards.stillWorking = r.generating?.status === 'queued' || r.generating?.status === 'running'
    if (withSample) {
      const c = r.pages?.[0]?.cards[0]
      siteCards.sample = c ? { q: c.questions[0] || c.title, a: c.content } : null
    }
  }

  function startSiteCardsPush() {
    if (siteCardsRun) return
    let markFirst!: () => void
    siteCardsFirstStep = new Promise<void>((resolve) => { markFirst = resolve })
    siteCardsRun = (async () => {
      try {
        for (let i = 0; i < 8 && !siteCardsStopped; i++) {
          const r = await apiFetch<{ cards: { status: string, error?: string } | null }>('/api/ai/knowledge/drafts/advance', { method: 'POST' }).catch(() => null)
          await refreshSiteCards().catch(() => {})
          markFirst()
          const st = r?.cards?.status
          // 做完／失敗／額度擋下／根本沒有要整理的 → 停（⛔ 不空轉燒請求）
          if (!st || st === 'done' || st === 'failed' || r?.cards?.error) break
          // ⚠️ 別人正拿著租約（排程或知識庫頁在推）時 advance 會馬上回 running：等久一點再問（code review 抓到原本一圈接一圈）
          await new Promise(res => setTimeout(res, st === 'running' ? 6000 : 800))
        }
      }
      finally {
        markFirst()
      }
    })()
  }

  /**
   * 草稿之後、成績單之前：告訴他網站整理成了幾張卡、**給他看一張**（`C-250`③，示意頁 v80）。
   * ⭐ 範例本身就是「知識卡是什麼」的定義（老闆兩輪看不懂那次，缺的是範例不是解釋）。
   * ⛔ 這一樣**不用他決定**（`info`，同月曆那張的規矩）：要不要收是在知識庫一張一張決定的。
   * ⛔ 沒讀到網站＝這一步整段不出現。
   */
  async function stepSiteCardsInfo(profile: StoreProfileDoc | null) {
    if (!siteCardsRun) return
    await Promise.race([siteCardsFirstStep, new Promise(r => setTimeout(r, 20_000))])
    // 要畫一張範例卡：這一刻才讀全文（⛔ 推整理的迴圈裡只數張數）
    await refreshSiteCards(true).catch(() => {})
    const pagesRead = profile?.siteRead?.pagesRead ?? 0
    // ⚠️ 什麼卡都沒畫（整理不出卡）也要記：那是「讀到頁、卻一張卡都生不出來」的訊號
    track('site_cards_shown', {
      cards: siteCards.total,
      stillWorking: siteCards.stillWorking,
      shown: siteCards.total > 0 || siteCards.stillWorking,
    })
    const base = { kind: 'store-draft' as const, title: '知識庫：幫你整理好了', where: '知識庫', variant: 'info' as const }
    if (siteCards.total > 0 && siteCards.sample) {
      card({
        ...base,
        body: `我讀了你網站 ${pagesRead} 頁，整理成 ${siteCards.total} 張卡${siteCards.stillWorking ? '（剩下的頁還在整理）' : ''}。一張長這樣：\n　問：${siteCards.sample.q}\n　卡片寫：${siteCards.sample.a}`,
        note: '還沒進知識庫——在「知識庫」那一頁一張一張看過才算數。',
      })
    }
    else if (siteCards.stillWorking) {
      card({
        ...base,
        title: '知識庫：正在幫你整理',
        body: `我讀了你網站 ${pagesRead} 頁，正在整理成知識卡。`,
        note: '好了會在「知識庫」那一頁等你一張一張看過才算數。',
      })
    }
  }

  /** 輪廓卡的一整則訊息（揭曉與就地修改後重畫共用；⛔ 兩處各組一份，欄位名照型換的規則遲早會漏一邊） */
  function profileCardMsg(profile: StoreProfileDoc, opts: { grouped?: boolean, editable?: boolean } = {}) {
    const industry = profile.fields?.industry?.value ?? ''
    const rows = STORE_PROFILE_FIELDS.map((def) => {
      const f = profile.fields?.[def.id]
      return {
        fieldId: def.id,
        // 🔴 `D-99`：欄位名照型換（診所的卡上不寫「主打商品」「價格帶」）
        label: storeProfileLabelFor(def.id, def.label, industry),
        value: f?.value ?? '',
        hint: f?.value ? undefined : describeMissing(def, f?.missing),
        source: (f?.value ? (f.source ?? 'ai') : 'none') as 'owner' | 'ai' | 'conversation' | 'none',
        sourceText: f?.value ? STORE_PROFILE_SOURCE_LABELS[f.source ?? 'ai'] : '還沒有',
      }
    })
    const readNote = profile.siteUrl ? describeSiteRead(profile.siteRead) : ''
    const pages = profile.siteRead?.pagesRead ?? 0
    return {
      kind: 'store-profile' as const,
      rows,
      ...(opts.grouped
        // ⭐ 分組版不畫卡尾那行「讀到 N 頁」：出處餵進「我猜的」組名（出處要跟主張長在一起）
        ? { grouped: true, ...(pages > 0 ? { aiNote: `從你的網站 ${pages} 頁猜的` } : {}) }
        : (readNote ? { siteNote: readNote } : {})),
      ...(opts.editable ? { editable: true } : {}),
    }
  }

  /**
   * 畫一張輪廓卡。**反推與揭曉共用這一份**——
   * ⛔ 兩個地方各畫一次，來源徽章的規則遲早會在其中一邊漏掉。
   */
  function showProfileCard(profile: StoreProfileDoc, opts: { grouped?: boolean, editable?: boolean } = {}): number {
    return card(profileCardMsg(profile, opts))
  }

  /**
   * 頁面轉交的「輪廓卡某一格存起來」（`D-91` 就地可改）。
   * ⛔ 改完**來源要變成「你說的」**（伺服器那支一律標 owner）——他親手打的還標成「AI 推測」，
   *    等於把他的話講成猜的；而且那一格會當場跳到「你告訴我的」那一組，看得見「這一格現在算你說的」。
   * ⚠️ 存完一定要把輪廓換成**存回來的那一份**：下面的草稿是照 `revealedProfile` 生的。
   */
  async function onProfileEdit(p: { entryId: number, fieldId: string, value: string }) {
    if (p.entryId !== profileCardId || !revealedProfile) return
    if (!STORE_PROFILE_FIELDS.some(f => f.id === p.fieldId)) return
    busy.value = true
    try {
      const r = await apiFetch<{ profile: StoreProfileDoc }>('/api/store-profile', {
        method: 'POST',
        body: { fields: { [p.fieldId]: p.value } },
      })
      revealedProfile = r.profile
      updateMsg(p.entryId, profileCardMsg(r.profile, { grouped: true, editable: true }))
      // 哪一格最常被改＝AI 最常猜錯哪一格（`D-92` 四道防線要看的就是這個）
      track('profile_edit', { field: p.fieldId })
    }
    catch {
      // ⛔ 存不進去要講：畫面上看起來改好了、其實沒存，是這個專案最常吃虧的形狀
      await say('剛剛那一格沒存進去，再按一次「修改」試試；還是不行的話，之後在「組織與 LINE」頁也改得到。')
    }
    finally {
      busy.value = false
    }
  }

  async function stepWelcomeBack(line: LineStatus, setup: Partial<Record<SetupCapabilityId, SetupItemStatus>>) {
    const name = workspaceList.value.find(w => w.workspaceId === wid.value)?.name || ''
    await say(`歡迎回來${name ? `，「${escapeHtml(name)}」` : ''}！我們接著把 LINE 接完，做過的我會直接跳過。`)
    if (!line.tokenConfigured || !line.secretConfigured)
      progress.value = LINE_STEP.credentials
    else if (setup.firstMessageReceived !== 'done')
      progress.value = LINE_STEP.receive // 兩組連線資訊都在了 → 接收 LINE 訊息
    else
      progress.value = LINE_STEP.testMessage // 都做完了停在用手機測試那格，「上線完成」由 stepDone 點亮
  }

  async function stepHasOA() {
    // 2026-08-28 拍板：不加第三顆「不確定」鈕，改成當場點得到的連結——按鈕要多繞一趟才拿到答案。
    // 2026-09-02：原本「問題」與「不確定的話…」拆成兩則泡泡，一個問題佔兩顆；併成一則、
    // 問句放最後（緊接著下面的選項鈕）。⛔「同事／老闆申請的」那段不能刪，只能收起來——
    // 自己登入看到空列表就再建一個新帳號，好友得從頭加，代價比走錯流程大得多。
    // 2026-09-10 文案瘦身（示意頁落地）：「怎麼確認」整包收進 aside——資訊都在，
    // 只給不確定的人看。⛔ 主線行內連結歸零（主線動作＝連結卡、收合內＝行內），
    // 「列表是空的但同事說有」那段不能刪、只能收起來：自己登入看到空列表就再建一個新帳號，
    // 好友得從頭加，代價比走錯流程大得多。
    // ⚠️ 2026-09-26（`C-250`）拿掉「接下來，」：這一趟現在是他**隔一陣子從後台紅帶／小幫手進來**的，
    //    不是接在什麼後面。
    progress.value = LINE_STEP.credentials
    await say(
      '把你的 MiniMe 跟你的 <b>LINE 官方帳號</b>連在一起。<br><b>你已經有 LINE 官方帳號了嗎？</b>',
      { summary: '不確定有沒有、或列表是空的？', html: '打開後台看一眼就知道（下面一步一步看）。<br><b>列表是空的，但同事說有？</b>帳號多半是老闆或前同事用<b>他的</b> LINE 申請的，你自己登入會看到空列表。先問一聲比較快——自己再建一個新的，好友要從頭加。' },
    )
    // 2026-09-02 補圖：這是最早的分岔、答錯整條路白走，原本一張圖都沒有。
    // 2026-09-10 靜圖 → 步驟輪播：靜圖只演「列表長這樣」，沒演「先登入」——
    // 而卡在這一題的人有一半是還沒登入、看到空列表就以為自己沒有帳號。
    card({ kind: 'carousel', steps: ONBOARDING_CAROUSELS.accountList })
    card({ kind: 'link', label: '打開官方帳號後台', href: 'https://manager.line.biz/' })
    const c = await askChoices([
      { label: '有', value: 'yes', primary: true },
      { label: '還沒', value: 'no' },
    ])
    track('has_oa', { answer: c === 'no' ? 'no' : 'yes' })
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
          // 2026-09-10 補輪播：這一步原本**一張圖都沒有**，只有一顆連結就把人丟到
          // LINE 的行銷頁——而那一頁要先捲一段才看得到「免費開設帳號」，
          // 頁面更下面還有一個長得很像的 LINE 廣告申請入口。
          html: '先去申請一個 <b>LINE 官方帳號</b>，是<b>免費</b>的（下面一步一步看）。'
            + '<br>登入之後手機會收到一次驗證碼，然後填店名、Email、行業別，跟著畫面走就好。',
          aside: { summary: '我想用手機申請', html: 'LINE 自己那一頁寫著：用行動裝置的話<b>要先下載「LINE Official Account」App</b>，在 App 裡完成註冊。用電腦就不用裝。' },
          // ⛔ 2026-09-08 修死連結：`tw.linebiz.com/entry/` 已經 404（老闆點連結才發現，
          //    08-07 從日本入口改台灣時它還是活的）。正解是 `/account/`——那頁的
          //    「免費開設帳號」就是申請入口。⚠️ 這是**外部網址會自己腐爛**的第一個案例，
          //    所以同輪加了 `scripts/check-external-links.mjs`，別再靠使用者回報。
          href: 'https://tw.linebiz.com/account/',
          hrefLabel: '前往申請 LINE 官方帳號（台灣） ↗',
          carousel: ONBOARDING_CAROUSELS.signupEntry,
        },
        {
          html: '申請好之後還有一個小步驟：到官方帳號後台的「<b>設定 → Messaging API</b>」按「<b>啟用Messaging API</b>」——'
            + '按下去會<b>連跳三個小視窗，一路按下去就好</b>（下面一步一步看）。',
          aside: { summary: '為什麼要按啟用？', html: '沒按啟用的話，等一下要取得連線資訊的地方<b>找不到你的帳號</b>——那份清單只列出已經啟用的。' },
          href: 'https://manager.line.biz/',
          hrefLabel: '打開官方帳號後台 ↗',
          carousel: ONBOARDING_CAROUSELS.enableMessagingApi,
        },
      ], '')
      await askChoices([{ label: '都好了，繼續', value: 'ok', primary: true }])
    }
  }

/*
 * ⛔ `OAM_ENABLE_STEPS`（那句 `①…→②…→③…→④…` 的長字串）2026-09-10 移除：
 *    四個動作改由 `ONBOARDING_CAROUSELS.enableMessagingApi` 一步一格講，
 *    圖說跟分鏡綁在同一個地方。兩處呼叫點（「還沒有官方帳號」那條路、
 *    「清單裡沒看到我的帳號？」那條岔路）照舊共用同一支——走到這兩處的人都沒做過這件事。
 */

  /** 節點式教學的一步：一句話＋（選配）連結／步驟輪播／示意圖／岔路 */
  interface WalkNode {
    html: string
    href?: string
    hrefLabel?: string
    /**
     * 步驟輪播（一步一張圖）——**站外畫面要人照著找按鈕時的預設做法**。
     * 分鏡與圖說都在 `ONBOARDING_CAROUSELS`，這裡只指定用哪一支。
     * ⛔ 別再把 `①…→②…→③…` 塞回上面的 `html`：那正是輪播要取代的東西。
     */
    carousel?: readonly { readonly src: string, readonly caption: string }[]
    /** 單張示意圖（沒有步驟順序、整張都是要讀的內容時才用） */
    image?: string
    alt?: string
    /** 這一步的泡泡一出現就回報它的 id——之後想把畫面捲回這一則的人要接住它 */
    onFirstSaid?: (entryId: number) => void
    /**
     * 「下一步」那顆鈕的字樣。用在**要確認一個動作、不只是翻頁**的節點
     * （例：換後台那步＝「我打開了，下一步」）。
     * ⛔ 別整批換掉：翻頁就是翻頁，多數步驟不需要人宣示什麼。
     */
    nextLabel?: string
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
      // 🔴 2026-09-26 修（`C-250` 實走抓到）：原本寫成 `n.onFirstSaid?.(await say(...))`——
      //    **可選呼叫在函式不存在時連參數都不求值**，所以沒掛 `onFirstSaid` 的節點（除了接線
      //    教學第一則以外的全部）**泡泡從來沒出現過**，只剩連結卡跟輪播。09-10 起就是這樣。
      //    ⛔ 先 say、再把 id 交出去，兩步不可以合成一行。
      const saidId = await say(`${stepno}${n.html}`, n.aside)
      n.onFirstSaid?.(saidId)
      // 連結卡模板會自己補「 ↗」，字樣裡不能再帶（會變雙箭頭）
      if (n.href)
        card({ kind: 'link', label: (n.hrefLabel || '打開連結').replace(/\s*↗\s*$/, ''), href: n.href })
      // 連結在輪播上面：他得先「打開那個後台」才有畫面可以對照
      if (n.carousel)
        card({ kind: 'carousel', steps: n.carousel })
      if (n.image)
        card({ kind: 'image', src: n.image, alt: n.alt || '' })
      // 最後一步不再多一顆確認鈕（2026-08-19 老闆實測嫌多）：內容亮完直接返回，
      // 由呼叫端接手——貼鑰匙的直接亮輸入格、接線的直接回「幫我檢查」選單
      if (isLast)
        return 'done'
      while (true) {
        const options: AgentChoice[] = [{ label: n.nextLabel || '下一步', value: 'next', primary: true }]
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

  /**
   * 交棒到輸入格的那一句（2026-09-11）。
   *
   * **為什麼非有不可**：整條流程從頭到尾都是「按對話裡的按鈕」，選項鈕就長在最新那則旁邊；
   * 只有貼連線資訊這兩步，動作**換了位置**——跑到最下面那條輸入區，而且沒有任何一句話說。
   * 教學最後一格演的是「在 LINE 那邊按複製」，演完畫面靜止，人會繼續等下一張圖。
   * ⚠️ 它放在對話流的最後一則＝**緊貼著輸入框上緣**，眼睛不用跨區找；
   *    放在 `while` 迴圈裡＝每次教學重播完都會再講一次（那正是又要貼一次的時候）。
   * ⚠️ 👇 排在最前面跟「輪到你了」同一組＝**箭頭指方向、字講動作**，後面就不必再說「最下面」。
   * ⛔「按「送出」」不能省：那顆鈕在他從沒去過的輸入區，省掉就會有人貼完在那裡等。
   */
  const HANDOFF = '輪到你了 👇 把剛剛複製的那一串貼進<b>最下面的輸入框</b>，按「送出」。'

  async function stepToken(line: LineStatus) {
    if (line.tokenConfigured)
      return
    // 「都在 LINE Developers 後台」下一則教學第一句就會再講一次（2026-09-02 刪）
    // 2026-09-10：「這串是做什麼的」收進 aside——照著做不需要它，想知道的人點開就有
    //（判準同全流程：**照著做需要的字留在外面，解釋為什麼要這樣做的收進去**）
    await say(
      '接下來要從 LINE 拿<b>兩組連線資訊</b>。先拿第一組：<b>Channel Access Token</b>。',
      { summary: '這串是做什麼的？', html: '讓 MiniMe 可以用你的 LINE 官方帳號幫你傳訊息。' },
    )
    const how = await askChoices([
      { label: '教我一步步拿', value: 'walk', primary: true },
      { label: '我會拿，直接貼上', value: 'paste' },
    ])
    track('token_mode', { mode: how === 'walk' ? 'walk' : 'paste' })
    let taught = how === 'walk'
    if (taught)
      await walkTokenNodes()
    // 教學走完（或選直接貼）就亮輸入格；輸入格的後門「我想看教學」按了直接切教學，
    // 不再回選單繞一圈（2026-08-19 老闆實測：回選單要多按一次，泡泡疊一排很吵）
    //
    // ⛔ 2026-09-11 補上漏掉的一處：**走過教學的人不再給「再看一次教學」**——
    //    判準是「教學現在還在不在畫面上」，不是「他看過了嗎」。聊天記錄不會消失，
    //    走過教學的人教學就在輸入格正上方（量過：100% 可見、距輸入格 168px），
    //    而按下去會從第一則重走、還要再按一次「下一步」，聊天記錄從 1,233px 長到 1,815px。
    //    這條規則 `redoKeyFlow`（`taught ? undefined : …`）與第二組的輸入格早就這樣做了，
    //    只有這裡沒跟上——而第一組的輸入格正是當初點名的那一處。
    // ⛔ 走「我會拿，直接貼上」快路的人**照舊要給**：那是他唯一的教學入口，
    //    按完教學就在上面、這顆鈕下一圈自然消失。
    while (!line.tokenConfigured) {
      await say(HANDOFF)
      const ok = await askAndSaveToken(line, { escapeLabel: taught ? undefined : '等等，我想看教學' })
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
          // ⚠️ 登入那一格框的是**整組三顆登入鈕**不是單顆——08-19 拍板「登入頁不圈按鈕」
          // 的理由（圈哪顆都會誤導用其他方式登入的人）照樣守住，文案也維持
          // 「用你平常的方式」不指定。
          // 2026-09-10：兩個動作的字搬進輪播圖說，泡泡只留「這是什麼、為什麼要去那裡」。
          html: '打開 <b>LINE Developers</b>——它跟官方帳號後台是<b>同一個登入</b>。<br>進去之後選你的官方帳號：<b>同名卡片可能有兩張</b>，認卡片下面<b>寫著</b>「Messaging API」小字的那張，點進去。',
          // 2026-09-02：兩個後台的差別原本要等到第 20 幾則（關自動回應）才講，但人從這裡
          // 就開始在兩個後台之間跳了——會在錯的後台找 Messaging API 分頁找到懷疑人生
          // ⚠️ 2026-09-06 分工整個變了（第二組連線資訊與貼網址都搬到中文後台），這段話跟著改
          // 「要我登入？」跟「怎麼有兩個後台」是同一刻會冒出的兩個疑問，合成一則收合
          aside: { summary: '要我登入？LINE 怎麼有兩個後台？', html: '登入<b>用你平常的方式</b>就可以；<b>第一次用</b>會先請你填開發者名稱和 Email，填完就進得去。<br>兩個後台都會用到，分工很清楚：<br><b>LINE Developers</b>＝<b>只用來拿第一組連線資訊</b>，也就是現在這個，做完就不用再回來了。<br><b>LINE 官方帳號後台</b>＝<b>後面全部</b>——第二組連線資訊、貼網址、把回應方式設好。' },
          href: 'https://developers.line.biz/console/',
          hrefLabel: '打開 LINE Developers ↗',
          carousel: ONBOARDING_CAROUSELS.consoleChannel,
          detour: {
            label: '清單裡沒看到我的帳號？',
            run: async () => {
              // ⚠️ 跟「還沒有官方帳號」那條路是**同一件事**，用同一支輪播——
              //    走到這裡的人也從來沒做過，不是「回去再看一眼」，不能只給一張「按這裡」的靜圖
              await say(
                '那是還沒啟用的關係。到官方帳號後台的「<b>設定 → Messaging API</b>」按「<b>啟用Messaging API</b>」——'
                // ⚠️ 2026-09-11 補「回去」那半句：這條岔路是**另一個方向的換後台**——把人送去
                //    官方帳號後台辦一件事，辦完要自己走回 LINE Developers。原本只說「就會出現在
                //    剛剛的清單裡」，沒說要回哪個分頁、也沒說清單不會自己更新。
                + '按下去會<b>連跳三個小視窗，一路按下去就好</b>（下面一步一步看）。<br>啟用完，<b>回到 LINE Developers 那個分頁</b>重新整理一次，清單裡就有了。',
                // ⚠️ 走到這條岔路的人有兩種：**有帳號但沒啟用**（多數）、以及**根本還沒申請**。
                //    後者按「啟用」會發現連後台都進不去，卻沒有任何地方告訴他要先申請——
                //    所以那條路的入口收在這裡，不佔多數人的版面。
                { summary: '我連 LINE 官方帳號都還沒申請', html: '那要先申請一個，是<b>免費</b>的（下面那張卡就是入口）。申請好再回來按啟用。' },
              )
              // 上下兩張卡，順序照事情發生的先後：先申請、才有帳號可以啟用
              card({ kind: 'link', label: '前往申請 LINE 官方帳號（台灣）', href: 'https://tw.linebiz.com/account/' })
              card({ kind: 'link', label: '打開官方帳號後台', href: 'https://manager.line.biz/' })
              card({ kind: 'carousel', steps: ONBOARDING_CAROUSELS.enableMessagingApi })
            },
          },
        },
        {
          // 老闆拍板：切分頁→捲到底→發鑰匙→複製是一氣呵成的動作，合成一節點。
          // 2026-09-10 循環動畫 → 步驟輪播：三個動作的字搬進圖說，一格配一句。
          // 「捲到最下面」併在第 2 格的圖說裡——那是捲動不是停格，不值得自己一步。
          html: '進到那張卡之後，要把 <b>Channel access token</b> 發一組出來再整串複製。',
          // 2026-09-06 換掉原本的「第二把鑰匙在哪？」——第二組已經不在隔壁分頁了（搬到中文後台），
          // 那句話會把人帶錯地方。改成擋另一個真實情況：發過的帳號按鈕寫的是 Reissue。
          aside: { summary: '我的按鈕寫的是「Reissue」？', html: '那代表這個帳號以前發過一次，按下去會<b>重新發一組新的</b>、舊的當場失效。如果舊的沒有別的地方在用，按下去就可以；不確定的話先問一下之前設定的人。' },
          carousel: ONBOARDING_CAROUSELS.getToken,
        },
      ], '我拿到了，直接貼上')
  }

  async function stepSecret(line: LineStatus) {
    if (line.secretConfigured)
      return
    // ⛔ 2026-09-10 刪掉這裡的開場泡泡：它講的三件事全部有更好的去處——
    //    「這是第二組 Channel Secret」下一則教學的第一句就講（而且順帶交代要換後台）、
    //    「用途是確認訊息真的來自 LINE」收進那一則的 aside、
    //    「加油快完成了，剩下貼網址跟測試」是**進度條已經在說的事**（同開場白那條理由）。
    //    留著就是在教學正上方多一則沒有動作的泡泡，把圖又往下推一段。
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
      await say(HANDOFF)
      const ok = await askAndSaveSecret(line, { escapeLabel: '回上一步：重貼第一組' })
      if (ok)
        break
      // ⛔ 換成功時不再補「第一組換好了 ✓ 回到第二組」：`askAndSaveToken` 已經說了
      //    「換好了 ✓ 這組是「店名」的連線資訊。」，而「回到第二組」由下面重播的教學本身講
      //    （它第一句就是「接下來拿第二組連線資訊」）。取消的那句也已經收在 `redoKeyFlow` 裡。
      await redoKeyFlow(line, 'token', '不換了，回來貼第二組')
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
        // ⛔ 2026-09-11 拆成兩步（使用者：「有些人會以為還在原本的後台」）：
        //    **換後台自己要一刀**——原本「換到另一個後台」只是第一則泡泡的後半句，
        //    底下緊接著就是「點右上角設定」的輪播，而那顆「設定」在**兩個後台都有**：
        //    人留在 LINE Developers 照著做，一路做得下去，錯要到最後接不通才爆。
        //    ⚠️ 這**不是**推翻 09-02 的「開後台不值得自己一步」：那講的是**第一次開**
        //       （他本來就不在任何後台，沒有搞混的對象）。判準是「**跟上一步不同才切**」。
        //    ⚠️ 這一步**刻意不放輪播**（使用者 09-11）：它唯一要傳達的是「換後台了」，
        //       而自動播放的圖會把眼睛拉過去、那張圖又跟「換了地方」毫無關係，
        //       強調反而被圖蓋掉。「先點進你的帳號」只有一個動作，一句話講得完。
        //    ⚠️ 強調用三層、都不加句子：琥珀徽章（第一眼）＋兩邊並排的對照（指名道姓比
        //       「不在剛剛那個後台」硬）＋按鈕字樣改成要他宣示「我打開了」。
        //    ⛔ 不要再加「（中文那個）」：09-07 老闆拍板「不要解釋英文／中文哪個後台，越解釋越糊塗」。
        html: '<span class="agm-flag">換後台</span>剛剛是 <b>LINE Developers</b>，這一步換到 <b>LINE 官方帳號後台</b>——第二組連線資訊在那裡。<br>用下面的連結打開，在帳號一覽<b>點進你的帳號</b>。',
        aside: { summary: '剛剛那個後台要關掉嗎？', html: '不用關，但<b>不會再回去了</b>——LINE Developers 只用來拿第一組。' },
        href: 'https://manager.line.biz/',
        hrefLabel: '打開官方帳號後台 ↗',
        nextLabel: '我打開了，下一步',
      },
      {
        // 2026-09-10：三個動作與「別按到 Channel ID」的警語都搬進輪播圖說（第 3 格）
        html: '到了之後，要把<b>第二組連線資訊：Channel Secret</b> 整串複製起來。',
        aside: { summary: '這串是做什麼的？', html: '幫忙確認收到的訊息真的來自 LINE，不是別人假冒的。' },
        carousel: ONBOARDING_CAROUSELS.channelSecret,
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
  async function askAndSaveToken(line: LineStatus, opts: { escapeLabel?: string, redo?: boolean } = {}): Promise<boolean> {
    while (true) {
      const v = await askInput({
        inputType: 'secret',
        // 重貼時說「新的」：輸入格是全流程唯一分不出「第一次貼」與「換一把」的地方
        placeholder: opts.redo ? '貼上新的 Channel Access Token' : '貼上 Channel Access Token',
        // 後門：一開始選「直接貼上」的人，對話裡沒有教學也叫不出來——輸入格不能是死路
        skippable: !!opts.escapeLabel,
        skipLabel: opts.escapeLabel,
        validate: t => t.length < 20 ? '這串看起來太短了，Channel Access Token 是很長的一串，請整串複製過來。' : null,
      })
      if (v == null)
        return false
      const check = await checkToken(v)
      if (check?.valid === false) {
        // ⭐ 貼錯的次數：金鑰那道牆到底卡在「找不到」還是「貼錯」，看這個分得出來
        track('key_saved', { key: 'token', ok: false, redo: !!opts.redo })
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
      track('key_saved', { key: 'token', ok: true, verified: check?.valid === true, redo: !!opts.redo })
      // 問不到（check 是 null，或 valid 是 null）就只說存好了——不假裝驗過
      if (check?.valid === true && check.displayName) {
        await say(opts.redo
          ? `換好了 ✓ 這組是「<b>${escapeHtml(check.displayName)}</b>」的連線資訊。`
          : `收到 ✓ 這組是「<b>${escapeHtml(check.displayName)}</b>」的連線資訊，我已經幫你存好了！`)
      }
      else {
        await say(opts.redo ? '換好了 ✓' : '收到 ✓ 已經幫你存好。')
      }
      return true
    }
  }

  /** 收第二組連線資訊。⚠️這組沒辦法單獨驗真假（LINE 沒有這種 API），只能靠接線測試才驗得出來 */
  async function askAndSaveSecret(line: LineStatus, opts: { escapeLabel?: string, redo?: boolean } = {}): Promise<boolean> {
    while (true) {
      const v = await askInput({
        inputType: 'secret',
        placeholder: opts.redo ? '貼上新的 Channel Secret' : '貼上 Channel Secret',
        skippable: !!opts.escapeLabel,
        skipLabel: opts.escapeLabel,
        // ⛔ 2026-09-10 修：這句一直指著 **LINE Developers 的 Basic settings**，
        //    但 09-06 整段已經改道到官方帳號後台了——教學把人帶去 A、貼錯時的提示卻叫他回 B，
        //    而 B 那頁的 Channel secret **同名卡有兩張**，正是改道要消滅的那個雷。
        validate: t => t.length < 10 ? '這串看起來太短了，請回到官方帳號後台的「設定 → Messaging API」整串複製 Channel secret。' : null,
      })
      if (v == null)
        return false
      const ok = await apiRetry(
        () => apiFetch('/api/admin/line-workspace', { method: 'PUT', body: { channelSecret: v } }),
        { failText: '存檔失敗' },
      )
      if (ok !== null) {
        line.secretConfigured = true
        track('key_saved', { key: 'secret', ok: true, redo: !!opts.redo })
        // ⚠️ 第二組沒辦法當場驗真假，所以重貼時只能說「換好了」——⛔ 不要加「✓ 已確認」
        //    之類的字，那會變成又一次「說你設好了但其實沒有」
        if (opts.redo)
          await say('換好了 ✓')
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
    progress.value = LINE_STEP.testMessage
    // ⛔ 2026-09-11 改寫（使用者：「這塊也是會讓人卡住的地方，大家到這裡會不知道要做什麼」）。
    //    原本那一句「拿手機加你的 LINE 官方帳號好友，隨便傳一句話給它」三個病全中：
    //    ① **動作換到另一台裝置**——前面每一步都在這個畫面上按鈕或去另一個分頁，這一步突然要拿
    //       手機，而畫面上唯一的東西是一張在轉圈、不能按的等待卡。
    //    ② **兩個動作寫成一句話**：加好友＋傳訊息。⚠️ 而後端**只認真的訊息**（加好友寫的是
    //       traceOnly 的 customer_action、不會蓋 lastPeerActivityAt）——「加完好友就坐在那裡等」
    //       的人會等到天荒地老，畫面還在轉圈。
    //    ③ **「隨便傳一句話」是一個決定**：要打什麼？給一個字就不用想。
    //    ①②③ 的解法不是把字寫長，是把它們**拆成兩步、每一步旁邊放那一步要用的東西**（見證卡）。
    // ⛔ 這裡也不再說「連線成功了 🎉」：上一則就是那張 ✔「接上了，LINE 那邊確認收得到」，
    //    同一件事講兩次。🎉 併進這一句，慶祝與交棒一次講完。
    // 🔴 `C-250`③（示意頁 v79）：一句話給**理由**——用你自己的手機當第一位客人
    //    （v78 砍成「只剩最後一步。」砍過頭：第一次看的人卡在「為什麼要加我自己的帳號？」）
    await say('最後一步：用<b>你自己的手機</b>當第一位客人，看看客人加你好友時會收到什麼。')
    /**
     * 等待的狀態（卡片上那一行）。
     * ⚠️ 用一個變數存著、每次重畫整張卡——`updateMsg` 是整則覆蓋，
     *    不這樣做的話「補上帳號代號」會把已經變成 ✓ 的狀態洗回 pending。
     */
    let wait: { state: 'pending' | 'ok' | 'skipped', text: string } = { state: 'pending', text: '等你加好友…' }
    const waitId = card({ kind: 'witness', waitState: wait.state, waitText: wait.text })
    const renderWitness = () => updateMsg(waitId, {
      kind: 'witness',
      basicId: oaInvite?.basicId,
      addFriendUrl: oaInvite?.addFriendUrl,
      qrDataUrl: oaInvite?.qrDataUrl,
      oaName: oaInvite?.displayName,
      oaPictureUrl: oaInvite?.pictureUrl,
      waitState: wait.state,
      waitText: wait.text,
    })
    const setWait = (state: 'pending' | 'ok' | 'skipped', text: string) => {
      wait = { state, text }
      renderWitness()
    }

    // 輪詢整段等待只開這一支：排障選單開著、驗 Webhook 期間都照樣在聽，
    // 加好友一到下一輪 race 就接走——「我在這裡等」必須是真的。
    // （之前排障選單一開輪詢就全停，訊息真的來了還在對人喊「還沒等到」）
    /** 這一段等了多久（紀錄用：`D-101` 要驗「加好友＋按是我」比傳訊息快多少） */
    const waitStartedAt = Date.now()
    /**
     * 往回看多久：等待開始前 2 分鐘起算（他常常在看教學的時候就先加好友了；⛔ 伺服器最多只認一小時內）。
     * 🔴 送**時間長度**不送電腦的時間（code review：電腦時鐘快 5 分鐘的人原本永遠等不到，見 `sinceFromLookback`）
     */
    const lookback = () => Date.now() - waitStartedAt + 2 * 60 * 1000
    let notifyResult = ''
    /** 他按過「不是我」的那幾位 */
    const rejected: string[] = []
    /**
     * 按「是我」沒綁成的那一位＝**同一次**加好友／傳訊息先不再問，等他照指示重加或傳一句話（時間變新）再問。
     * ⛔ 不可以放進 `rejected`：那會把他本人永遠排除（code review 抓到：錯誤訊息叫他重加，重加了卻永遠偵測不到）
     */
    const retryAfter = new Map<string, number>()
    let poll = pollNewFollower(lookback, rejected, retryAfter)

    // 「加好友」要說得出**加哪一個**：剛開通的帳號零好友，只講一句「加你的官方帳號」
    // 等於沒講。查不到就只少 QR 與代號那一塊，兩步照樣讀得懂（見證卡自己有 fallback）。
    //
    // ⛔ 這件事**不可以 await 在見證卡與輪詢之前**（2026-08-28 code review 抓到）：
    // 它要去問 LINE 拿官方帳號代號，那支請求沒有逾時。LINE 慢的時候見證卡還沒畫、
    // 輪詢也還沒開始——人已經照做傳了訊息，畫面卻毫無反應；請求一直不回來的話，
    // 輪詢根本不會開始。所以：先畫卡、先開始等，代號自己晚點補上來。
    void loadOaInvite().then(() => { if (!isDisposed()) renderWitness() }).catch(() => {})
    let polled = poll.promise.then(r => ({ kind: 'received' as const, r }))

    // 等太久不能只讓人乾等——時間到主動講常見原因、給檢查的出口（只提醒一次，計時器記得清）
    let hintTimer: ReturnType<typeof setTimeout> | undefined
    const stalledHint = new Promise<{ kind: 'stalled' }>((r) => {
      hintTimer = setTimeout(() => r({ kind: 'stalled' }), FIRST_MSG_HINT_MS)
    })
    let hintPending = true
    /** 那張「照這五條檢查」真的出現過（⚠️ 不能拿 `hintPending` 代替：先按驗 Webhook 也會把它關掉） */
    let stallShown = false

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

    /** 按了「是我」、伺服器也驗過的那一位 */
    let received: NewFollowerRes | null = null
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

      const arms: Promise<{ kind: 'received', r: NewFollowerRes | null } | { kind: 'answered' } | { kind: 'stalled' }>[] = [
        polled,
        asked.then(() => ({ kind: 'answered' as const }), () => ({ kind: 'answered' as const })),
      ]
      if (hintPending)
        arms.push(stalledHint)
      const winner = await Promise.race(arms)

      if (isDisposed())
        break

      if (winner.kind === 'received' && winner.r?.lineUserId) {
        settle({ type: 'cancelled' }) // 收掉待答按鈕
        const r = winner.r
        const who = r.lineUserId!
        setWait('ok', '收到了')
        // 加好友是自己飄進來的、不是他按了什麼，所以要自己宣告新的一輪（畫面停在這一句）
        startTurn()
        /**
         * 🔴 安全閘：秀頭像＋名字讓他認，⛔ 不自動當成他——等待期間剛好有**客人**加好友的話，
         *    綁錯人＝客人收到我們的內部通知。
         * ⭐ 「早上的摘要、客人找真人」對剛上線的人是沒見過的名詞 → 講**會發生在他身上的事**＋一個例子
         *    （範例本身就是定義，示意頁 v79）。
         */
        const av = r.pictureUrl
          ? `<img class="agm-who__av" src="${escapeHtml(r.pictureUrl)}" alt="">`
          : '<span class="agm-who__av"></span>'
        await say(`<span class="agm-who">${av}<b>${escapeHtml(r.displayName || '有一位')}</b></span> 剛剛${r.via === 'message' ? '傳了一句話' : '加了好友'}——是你嗎？`
          + '<br>是的話，之後<b>有客人要找你本人</b>、還有<b>每天早上的摘要</b>（例如「昨天 5 位客人、2 件待處理」），都會用 LINE 傳到這支手機。')
        const c = await askChoices([
          { label: '不是我', value: 'no', escape: true },
          { label: '是我', value: 'yes', primary: true },
        ])
        const restart = () => {
          poll = pollNewFollower(lookback, rejected, retryAfter)
          polled = poll.promise.then(x => ({ kind: 'received' as const, r: x }))
        }
        if (c !== 'yes') {
          rejected.push(who)
          setWait('pending', '等你加好友…')
          await say('好，那不是你——我繼續等。')
          restart()
          continue
        }
        busy.value = true
        try {
          // 2026-09-27 `C-270`：總開關拿掉之後不會再回 `off`（加進名單＝一定在收）
          const b = await apiFetch<{ notify: 'added' | 'already' | 'full' | 'failed' }>('/api/admin/onboarding/bind-self', {
            method: 'POST',
            body: { lineUserId: who, lookbackMs: lookback() },
          })
          // ⛔ 只有真的在名單上才算（滿了、寫不進去都不承諾會收到）
          phoneNotified = b.notify === 'added' || b.notify === 'already'
          notifyResult = b.notify
          phoneTestVia = r.via ?? 'follow'
          received = r
          if (b.notify === 'full')
            await say('通知名單已經滿了（最多 10 位），這支手機這次沒有加進去——到「設定 › LINE 通知」關掉一位再加。')
          else if (b.notify === 'failed')
            await say('這支手機綁好了，但加進通知名單時出了錯——到「設定 › LINE 通知」再按一次「把我的手機加進來」。')
          break
        }
        catch (e: unknown) {
          // ⛔ 綁不上要講為什麼、下一步是什麼，然後繼續等（伺服器驗不過＝不是這段時間新進來的那一位）
          const msg = (e as { data?: { statusMessage?: string } })?.data?.statusMessage || '剛剛沒有綁成功'
          await say(`${escapeHtml(msg)}。`)
          retryAfter.set(who, r.at ?? Date.now())
          setWait('pending', '等你加好友…')
          restart()
          continue
        }
        finally {
          busy.value = false
        }
      }

      if (winner.kind === 'stalled') {
        hintPending = false
        if (!answer()) {
          settle({ type: 'cancelled' })
          stallShown = true
          // ④ 是真實災情：第二把鑰匙貼錯時，訊息其實有送到、被我們自己丟掉，
          //    人在這裡乾等而三個原因沒有一個是他的病因。現在「幫我再驗一次」查得出來了
          // 2026-09-02 改格式不改內容：原本是 175 字、四個編號擠成一段的**段落**。
          // 這是整段流程最有價值的一則，但出現的時機正好是人卡住又焦慮的時候，
          // 而那時最讀不下去的就是一整段文字。排成清單，字一個都沒少，但變成
          // 可以一條一條對著檢查。
          // ⚠️ 2026-09-11 不再寫「這四種…我**全部**幫你看一遍」：驗 Webhook 查不到第①條
          //    （只加好友沒傳訊息）也查不到第④條（加到別的帳號），原本那句本來就多講了。
          await say('還沒等到——最常見的是這五種。<b>第一條先自己看一眼</b>，設定那幾條按下面「幫我再驗一次」我幫你查。這段時間我也還在聽，一進來就會告訴你。')
          card({
            kind: 'help',
            summary: '照這五條檢查',
            steps: [
              // ⛔ 第一條仍然是**唯一跟設定無關、而且最可能**的那一條——只是換了內容（`C-250`③）：
              //    加好友就算數之後，卡住的變成「早就是好友、加不了第二次」的人。
              //    ⚠️ 排在最前面：卡住的人不該先被送去重查四項其實沒壞的設定。
              { text: '<b>早就是好友</b>的話，加好友不會再通知我們——<b>傳一句話給它</b>' },
              { text: '網址貼進「Webhook網址」了，但還沒按「<b>儲存</b>」' },
              { text: '「回應設定」那一頁的 <b>Webhook</b> 開關沒打開' },
              { text: '手機加好友加到別的帳號了' },
              { text: '第二組連線資訊（Channel Secret）貼錯——訊息其實有送到，被我們當成假冒的丟掉' },
            ],
            // 2026-09-02 補：這張卡原本一個連結都沒有。四條都要人回後台才檢查得了，
            // 卡住的人照著念完卻沒有一個地方點得過去——這一段正好是全流程
            // 最需要「當場點過去」的時刻。
            // ⛔ 2026-09-11 改指官方帳號後台（原本指 LINE Developers）：09-06 的
            //    「第二組連線資訊、貼網址、開開關全搬進官方帳號後台」（commit 01f8035）
            //    之後，這四條**沒有一條**還在 LINE Developers ——①網址與④Channel Secret
            //    在「設定 → Messaging API」、②開關在「回應設定」、③跟後台無關。
            //    這一則出現的時機正是人卡住又焦慮的時候，送錯後台等於多繞一趟。
            href: 'https://manager.line.biz/',
            hrefLabel: '打開官方帳號後台對照',
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
          await say('這條線是通的——再用手機加一次好友、或傳一句話，我繼續等。')
        askOptions = stallOptions
        continue
      }
      if (val === 'wait') {
        askOptions = quietOptions
        continue
      }
      if (val === 'redo') {
        // 重貼期間輪詢照跑（訊息一進來下一輪 race 就接走），改完回排障選單
        // 走到等訊息這一段的人網址一定貼過了 → 網址那項列得出來
        await offerRedo(line, webhookUrl)
        askOptions = stallOptions
        continue
      }
      // 其他（cancelled／不認得的值）：重掛按鈕繼續等
    }
    poll.stop() // 舊輪詢器到此必停（跳過出口時它還睡在 sleep 裡，換代後醒來就會退出）
    clearTimeout(hintTimer)
    if (isDisposed())
      return
    // ⭐ `stalled`＝等到 90 秒排障那張卡跳出來了；`rejected`＝按過幾次「不是我」（安全閘真的有擋到人嗎）
    track('phone_wait', {
      outcome: received ? 'bound' : 'skipped',
      waitedSec: Math.round((Date.now() - waitStartedAt) / 1000),
      stalled: stallShown,
      rejected: rejected.length,
      via: received?.via ?? '',
      notify: notifyResult,
    })

    if (received) {
      /**
       * ⭐ 加好友那一條：有自己歡迎訊息的人，**他手機上剛剛收到的就是客人會收到的那一則**——
       *    順手請他數一下幾則：兩則＝LINE 內建那則沒關（那個開關我們讀不到，只有他看得到）。
       * ⛔ 傳訊息那一條不講這句：早就是好友的人不會再收到歡迎訊息，講了他會去找一則不存在的訊息。
       * 🔴 v79：「應該只有一則」要講——只講「收到兩則的話」，他不知道自己該數到幾。
       */
      const countHint = received.via === 'follow' && await hasActiveFollowWelcome()
        ? '<br>你手機剛收到的<b>歡迎訊息</b>，就是客人加好友會看到的那一則——<b>應該只有一則</b>。收到兩則的話，回官方帳號後台把「加入好友的歡迎訊息」關掉。'
        : ''
      await say(`好了 ✓ 你的 MiniMe 正式活起來了 🎉${countHint}`)
      setup.firstMessageReceived = 'done'
    }
    else {
      setWait('skipped', '略過測試——之後加好友試試就好')
    }
    progress.value = LINE_STEP.testMessage
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
    if (how === 'cancel') {
      // ⚠️ 這句 2026-09-10 從呼叫端搬進來：原本 `reenterToken`／`reenterSecret` 各講一次、
      //    而 `offerRedo` 那條路按取消**什麼都不說**（人按了鈕、畫面沒反應）。
      //    收在這裡＝三個入口一致，而且以後多一個入口也不會漏。
      await say('好，先不換。想換的時候再按一次就行。')
      return false
    }
    let taught = how === 'walk'
    if (taught)
      await (isToken ? walkTokenNodes() : walkSecretNodes())
    while (true) {
      // 走過教學的人不再給「再看一次教學」（教學就在輸入格正上方）；
      // 選「直接貼新的」的人這顆要留——那是他唯一的入口
      const escapeLabel = taught ? undefined : '等等，我想看教學'
      const ok = isToken
        ? await askAndSaveToken(line, { escapeLabel, redo: true })
        : await askAndSaveSecret(line, { escapeLabel, redo: true })
      if (ok)
        return true
      taught = true
      await (isToken ? walkTokenNodes() : walkSecretNodes())
    }
  }

  /**
   * 重貼訊息接收網址（`Webhook URL`）。
   *
   * ⛔ 只有**已經貼過網址**的人走得到（見 `offerRedo` 的過濾）：在「取得連線資訊」階段
   * 就把它列出來，是叫人去重做一件還沒做過的事。
   * ⚠️ 這條路不重播整支教學：網址沒變，要的只是「再複製一次、貼回去、按儲存」。
   */
  async function redoWebhookUrl(webhookUrl: string) {
    await say('網址沒變，重貼一次就好——複製下面這串，回官方帳號後台的「設定 → Messaging API」貼進「<b>Webhook網址</b>」再按儲存。')
    card({ kind: 'copy', label: '你的訊息接收網址（Webhook URL）', value: webhookUrl })
    card({ kind: 'link', label: '打開官方帳號後台', href: 'https://manager.line.biz/' })
    await askChoices([{ label: '貼好了', value: 'ok', primary: true }])
    await say('好，等一下檢查就會看到結果。')
  }

  /**
   * 「改前面的設定」：聊天中主動回頭重做（2026-08-20 拍板）。
   * 不做精靈式的每步上一步——聊天不是表單，回上一步的實際需求是「重做某個動作」。
   * 檢查失敗的自動診斷仍是主要回頭路；這裡接的是「不等檢查失敗、自己想改」的情境
   * （例：頻道雙綁時錯的 Secret 也能通過檢查，人只能主動回頭換）。改完回原地繼續。
   */
  async function offerRedo(line: LineStatus, webhookUrl = '') {
    // ⛔ **只列已經貼過的**（2026-09-08 老闆抓到的第二個問題）：原本無論走到哪裡都列
    //    「重貼第一組／第二組」，在「取得連線資訊」階段就叫人去重做還沒做過的事。
    // ⚠️ 網址那項多一個條件：`webhookUrl` 有值才給得出可複製的東西。
    const avail: AgentChoice[] = [
      ...(line.tokenConfigured ? [{ label: '重貼第一組（Channel Access Token）', value: 'token' }] : []),
      ...(line.secretConfigured ? [{ label: '重貼第二組（Channel Secret）', value: 'secret' }] : []),
      ...(webhookUrl ? [{ label: '重貼訊息接收網址', value: 'url' }] : []),
    ]
    if (!avail.length) {
      await say('目前還沒有貼過任何連線資訊，沒有東西可以重貼。')
      return
    }
    // 只有一樣可重貼就別問「要哪一個」——只有一個選項的選單是多的一次點擊
    if (avail.length === 1) {
      const only = avail[0]!.value
      if (only === 'url')
        await redoWebhookUrl(webhookUrl)
      else
        await redoKeyFlow(line, only as 'token' | 'secret')
      return
    }
    const c = await askChoices([...avail, { label: '不用了', value: 'cancel', escape: true }])
    if (c === 'cancel') {
      await say('好，先不換。想換的時候再按一次就行。')
      return
    }
    if (c === 'url') {
      await redoWebhookUrl(webhookUrl)
      return
    }
    await redoKeyFlow(line, c as 'token' | 'secret')
  }

  /**
   * Webhook 檢查判定是「LINE 不認得我們的 Token」時的出口：讓人當場重貼第一組連線資訊。
   *
   * ⛔ 2026-09-10 把尾巴那兩句拿掉：換成功時 `askAndSaveToken` 已經說了「換好了 ✓ 這組是…」、
   *    取消時 `redoKeyFlow` 已經說了「好，先不換…」，這裡再補一句就是同一件事講兩次；
   *    而且回去之後**檢查選單本來就會再出現一次**（那排鈕自己就在說「都設好了，幫我檢查」），
   *    不需要再用一句話催。
   */
  async function reenterToken(line: LineStatus) {
    await redoKeyFlow(line, 'token')
  }

  /**
   * 判定是「我們自己把 LINE 的測試訊息擋掉」時的出口：重貼第二組連線資訊。
   * 這條路以前不存在——同一個 401 被當成 Token 的問題，人被指去重貼一把根本沒壞的鑰匙。
   */
  async function reenterSecret(line: LineStatus) {
    // 尾巴那兩句拿掉的理由同 `reenterToken`
    await redoKeyFlow(line, 'secret')
  }

  /**
   * 驗一次 Webhook 並把結果講清楚：出檢查卡 → 驗 → 依真實錯誤分診建議。
   * 主迴圈跟 90 秒排障共用這一份——之前排障那份自己重寫，掉了「401→重貼 Token」的出口，
   * Token 貼錯又略過前面檢查的人會被指去查一個不是病因的地方，唯一能按的只剩跳過。
   */
  async function verifyAndAdvise(webhookUrl: string, line: LineStatus): Promise<'ok' | 'fail' | 'unknown'> {
    const cardId = card({ kind: 'status', state: 'pending', text: '正在問 LINE 收不收得到…' })
    const v = await verifyWebhook(webhookUrl)
    // ⭐ 病因的分布＝接線教學哪一步最常沒做到（`nourl`＝沒按儲存、`inactive`＝開關沒開…）
    track('webhook_check', { result: v?.cause ?? 'unreachable' })
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
      progress.value = Math.max(progress.value, LINE_STEP.testMessage)
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
    progress.value = Math.max(progress.value, LINE_STEP.receive) // 兩組連線資訊到手，進「接收 LINE 訊息」格
    let verified = false

    // 續走模式先靜默驗一次：之前就接好 Webhook 的人不用再被叫去貼一次網址。
    // ⚠️ 2026-09-06 起 `resumedConnected` 這個旗標不需要了——關自動回應的教學已經併進
    //    `teachConnect()`，而它只在 `!verified` 時播，回來的人自然跳過（原本要靠旗標擋）。
    if (opts.preVerify && line.tokenConfigured && line.secretConfigured) {
      const v = await verifyWebhook(webhookUrl)
      if (v?.cause === 'ok') {
        track('webhook_check', { result: 'ok', pre: true })
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
        // silent＝這是導覽動作不是對話內容（而且使用者泡泡會把畫面拉回底部，抵銷掉捲回）
        { label: '回看教學', value: 'walk', silent: true },
        { label: '略過檢查，直接測試', value: 'skip', escape: true },
        { label: '重貼連線資訊或網址', value: 'redo' },
      ])
      if (c === 'redo') {
        await offerRedo(line, webhookUrl)
        continue
      }
      if (c === 'walk') {
        // ⛔ **捲回，不重播**（2026-09-10）：那兩則教學確實已經捲出視野一千多像素，
        //    所以這顆鈕有存在理由；但重播的代價更高——聊天記錄多一份一模一樣的內容，
        //    而且要再按一次「下一步」才回得到原地。
        // ⚠️ 圖還沒補進資料夾、或劇本被改到沒經過 teachConnect 時 id 會是 null，
        //    那時退回舊行為（重播）而不是什麼都不做——按了沒反應比多一份記錄糟。
        if (connectFirstEntryId != null)
          scrollToEntry(connectFirstEntryId)
        else
          await teachConnect()
        continue
      }
      if (c === 'skip') {
        track('webhook_check', { result: 'skipped' })
        // 2026-09-02：跳過的東西要說得出丟了什麼（跳過測試那顆本來就有寫，這顆漏了）。
        // 同一條流程兩顆跳過鈕、一顆講一顆不講，正是那條「沉默死亡」慣例要防的事。
        await say('好，先不檢查。<b>如果等一下沒收到訊息，多半就是這一步沒設好</b>——那時我會再帶你驗一次。')
        break
      }
      const res = await verifyAndAdvise(webhookUrl, line)
      if (res === 'ok') {
        // ⛔ 2026-09-11 去重：原本是「連線成功了！…已經**成功連上系統**，可以正式使用 **MiniMe** 了」
        //    ——同一件事講兩次，而且「系統」與「MiniMe」是同一個東西的兩個名字（房規：我們自己一律叫 MiniMe）。
        // ⛔ 2026-09-11 整則刪掉：它跟**正上方那張 ✔ 狀態卡**（「接上了，LINE 那邊確認收得到」）
        //    講的是同一件事——狀態卡是結果，這則只是再唸一次。🎉 併進見證時刻的第一句
        //    （「太好了 🎉 最後一步…」），慶祝與交棒一次講完。
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
  /**
   * 接線教學第一則的 id——「回看教學」要捲回的就是它（見 `walkNodes` 的 `onFirstSaid`）。
   * ⛔ 存 id 不存索引：`entries` 只會往後長，索引在任何插入下都會漂。
   */
  let connectFirstEntryId: number | null = null

  /**
   * 這個帳號有沒有一條**啟用中**的加好友歡迎（打造那一趟採用的、或自己在自動回應建的，`C-250`）。
   * ⛔ 查不到就當沒有：講「不用動」最壞是客人收兩則，講「關掉」最壞是一則都收不到。
   */
  async function hasActiveFollowWelcome(): Promise<boolean> {
    try {
      const list = await apiFetch<Array<{ enabled?: boolean, name?: string, nodes?: ScriptNode[], rootNodeId?: string }>>('/api/ai/scripts/list')
      if (!Array.isArray(list)) return false
      return followWelcomeRow(list.map(s => ({
        enabled: s.enabled,
        triggerEvent: scriptTriggerEvent({ nodes: s.nodes ?? [], rootNodeId: s.rootNodeId ?? '' }),
      }))).state === 'active'
    }
    catch {
      return false
    }
  }

  async function teachConnect() {
    // 🔴 `D-100`：「加入好友的歡迎訊息」那顆開關**照他有沒有自己的歡迎訊息換講法**——
    //    這一刻他就站在那顆開關前面，是全流程唯一講這件事不用他記的時間點。
    const ownWelcome = await hasActiveFollowWelcome()
    await walkNodes([
      {
        onFirstSaid: (id: number) => { connectFirstEntryId = id },
        // 2026-09-07 老闆拍板恢復導航兩格（中間離開過去貼 secret，回來可能已經迷路）。
        // 2026-09-10 改輪播之後多給一句「還停在那一頁的話直接跳到第 3 步」——
        // 步驟軌讓「跳著看」變成點一下的事，那句話才有地方可去。
        html: '先按上面那張卡的「<b>複製</b>」把網址複製起來，再回到<b>官方帳號後台</b>貼上。'
          // ⛔ 2026-09-11 刪掉前半句「剛剛複製第二組的那個分頁**多半還開著**」（使用者點名）：
          //    那是**替他猜他螢幕上的狀況**，而後半句本來就帶著條件（「還停在那一頁的話」）——
          //    猜對了是廢話、猜錯了是雜訊，條件句自己就把話講完了。
          + '<br>還停在剛剛那一頁的話，<b>直接跳到第 3 步</b>。',
        aside: { summary: '為什麼特別強調存檔？', html: '貼了沒按「儲存」是接不通的<b>第一名</b>——網址看起來在格子裡，其實沒存進去。' },
        href: 'https://manager.line.biz/',
        hrefLabel: '打開官方帳號後台 ↗',
        carousel: ONBOARDING_CAROUSELS.webhookUrl,
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
        // 2026-09-11「兩件事」→「三件事」：補上「聊天」那顆開關（老闆實機截圖抓到我們沒教，
        // 關著的話 LINE 後台的「聊天」整頁是「功能目前關閉中」，而「聊天的回應方式」掛在它底下）
        html: (ownWelcome
          ? '<b>還在同一個後台</b>，這一頁要做<b>四件事</b>：把「聊天」和 Webhook 打開、關掉 LINE 內建的歡迎訊息、把回應方式改成手動聊天。'
          : '<b>還在同一個後台</b>，這一頁要做<b>三件事</b>：把「聊天」和 Webhook 打開、把回應方式改成手動聊天。')
          + '<br>（如果左邊沒有那排選單，先點右上角的「<b>設定</b>」。）',
        aside: { summary: '為什麼要關掉自動回應？', html: 'LINE 內建的自動回應預設是開的，不關的話客人每句話都會收到<b>兩套回覆</b>——LINE 那句制式回覆，再加上 MiniMe 的回覆。' },
        href: 'https://manager.line.biz/',
        hrefLabel: '打開官方帳號後台 ↗',
        carousel: ownWelcome ? ONBOARDING_CAROUSELS.responseSettingsOwnWelcome : ONBOARDING_CAROUSELS.responseSettings,
      },
    ], '')
  }

  /**
   * 去問「要加哪個帳號」（帳號代號＋加好友連結＋QR），**存進 `oaInvite` 不自己出卡**——
   * 卡片是見證卡的第①步，由 `stepFirstMessageWait` 重畫（2026-09-11 併卡後改的）。
   *
   * ⛔ 查不到就維持 `null`：「查不到」不等於「沒有」，畫一張空 QR 比不畫更糟；
   *    見證卡的第①步會退成一句「在 LINE 裡搜尋你的官方帳號，加它為好友」，兩步照樣讀得懂。
   * ⚠️ 結果**快取起來**：成績單的「回去做傳話測試」會把 `stepFirstMessageWait` 整段再跑一次，
   *    那時要的是「同一份資料畫到新的那張卡上」，不是再打一次 LINE。
   */
  async function loadOaInvite() {
    if (oaInvite)
      return
    try {
      const r = await apiFetch<{ basicId: string, addFriendUrl: string, qrDataUrl: string, displayName?: string, pictureUrl?: string }>(
        '/api/admin/onboarding/oa-invite',
      )
      if (r?.basicId)
        oaInvite = { basicId: r.basicId, addFriendUrl: r.addFriendUrl, qrDataUrl: r.qrDataUrl, displayName: r.displayName, pictureUrl: r.pictureUrl }
    }
    catch {
      // 拿不到就算了：這是加分項，不該讓它擋住見證時刻
    }
  }

  /**
   * 等他手機加好友：runner 的換代輪詢（背景分頁不打、單次失敗不打斷、stop／dispose 即退）。
   * `exclude`＝他按過「不是我」的那幾位（⛔ 不要一直問同一個人）。
   */
  function pollNewFollower(lookbackMs: () => number, exclude: string[], retryAfter: Map<string, number> = new Map()) {
    return pollUntil<NewFollowerRes>(async () => {
      const r = await apiFetch<NewFollowerRes>(
        `/api/admin/onboarding/new-follower?lookbackMs=${lookbackMs()}&exclude=${encodeURIComponent(exclude.join(','))}`,
      )
      if (!r.found) return null
      // 剛剛沒綁成的那一位：同一次事件先不再問，等出現**更新的**那一下（他照指示重加、或傳一句話）
      const seenAt = r.lineUserId ? retryAfter.get(r.lineUserId) : undefined
      if (seenAt != null && (r.at ?? 0) <= seenAt) return null
      return r
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
    progress.value = LINE_STEP.done
    // 走到成績單＝這一趟接完了，「接到一半」的旗子收掉（之後進後台不會再被拉回來）
    clearLineFlowInProgress(wid.value)

    // ⛔ 2026-09-26（`C-250`／`D-88`）**這裡不再揭曉輪廓、不再給草稿**：那兩樣已經搬到打造那一趟。
    //    留在這裡的話，走完兩趟的人會看到同一張卡兩次、同幾樣草稿被問兩次（重複採用會多出重複的腳本與標籤）。

    card({
      kind: 'summary',
      items: [
        { label: 'LINE 官方帳號已接通', done: setup.lineConnected === 'done' },
        {
          // `C-250`②：跟進度格、小幫手英雄卡同一個說法（⛔ 不再一處叫「收到第一則訊息」、一處叫「用手機測試」）
          // `C-250`③：真的加進通知名單了才講「早上的摘要也會傳到這支手機」（示意頁 v80 併成一行）
          label: setup.firstMessageReceived === 'done' && phoneNotified ? '你的手機收到了，早上的摘要也會傳到這支手機' : '用手機測試',
          done: setup.firstMessageReceived === 'done',
          note: setup.firstMessageReceived === 'done' ? undefined : '已跳過，之後加好友試試',
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
    // 🔴 2026-09-26（`C-250`②／`D-101`，示意頁 v80）結尾從「帶你認識後台（約 2 分鐘）」＝7 步全站地圖，
    //    換成「上線之後」3 步：他打造完就進過後台了（地圖是重播），而 7 步前 4 步念的是側欄上本來就寫著的分組名。
    //    ⭐ 真正新的只有一件：**他手機剛剛那一下已經進到「客服對話」了**——去看那一下。
    //    7 步地圖留在小幫手「教學」清單，想看的人自己按。
    const received = setup.firstMessageReceived === 'done'
    /**
     * ⚠️ 他那一場**在不在「客服對話」清單上**（`C-250`③）：清單只列有訊息的對話（依 lastMessageAt 排）。
     *    只加好友、而且沒有自己的歡迎訊息＝那一場一則訊息都沒有、清單上看不到——
     *    這時候說「你手機剛剛那一下已經進到客服對話了」＋「去看看（3 步）」就是假的。
     *    這一趟有見證到的就照見證的方式判斷；續走回來的人（沒見證）看清單上有沒有任何一場。
     */
    const rowVisible = received && (phoneTestVia
      ? phoneTestVia === 'message' || await hasActiveFollowWelcome()
      : await apiFetch<{ conversations?: unknown[] }>('/api/conversations/list', { query: { limit: 1 } })
        .then(r => (r.conversations?.length ?? 0) > 0)
        .catch(() => false))
    track('line_done', { connected: setup.lineConnected === 'done', received, notified: phoneNotified, rowVisible })
    await say(rowVisible
      ? '上線了 🎉 你手機剛剛那一下，已經進到「<b>客服對話</b>」了——去看一眼，之後客人的訊息也在那裡回。'
      : received
        ? '上線了 🎉 你的手機收到了——之後客人的訊息都在「<b>客服對話</b>」回。'
        : '上線了 🎉 還沒用手機測試也沒關係，之後加好友傳一句話試試就好。')
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
          // ⚠️ 步數照實講：沒用手機測試的人第 1 步（「你剛剛那一下」）會被拿掉，只剩 2 步
          //    （⛔ 鈕上寫「3 步」、導覽卻從「1 / 2」開始＝按鈕與計數各講一個數字）
          { label: rowVisible ? `去看看（${liveTourStepCount(true)} 步）` : `帶我看一下（${liveTourStepCount(false)} 步）`, value: 'tour', primary: true },
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
        // 走到成績單的人網址一定貼過了，所以「重貼訊息接收網址」在這裡列得出來
        await offerRedo(line, `${line.publicBaseUrl || window.location.origin}/webhook`)
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
        // 所以先落在「客服對話」、帶 ?from= 進去，由 TutorialAgent 掛載後接手開跑（`utils/onboarding-landing.ts`）。
        // `notify=1`＝這支手機真的加進通知名單了：「上線之後」才講「你的手機也會同時收到通知」
        await navigateTo(`${onboardingLandingPath(wid.value)}?from=${LANDING_FROM_LINE}${phoneNotified ? '&notify=1' : ''}`)
        return
      }
      // 落地在「對話」頁不落統計頁：新帳號 KPI 全 0，剛見證完第一則訊息就接冷場；
      // 對話頁裡就有他剛傳的那句話，敘事接得上（2026-08-12 拍板 G-11）
      await navigateTo(onboardingLandingPath(wid.value))
      return
    }
  }

  // ── 打造這一趟的結尾（`C-250`，示意頁 v80）─────────────────────────

  /** 最近一個還沒過的節日（「不知道推播要推什麼」那句回扣要講具體的下一個） */
  function nextFestival(): { name: string, inDays: number } | null {
    const today = taipeiDate()
    let best: { name: string, inDays: number } | null = null
    for (const f of TAIWAN_FESTIVALS) {
      const d = daysBetween(today, f.date)
      if (d < 0 || d > 90) continue
      if (!best || d < best.inDays) best = { name: f.name, inDays: d }
    }
    return best
  }

  /**
   * 「最想解決的是哪一件」的回扣句（`D-98` 救回來的那一題：它是唯一一題問「你的煩惱」的，
   * 回扣一句他就知道這趟不是白填表）。
   * 🔴 **每一句都要看「那樣東西這一趟真的建了沒」**（`D-100`）：歡迎訊息他可能按了先不要、
   *    標籤可能沒採用——⛔ 對不上就**整句不講**，不要硬湊。
   * ⚠️「客服回不完」那句要講的是「那些知識卡看過放進去」——**網站真的整理出卡了才講**
   *    （`C-250`③；沒給網址、或整理不出卡＝指著一件不存在的東西）。
   */
  function painPayoff(pain: string): string {
    if (pain === '加好友後沒人理' && builtKeys.has('welcome'))
      return '你說最想解決<b>加好友後沒人理</b>——剛剛採用的<b>歡迎訊息</b>就是在解決這件事，接上 LINE 之後客人一加就會收到。'
    if (pain === '不知道推播要推什麼') {
      const f = nextFestival()
      if (f) return `你說最想解決<b>不知道推播要推什麼</b>——月曆排好了，最近是 <b>${f.inDays} 天後的${escapeHtml(f.name)}</b>。`
    }
    if (pain === '想知道客人是誰' && builtKeys.has('tags'))
      return '你說最想<b>知道客人是誰</b>——剛剛那幾顆<b>分眾標籤</b>就是在做這件事，之後發推播挑人也是用它們。'
    // `C-250`③：網站整理出卡了才講（⛔ 沒有卡就指著一件不存在的東西）
    if (pain === '客服回不完' && siteCards.total > 0)
      return '你說最想解決<b>客服回不完</b>——等你把知識卡看過放進去，那些重複的問題它就自己答了。'
    return ''
  }

  /**
   * 成績單＋唯一一顆「進入後台」（`D-102`，老闆 09-25：「是否打造 MiniMe 之後直接進後台，
   * 之後再讓他自己決定什麼時候要串接 LINE」）。
   * ⛔ 結尾不再說「先進後台看看——測試對話那一頁可以直接問它一句」「這些在後台都改得到」：
   *    進後台之後的導覽會講（老闆：「這句是否先不用，進去後馬上接 tour 了」）。
   * ⚠️ 仍然要他按一下才走，⛔ 不自動跳：成績單是這一趟的成果，要讓他看得到才離開。
   * ⚠️ 成績單只列「這一趟做成了什麼」——「知識卡等你看過」「接上 LINE：還沒」那兩行不放
   *    （進後台兩秒後的導覽第 1、2 步就講，同一件事隔兩秒講兩次）。
   */
  async function stepBuildFinish(profileDone: boolean) {
    progress.value = BUILD_STEP.done
    const payoff = profileDone ? painPayoff(String(revealedProfile?.fields?.pain?.value ?? '').trim()) : ''
    if (payoff) await say(payoff)
    card({
      kind: 'summary',
      title: 'MiniMe 打造完成',
      items: [
        { label: 'MiniMe 認識你的店', done: profileDone, ...(profileDone ? {} : { note: '你先跳過了' }) },
        // ⭐ 列出「哪幾樣」，⛔ 不要退回只寫數字（他要知道的是哪三樣）
        ...draftSteps.map(s => ({
          label: s.label,
          done: s.status === 'done',
          ...(s.status === 'done' ? {} : { note: s.status === 'declined' ? '你選了先不要' : s.status === 'failed' ? (s.error || '沒有成功') : '沒有執行' }),
        })),
        // ⚠️ 「接上 LINE 之後」不能拿掉：每日摘要只送通知名單裡的手機，名單要接上 LINE 才有（`D-100`）
        { label: '行銷月曆：接上 LINE 之後，節日前會在早上的摘要提醒你', done: true },
        { label: `${freePlanName}方案，每月 ${freeQuota} 則 AI 回覆`, done: true, note: '不需綁卡' },
      ],
    })
    // ⭐ `C-250`②：建成的那幾樣記下來——落地導覽第 1 步、小幫手「開帳那一趟建了什麼」、
    //    「看看你剛剛做的東西」三處都吃這一份（⛔ 沒建成的不記：列了就得解釋「它其實沒建」）
    saveOnboardingBuilt(wid.value, draftSteps.filter(s => s.status === 'done').map(s => ({ key: s.key, label: s.label })))
    track('build_finish', {
      profileDone,
      built: draftSteps.filter(s => s.status === 'done').length,
      siteCards: siteCards.total,
      payoff: !!payoff,
    })
    await askChoices([{ label: '進入後台', value: 'go', primary: true }])
    await navigateTo(`${onboardingBuiltLandingPath(wid.value)}?from=${LANDING_FROM_BUILD}`)
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
  /**
   * 只跑「認識你的店」那一段（`?focus=profile`）。
   *
   * ⛔ **這條路是補 `C-219` 留下的死路**：組織頁的空狀態按鈕會把人帶進精靈，
   *    但續走模式只跑接線那四步——已經接好 LINE 的人（老店就是）會看到
   *    「歡迎回來」然後直接跳到成績單，**五題一句都沒問**。指路指到死路。
   */
  async function runProfileOnly() {
    flow.value = 'build'
    progress.value = BUILD_STEP.profile
    track('build_start', { mode: 'profileOnly' })
    const name = workspaceList.value.find(w => w.workspaceId === wid.value)?.name || ''
    await say(`${name ? `「${escapeHtml(name)}」` : '這個帳號'}的設定我先不動，這一趟只做一件事：<b>讓我認識你的店</b>。`)

    // 老店先猜一份（`C-222`）：已經用了一陣子的帳號，知識庫、標籤、活動名稱裡
    // 其實寫滿了這家店在賣什麼。⛔ 再叫他從頭答五題，等於說「我認識你這麼久還是不認識你」。
    const inferred = await offerInference()

    const done = await stepStoreProfile(inferred
      ? { skipFilled: inferred, intro: '剩下這幾題我猜不到，要你講。' }
      : {})
    if (done === 'skipped') {
      await navigateTo(onboardingLandingPath(wid.value))
      return
    }
    progress.value = BUILD_STEP.reveal
    await revealStoreProfile()
    if (revealedProfile) await stepStoreDrafts(revealedProfile)
    await stepSiteCardsInfo(revealedProfile)
    await finishProfileOnly()
  }

  /**
   * 老店反推（`C-222`）：從既有資料猜一份，讓他只確認差異。
   * 回傳「確認過的輪廓」＝下一步要跳過哪幾題；猜不出來或他不要就回 null（走原本的五題）。
   */
  async function offerInference(): Promise<StoreProfileDoc | null> {
    let current: StoreProfileDoc | null = null
    try {
      const r = await apiFetch<{ profile: StoreProfileDoc, ready: boolean }>('/api/store-profile')
      current = r.profile
      // 已經認識了就不用再猜（這條路是給「還不認識」的人走的）
      if (r.ready) return null
    }
    catch {
      return null
    }

    await say('在問你之前，我先從你帳號裡<b>已經有的東西</b>（知識庫、標籤、辦過的活動）自己猜一份——你只要看一遍、改錯的就好。')
    const c = await askChoices([
      { label: '好，你先猜', value: 'infer', primary: true },
      { label: '不用，直接問我', value: 'ask' },
    ])
    if (c !== 'infer') return null

    busy.value = true
    let res: { ok: boolean, note?: string, filled?: string[], profile?: StoreProfileDoc } | null = null
    try {
      res = await apiFetch('/api/store-profile/infer', { method: 'POST', body: {} })
    }
    catch (e: unknown) {
      const msg = (e as { data?: { statusMessage?: string } })?.data?.statusMessage
      await say(msg ? escapeHtml(msg) : '這次猜不出來，那我直接問你幾題。')
      return null
    }
    finally {
      busy.value = false
    }

    // ⛔ 資料不夠就誠實講，不要硬生一份憑空捏造的輪廓
    if (!res?.ok || !res.profile || !(res.filled?.length)) {
      await say(`${escapeHtml(res?.note || '你帳號裡的資料還不夠讓我猜')}，那我直接問你幾題。`)
      return null
    }

    await say(`${escapeHtml(res.note || '')}，猜到 <b>${res.filled.length}</b> 項。<b>猜的我都標出來了</b>，看一遍：`)
    showProfileCard(res.profile)

    const ok = await askChoices([
      { label: '都對，就是這樣', value: 'yes', primary: true },
      { label: '有幾項不對，重問我', value: 'redo', escape: true },
    ])
    if (ok !== 'yes') {
      await say('好，那我一題一題問，你回答的會蓋過我猜的。')
      return null
    }

    /**
     * ⭐ **他按了「都對」＝這幾格從此是「你說的」不是「AI 推測」**。
     * 這不只是文案：`profileReady` 的口徑是「商家親自答了三題」，
     * 不把確認過的轉成 owner 的話，老店走完這一趟仍然會被判成「還不認識」，
     * 輪廓卡會繼續顯示空狀態——做完一件事卻看不到任何變化，是最傷信任的那種 bug。
     */
    const confirm: Record<string, string> = {}
    for (const def of STORE_PROFILE_FIELDS) {
      const v = res.profile.fields?.[def.id]
      if (v?.value && v.source === 'ai') confirm[def.id] = v.value
    }
    if (Object.keys(confirm).length) {
      busy.value = true
      try {
        const saved = await apiFetch<{ profile: StoreProfileDoc }>('/api/store-profile', {
          method: 'POST',
          body: { fields: confirm },
        })
        return saved.profile
      }
      catch {
        await say('剛剛那幾格存起來的時候出了狀況，等一下的問題我會全部問一遍。')
        return null
      }
      finally {
        busy.value = false
      }
    }
    return res.profile
  }

  /** 只做輪廓那一趟的收尾：⛔ 一定要給出路，不要停在一段沒有按鈕的對話上 */
  async function finishProfileOnly() {
    track('build_finish', {
      mode: 'profileOnly',
      profileDone: true,
      built: draftSteps.filter(s => s.status === 'done').length,
      siteCards: siteCards.total,
    })
    // ⛔ **primary 不可以隨狀態換人**（守門測試 `agent-choice-order`）；這一排本來就沒有主要動作
    //    （「看看輪廓」與「回後台」是平的，硬挑一顆染色是替他決定）。
    // ⚠️ 2026-09-26（`C-250`）「把網站整理成知識卡」那顆拿掉：它接的是已經移除的「知識庫初稿」採用
    //    （按了什麼都不建、讀過的頁一小時後刪掉）。待看過的知識卡是 `C-250` 第三批的事。
    const c = await askChoices([
      { label: '看看我的輪廓', value: 'profile' },
      { label: '回後台', value: 'back', escape: true },
    ])
    if (c === 'profile') {
      await navigateTo(`/admin/${wid.value}/settings/organization`)
      return
    }
    await navigateTo(onboardingLandingPath(wid.value))
  }

  /**
   * @param entry 接 LINE 那一趟從哪個入口進來（`?entry=`，紀錄用；不認得的一律算 `direct`）
   */
  async function start(continueWorkspaceId?: string, focus?: string, entry?: string) {
    await runScript(async () => {
      if (continueWorkspaceId && focus === 'profile') {
        wid.value = continueWorkspaceId
        await loadWorkspaceList().catch(() => {})
        await runProfileOnly()
        return
      }
      /**
       * ── 接上 LINE 那一趟（`?workspaceId=`）──────────────────────────
       * ⭐ `C-250`：這一趟現在**只從後台進來**（紅帶「接上 LINE」、小幫手英雄卡、組織頁），
       *    是他自己決定的時機；打造那一趟不再接到這裡。
       * ⚠️ 還沒拿過任何連線資訊的人先問「有沒有官方帳號」——以前這一問只在全新開通才有，
       *    續走模式直接跳到拿第一組，第一次進來接 LINE 的人等於少了第一步。
       */
      if (continueWorkspaceId) {
        wid.value = continueWorkspaceId
        flow.value = 'line'
        progress.value = LINE_STEP.credentials
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
        // ⭐ `D-100` C-1：「第 2 段從哪個入口進來」＋他回來時已經做到哪（拆兩趟之後最想知道的一個數字）
        track('line_start', {
          entry: lineFlowEntry(entry),
          token: line.tokenConfigured,
          secret: line.secretConfigured,
          received: setup.firstMessageReceived === 'done',
        })
        // 立旗＝「接到一半」：關分頁、斷線的人下次進後台會被拉回一次（`D-88` ②，見 onboarding-line-flag.ts）
        markLineFlowInProgress(wid.value)
        if (!line.tokenConfigured && !line.secretConfigured)
          await stepHasOA()
        else
          await stepWelcomeBack(line, setup)
        await runSteps(MAIN_FLOW, { line, setup, preVerify: true })
        return
      }

      /**
       * ── 打造你的 MiniMe（全新開通）─────────────────────────────────
       * 建帳號 → 五題 → 讀網站＋揭曉＋檢查點 → 草稿 → 成績單 → 進入後台（落在測試對話）。
       * ⛔ 接 LINE 不在這一趟（`D-102`）；全程不離開這一頁、零外部依賴，結束時**手上真的有東西**。
       */
      if (!(await stepWelcomeFresh()))
        return
      if (!(await stepCreate()))
        return
      const profileDone = await stepStoreProfile() === 'done'
      if (profileDone) {
        progress.value = BUILD_STEP.reveal
        await revealStoreProfile()
        if (revealedProfile) await stepStoreDrafts(revealedProfile)
        await stepSiteCardsInfo(revealedProfile)
      }
      await stepBuildFinish(profileDone)
    })
  }

  /** 頁首「之後再說」：接 LINE 那一趟是他自己選擇先走的，⛔ 下次進後台不要再把他拉回來 */
  function markLeaving() {
    // ⭐ 停在第幾格離開的（進度格的編號，兩趟各自一套）
    track('wizard_leave', { step: progress.value })
    flushEvents()
    if (flow.value === 'line' && wid.value) clearLineFlowInProgress(wid.value)
  }

  function dispose() {
    // 背景整理卡的迴圈跟著收（伺服器那邊照舊會由知識庫頁與排程接手）
    siteCardsStopped = true
    flushEvents()
    runner.dispose()
  }

  return {
    entries,
    ask,
    typing,
    busy,
    /** 劇本要求把畫面捲回哪一則（頁面在「捲到底」那個 watcher 裡順便處理） */
    scrollToId,
    /** 這一輪的第一則——頁面把它貼到頂，讓人從第一句開始讀（2026-09-11） */
    turnStartId,
    progress,
    /** 這一場是哪一趟＋它的名字／要多久／四格（頁首整條都吃這一份） */
    flow: readonly(flow),
    flowInfo,
    /** 這一場對話作用中的 workspaceId（建立後才有值）；給頁面算「之後再說」的出口用 */
    activeWorkspaceId: readonly(wid),
    onChoice,
    onSubmit,
    onPick,
    onSkip,
    /** 互動卡片的事件（輪廓卡就地修改、草稿框改內容）——頁面從 AgentMessageRenderer 轉交過來 */
    onProfileEdit,
    onDraftInput,
    /** 草稿卡的「換個說法」（`D-89` ②） */
    onDraftReword,
    markLeaving,
    start,
    dispose,
  }
}
