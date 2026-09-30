/**
 * 工作區「設定就緒度」資料 + 白話文能力註冊表。
 *
 * 教學 agent 的核心地基：所有「你哪裡沒做完」都來自後端 setup-status 的真實訊號，
 * 這裡只負責抓資料、配上白話文文案/路由/對應導覽，並算出完成度。
 * agent 只能「轉述」這份狀態，不能自己臆測。
 */

import type { Component } from 'vue'
import { Iphone, Link, MagicStick, Operation, Reading, Shop } from '@element-plus/icons-vue'
import type { SetupCapabilityId, SetupItemStatus, SetupStatusResponse } from '~~/shared/types/setup'
import { STORE_PROFILE_EDIT_CAPABILITIES, type Capability } from '~~/shared/permissions'
import type { AgentGuideId } from '~/utils/agent-guides'

export interface SetupCapability {
  id: SetupCapabilityId
  icon: Component
  /** 一句話、零術語：這是什麼 */
  title: string
  /** 白話文：為什麼要做 / 不做會怎樣 */
  why: string
  /** 必要能力（會算進「還差幾項」與按鈕上的紅點） */
  required: boolean
  /**
   * 誰看得到這一項＝去做這件事要的那項能力（`G-109`：對齊它帶人去的那一頁／修好它打的端點，
   * 讀 `shared/permissions.ts` 同一張表）。沒有的人不顯示、也不算進進度與紅點。
   * 給一串＝**每一項都要有**（例如進頁與存檔各看一項的店家輪廓）。
   */
  requires: Capability | readonly Capability[]
  /** 沒做完時，前往設定的頁面 */
  route: (workspaceId: string) => string
  /** 若有對應的逐步導覽，填教學主題 id（對應 useTutorial 的 topic） */
  tourId?: string
  /**
   * 若這一項有「對話帶你做」的劇本（`utils/agent-guides`），填劇本 id。
   *
   * 有劇本就**優先跑劇本**（08-17 拍板的分工：做完之後後端驗得出來的任務走對話劇本，
   * 認識畫面的教學才留給導覽）。導覽只能教「畫面長怎樣」，收不了尾——
   * 它不會知道你到底做完了沒有，也就沒有人告訴你「還差開關沒開」。
   */
  guideId?: AgentGuideId
  /** 側欄入口的 data-tour 選擇器，給「缺項巡覽」高亮用 */
  navTarget: string
}

export interface ResolvedCapability extends SetupCapability {
  status: SetupItemStatus
}

/**
 * 能力註冊表。要新增一個會被體檢的設定項，往這裡加一筆，並在後端 setup-status 加上對應訊號。
 * 文案一律白話、把使用者當第一次來的人。
 */
const CAPABILITIES: SetupCapability[] = [
  {
    id: 'lineConnected',
    icon: Link,
    title: '接上 LINE 官方帳號',
    why: '這是一切的前提。沒接好，機器人就收不到、也回不了訊息。',
    required: true,
    // 「組織與 LINE」那一頁的進入與儲存
    requires: 'line.manage',
    route: wid => `/admin/${wid}/settings/organization`,
    tourId: 'organization',
    navTarget: '[data-tour="nav-organization"]',
  },
  {
    id: 'aiEnabled',
    icon: MagicStick,
    title: '開啟 AI 自動回覆',
    // ⛔ 2026-09-29（`D-109`）：原本寫「就算建了知識庫、客服流程也都不會生效」——後半句是錯的，
    //    自動回應不看這個開關（`handler.ts` 的 `runScriptStart` 不讀 enabled），關掉 AI 照樣在回客人。
    why: '這個開關關著的話，AI 一句都不會回客人，知識庫建得再完整也用不上。（自動回應不受影響，照常運作。）',
    required: true,
    // 總開關在 AI 設定頁，儲存是 `ai.settings.write`
    requires: 'ai.settings.write',
    route: wid => `/admin/${wid}/ai-settings`,
    tourId: 'ai-settings',
    navTarget: '[data-tour="nav-ai-settings"]',
  },
  {
    id: 'knowledgeReady',
    icon: Reading,
    title: '建立知識庫',
    why: 'AI 靠它來回答客人的問題。空的話，能回的內容會很有限。',
    required: false,
    // 「加入知識」＝`knowledge.write`（劇本 knowledge-first 同一項）
    requires: 'knowledge.write',
    route: wid => `/admin/${wid}/knowledge/sources`,
    tourId: 'knowledge',
    // 這一項的「帶我做」走劇本（D-40）：放知識是有真訊號可驗的任務——放好了沒有、
    // AI 學會了沒有、總開關開了沒有，三件事都查得到，導覽一件也收不了尾。
    // tourId 保留：頁首問號與缺項巡覽仍然用得到那支導覽。
    guideId: 'knowledge-first',
    navTarget: '[data-tour="nav-knowledge"]',
  },
  {
    id: 'scriptReady',
    icon: Operation,
    title: '啟用一條客服流程',
    why: '用來處理固定流程，例如預約、報名、領取優惠。沒有也能運作。',
    required: false,
    // ⚠️ `G-109`：照舊只給管理員（改版前是 'settings'，這次是純重構、不改誰看得到）。
    //    但這一頁實際的寫入是 `scripts.write`＝**客服就能做**，教學那支 `ai-scripts` 早在 `D-82`
    //    就放寬了，只有這一項沒跟上。要不要改成 `scripts.write` 是另一個決定，⛔ 別在重構裡順手改。
    requires: 'ai.settings.write',
    route: wid => `/admin/${wid}/ai-scripts`,
    tourId: 'ai-scripts',
    // 腳本已收進「自動回應」的第二個分頁，側欄不再有獨立的 nav-ai-scripts 可以指
    navTarget: '[data-tour="nav-auto-response"]',
  },
  {
    // 店家輪廓（`D-85` / `C-219`）：⛔ 選配項，缺它不擋上線也不拉低主進度。
    // 但它缺著的時候，節慶提醒只講得出跨產業通用的一句話——所以 why 要講這件事，
    // 不要寫成「建議填寫以獲得更好體驗」那種沒有後果的句子。
    id: 'profileReady',
    icon: Shop,
    title: '讓 MiniMe 認識你的店',
    why: '它現在只知道你的帳號名稱。補上之後，節慶提醒才講得出你的商品，AI 回客人的口氣也才像你。',
    required: false,
    // 進得了組織頁（`line.manage`）＋存得了輪廓（`store-profile.post`＝`ai.settings.write`）；
    // 行銷月曆卡的「去補輪廓」問同一份（2026-09-30 code review：兩處原本各看一半）
    requires: STORE_PROFILE_EDIT_CAPABILITIES,
    route: wid => `/admin/${wid}/settings/organization`,
    tourId: 'organization',
    navTarget: '[data-tour="nav-organization"]',
  },
  {
    // 2026-08-07 自 lineConnected 拆出：多數新客戶第一天用不到 LIFF，
    // 缺它不該讓人永遠掛在「LINE 未接通」、也不該擋「可以上線」。
    id: 'liffReady',
    icon: Iphone,
    title: '設定 LIFF（活動頁入口）',
    // ⛔ 原本寫「活動頁、會員綁定頁」——**沒有「會員綁定頁」這個東西**（app/pages/liff 底下
    // 只有 lead.vue 活動頁，綁定就發生在那一頁上）。2026-08-23 改名掃描時抓到並改掉。
    why: '客人點開活動頁（登記活動、綁定資料）會用到。要辦活動前再補就行。',
    required: false,
    // LIFF ID 填在「組織與 LINE」那一頁
    requires: 'line.manage',
    route: wid => `/admin/${wid}/settings/organization`,
    tourId: 'organization',
    navTarget: '[data-tour="nav-organization"]',
  },
]

// 注意：後端 setup-status 還會回 firstMessageReceived（收到第一則客人訊息），
// 刻意不進這份註冊表——它沒有側欄入口可給缺項巡覽指、也不是一個「去設定」的頁面。
// 開通引導精靈與後台查詢助理（SETUP_LABELS）直接使用該訊號。

/**
 * 兩次自動體檢之間的最短間隔。面板開開關關、換頁都會來要一次資料，
 * 不節流就是一連串重複查詢；而「哪幾項還沒設定」不是秒級會變的東西。
 * 使用者按「重新檢查」、或剛跑完導覽要確認有沒有生效時走 force，不受這個限制。
 */
const REFRESH_TTL_MS = 60_000

export function useSetupStatus() {
  const { workspaceId, getBearer, can } = useWorkspace()

  // 全域共享，FAB 與面板共用同一份狀態
  const rawStatusMap = useState<Record<string, SetupItemStatus>>('setup-status-map', () => ({}))
  const rawLoaded = useState('setup-status-loaded', () => false)
  /**
   * 這一輪查失敗了（⛔不是「沒做完」，是「問不到」）。
   * 2026-09-16 code review 抓到：查失敗時 `loaded` 永遠是 false，而自動導覽的判斷
   * 看到 `setupLoaded=false` 就一直回「再等等」——一次 5xx 就讓導覽與那句
   * 「這頁怎麼用？」的提示**全站永久消失，而且無聲**。有了這個旗標，判斷才知道
   * 該放棄自動導覽、把提示放出來。
   */
  const rawFailed = useState('setup-status-failed', () => false)
  const loading = useState('setup-status-loading', () => false)
  const checkedAt = useState('setup-status-checked-at', () => 0)
  /**
   * 這份結果是「哪個官方帳號」的。
   *
   * ⛔ 沒有這一欄就出過事（2026-08-23）：狀態是全域共享的一份，換帳號時沒人記得它是誰的，
   * 60 秒內再問還會被當成新鮮的直接回覆——於是從一個全新帳號（沒收過訊息）點進 MYFEEL，
   * default.vue 拿著上一家的「開通沒做完」把人整頁拉去開通引導，引導自己重查一次卻顯示
   * 兩項都完成、直接跳「接通完成」。判斷與資料一律先對得上帳號，對不上就當作沒有資料。
   */
  const checkedFor = useState('setup-status-checked-for', () => '')

  /**
   * 同一瞬間只查一次（機制見 `useSharedRequest`）。
   *
   * ⛔ 這支 composable 同一次載入就有兩個呼叫端各自 `refresh()`（`layouts/default.vue`
   * 的開通引導判定、右下角小幫手），兩邊同時發車 → 不去重就是每次開頁把體檢打兩遍
   * （2026-08-27 正式站實測：17 個工作區頁面**全部**都是兩次）。
   * 下面的 TTL 節流攔不住同時發車：第一支還沒回來，`checkedAt` 還是舊的。
   */
  const shared = useSharedRequest('setup-status')

  /** 手上這份是不是「現在這個帳號」的 */
  const cacheMatchesWorkspace = computed(() =>
    !!workspaceId.value && checkedFor.value === workspaceId.value,
  )

  /** 對外一律走這兩個：對不上帳號就是空的／沒載入過，不會把別家的答案端出來 */
  const statusMap = computed<Record<string, SetupItemStatus>>(() =>
    cacheMatchesWorkspace.value ? rawStatusMap.value : {},
  )
  const loaded = computed(() => cacheMatchesWorkspace.value && rawLoaded.value)
  /** 這次問不到（查詢失敗）。⛔ 與 loaded 分開：「還沒好」與「問不到」的下一步不一樣 */
  const failed = computed(() => rawFailed.value && !loaded.value)

  async function refresh(options: { force?: boolean } = {}): Promise<void> {
    const wid = workspaceId.value
    if (!wid)
      return
    // 只有「同一個帳號」的查詢能共用飛行中的那一支
    const already = shared.pending(wid)
    if (already)
      return already
    // 快取只對得上自己那個帳號；換了帳號一律重查，不吃 TTL
    if (!options.force && checkedFor.value === wid && checkedAt.value && Date.now() - checkedAt.value < REFRESH_TTL_MS)
      return
    loading.value = true
    return shared.start(wid, async (isLatest) => {
      try {
        const token = await getBearer()
        const data = await $fetch<SetupStatusResponse>('/api/admin/setup-status', {
          query: { workspaceId: wid },
          headers: { Authorization: `Bearer ${token}` },
        })
        // ⛔ 落地前先確認自己還是最新那一支：
        //    「A 送出 → 切到 B → B 先回來寫好 → A 才回來」是真的會發生的順序，
        //    A 一寫下去就把 checkedFor 蓋回 A：對 B 來說 cacheMatchesWorkspace 立刻變 false
        //    → 所有能力退回 unknown（面板顯示「這次查不到狀態」），更糟的是
        //    default.vue 的 maybePopOnboarding 會看到 onboardingIncomplete=false，
        //    把「其實還沒接完 LINE」的帳號放過去不再引導。
        if (!isLatest())
          return
        const next: Record<string, SetupItemStatus> = {}
        for (const item of data.items)
          next[item.id] = item.status
        rawStatusMap.value = next
        checkedFor.value = wid
        checkedAt.value = Date.now()
        rawLoaded.value = true
        rawFailed.value = false
      }
      catch {
        // 靜默失敗，保留前一次結果；不要把查不到誤報成沒做。
        // 但要留下「這次問不到」的訊號——不然等它的人會等到天荒地老（見 rawFailed）
        if (isLatest())
          rawFailed.value = true
      }
      finally {
        // 只有「最後發出的那一支」有資格收轉圈（旗標本身由 helper 收）
        if (isLatest())
          loading.value = false
      }
    })
  }

  /**
   * 清掉現有結果。換工作區時會呼叫；不過就算沒人叫，checkedFor 也會擋住跨帳號誤用——
   * 把 A 帳號「已完成」的進度條留在 B 帳號畫面上，比暫時沒有資料嚴重。
   */
  function reset() {
    rawStatusMap.value = {}
    rawLoaded.value = false
    checkedAt.value = 0
    checkedFor.value = ''
    // 上一家還在飛的那支要放掉，否則「換帳號 → reset → 立刻 refresh」會被它擋住＝
    // 新帳號等於從來沒被查過（⛔只放別家的，理由見 useSharedRequest）
    if (shared.releaseOthers(workspaceId.value ?? ''))
      loading.value = false
  }

  const capabilities = computed<ResolvedCapability[]>(() =>
    CAPABILITIES.map(c => ({ ...c, status: statusMap.value[c.id] ?? 'unknown' })),
  )

  /** 只保留「這個帳號有權限去做」的能力——沒權限的不顯示、也不算進進度與紅點 */
  const visibleCapabilities = computed(() =>
    capabilities.value.filter(c => (typeof c.requires === 'string' ? [c.requires] : c.requires).every(r => can(r))),
  )

  /** 這個帳號有沒有任何「可動手」的設定項（沒有就整個健康卡都不顯示，例如觀察者） */
  const hasItems = computed(() => visibleCapabilities.value.length > 0)

  const requiredCaps = computed(() => visibleCapabilities.value.filter(c => c.required))
  const optionalCaps = computed(() => visibleCapabilities.value.filter(c => !c.required))

  const requiredTotal = computed(() => requiredCaps.value.length)
  const requiredDone = computed(() => requiredCaps.value.filter(c => c.status === 'done').length)
  const optionalTotal = computed(() => optionalCaps.value.length)
  const optionalDone = computed(() => optionalCaps.value.filter(c => c.status === 'done').length)

  /** 主進度只看「必要」項：必要全完成 = 100%（可以上線）。沒有必要項時視為 100%。 */
  const requiredPercent = computed(() =>
    requiredTotal.value === 0
      ? 100
      : Math.round((requiredDone.value / requiredTotal.value) * 100),
  )

  /** 必要項全部完成（沒有必要項＝視為完成；unknown 不算數，用 done 數比對） */
  const allRequiredDone = computed(() => requiredDone.value === requiredTotal.value)

  const incompleteRequired = computed(() =>
    requiredCaps.value.filter(c => c.status === 'incomplete'),
  )

  /**
   * 開通對話還有沒有事可做——聊天引導按鈕與「進後台自動彈開通」的依據。
   * 範圍刻意只含開通對話真的會處理的兩件事：接上 LINE、收到第一則訊息。
   * ⛔別把 aiEnabled 算進來：開 AI 已移出開通（2026-08-19），算進來的話做完開通
   * 按鈕永遠不消失、人還會一直被拉回一個「已經沒事可做」的對話。
   * unknown 不算未完成（查不到 ≠ 沒做），沒管理權限的人（開通要 admin）一律 false。
   * `G-109`：「開通要 admin」＝接 LINE 那一頁的 `line.manage`（跟上面 lineConnected 那一項同一把尺）。
   */
  const onboardingIncomplete = computed(() =>
    can('line.manage')
    && loaded.value
    && (statusMap.value.lineConnected === 'incomplete' || statusMap.value.firstMessageReceived === 'incomplete'),
  )

  /**
   * 開通範圍的里程碑（小幫手英雄卡列「還缺哪幾步」用）。順序＝精靈裡的順序。
   *
   * ⚠️ 2026-09-22 多列一項「認識你的店」（`D-85` / `C-219`）：精靈確實會帶他做這件事，
   * 卡片上不列會變成「做了一件卡片上沒有的事」。
   * ⛔ **但它不進 `onboardingIncomplete`**：那顆旗標決定「進後台要不要把人拉回精靈」，
   *    而認識你的店是可以跳過的選配項——算進去的話，跳過的人每次進後台都被拉回一次，
   *    那正是 2026-08-20 拆掉「跳過記憶」時要解決的同一種糾纏。
   */
  const onboardingSteps = computed(() => ([
    // `optional`＝可以跳過的步驟。**「下一步要做什麼」不可以指到它**：
    // 跳過輪廓、但 LINE 還沒接的人，最急的是 LINE；指去輪廓等於把人帶去做不急的事。
    // ⚠️ 2026-09-26（`C-250`②，示意頁 v80）：做完的講成「已經是這樣了」（「…認識你的店了」），
    //    第三步跟接 LINE 那一趟的進度格同一個說法「用手機測試」（⛔ 不再叫「傳話測試」：兩處各叫一個名字）
    { id: 'profileReady', label: statusMap.value.profileReady === 'done' ? 'MiniMe 認識你的店了' : '讓 MiniMe 認識你的店', done: statusMap.value.profileReady === 'done', optional: true },
    { id: 'lineConnected', label: '接上 LINE 官方帳號', done: statusMap.value.lineConnected === 'done', optional: false },
    { id: 'firstMessageReceived', label: '用手機測試', done: statusMap.value.firstMessageReceived === 'done', optional: false },
  ]))

  /**
   * 開通期那幾句話的**單一來源**（2026-08-27）。
   *
   * 頁面級開通帶（`AdminPageAlertStrip`）與側欄那顆點（`AdminNavAlertDot`）講的是同一件事，
   * 措辭必須是同一份——兩邊各寫一次，改了一邊就開始各說各話（`ALERT_LABELS` 同一把尺）。
   * 紅色＋「講後果」沿用 2026-08-07 拍板：還沒上線本身就是大問題。
   */
  const onboardingBand = computed(() => {
    const lineDone = statusMap.value.lineConnected === 'done'
    return lineDone
      ? {
          title: 'LINE 接上了，還差最後一步測試',
          detail: '還沒收到過任何訊息——用手機對官方帳號傳一句話，確認訊息真的進得來。在那之前，後台各頁還不會有資料。',
          /** 側欄那顆點的 tooltip：短句就好，細節交給上面那條帶 */
          navTip: 'LINE 接上了，還差最後一步：用手機傳一句話測試',
          /**
           * 紅帶那顆鈕、小幫手英雄卡那顆鈕的字（`C-250`②）。⚠️ **落地導覽第 2 步會叫出這顆鈕的名字**，
           * 所以三處吃同一份——各寫一次，導覽講「按『接上 LINE』」而鈕上寫「帶我完成開通」就是假指路。
           */
          action: '用手機測試',
          heroCta: '用手機測試 →',
          /**
           * ⛔這一步刻意不圈任何欄位：要做的事是**拿手機傳一句話**，後台沒有那一格。
           * 圈「檢查連線」會變成叫人去按一顆做不到這件事的按鈕（測試連線驗的是 LINE 那邊
           * 填的網址收不收得到，不是「有客人傳過訊息」）。
           */
          mark: '',
        }
      : {
          title: 'LINE 官方帳號還沒接上',
          detail: '客人現在傳訊息進不來，後台也不會有任何紀錄——各頁看到的 0 不是沒客人，是還沒接上。',
          navTip: 'LINE 官方帳號還沒接上：客人的訊息現在進不來',
          action: '接上 LINE',
          heroCta: '接上 LINE，讓客人找得到 →',
          /**
           * 「壞掉的就是這一格」（`C-95`，2026-08-28 老闆回饋）：接不上 LINE 就是這兩格沒填。
           *
           * 起因＝老闆截圖：頁頂紅帶講「LINE 官方帳號還沒接上」，往下捲之後 Token、Secret
           * 兩個空欄位跟旁邊十幾個欄位長得一模一樣，看不出「要填的是這兩格」。
           * 兩格一起圈（`AdminPageAlertStrip` 只會把那句話掛在第一格上，不會重複兩次）。
           * ⛔只在「組織與 LINE」那一頁有這兩個錨，別頁自然什麼都不會圈。
           */
          mark: '[data-tour="org-token"], [data-tour="org-secret"]',
        }
  })

  /**
   * 開通期唯一允許亮點的側欄項＝「接上 LINE」那一項的頁面（見 `utils/nav-alert-dot.ts` 規則 3）。
   * 沿用註冊表的 `route`（跟缺項巡覽、健康卡同一份），⛔別在元件裡另寫一份路徑字串：
   * 側欄的 `to` 與這裡對不上的話，那顆點會**安靜地永遠不亮**，而沒有人會發現。
   */
  const onboardingNavPath = computed(() => {
    const wid = workspaceId.value
    if (!wid)
      return ''
    return CAPABILITIES.find(c => c.id === 'lineConnected')?.route(wid) ?? ''
  })

  /** 沒做完的項目（必要在前、進階在後，沿用註冊表順序） */
  const incompleteAll = computed(() =>
    visibleCapabilities.value.filter(c => c.status === 'incomplete'),
  )

  /** 這次查不到狀態的項目（要在 UI 現形，不能偷偷扣分又不解釋） */
  const unknownCaps = computed(() =>
    visibleCapabilities.value.filter(c => c.status === 'unknown'),
  )

  return {
    failed,
    capabilities,
    hasItems,
    incompleteRequired,
    onboardingIncomplete,
    onboardingSteps,
    onboardingBand,
    onboardingNavPath,
    incompleteAll,
    unknownCaps,
    requiredTotal,
    requiredDone,
    optionalTotal,
    optionalDone,
    requiredPercent,
    allRequiredDone,
    loaded,
    loading,
    refresh,
    reset,
  }
}
