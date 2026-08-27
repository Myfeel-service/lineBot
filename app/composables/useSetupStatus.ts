/**
 * 工作區「設定就緒度」資料 + 白話文能力註冊表。
 *
 * 教學 agent 的核心地基：所有「你哪裡沒做完」都來自後端 setup-status 的真實訊號，
 * 這裡只負責抓資料、配上白話文文案/路由/對應導覽，並算出完成度。
 * agent 只能「轉述」這份狀態，不能自己臆測。
 */

import type { Component } from 'vue'
import { Iphone, Link, MagicStick, Operation, Reading } from '@element-plus/icons-vue'
import type { SetupCapabilityId, SetupItemStatus, SetupStatusResponse } from '~~/shared/types/setup'

export interface SetupCapability {
  id: SetupCapabilityId
  icon: Component
  /** 一句話、零術語：這是什麼 */
  title: string
  /** 白話文：為什麼要做 / 不做會怎樣 */
  why: string
  /** 必要能力（會算進「還差幾項」與按鈕上的紅點） */
  required: boolean
  /** 設定此項所需角色（對齊後端 write API）：settings=admin、operate=agent 以上 */
  requires: 'settings' | 'operate'
  /** 沒做完時，前往設定的頁面 */
  route: (workspaceId: string) => string
  /** 若有對應的逐步導覽，填教學主題 id（對應 useTutorial 的 topic） */
  tourId?: string
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
    requires: 'settings',
    route: wid => `/admin/${wid}/settings/organization`,
    tourId: 'organization',
    navTarget: '[data-tour="nav-organization"]',
  },
  {
    id: 'aiEnabled',
    icon: MagicStick,
    title: '開啟 AI 自動回覆',
    why: '這個開關關著的話，就算建了知識庫、腳本也都不會生效。',
    required: true,
    requires: 'settings',
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
    requires: 'operate',
    route: wid => `/admin/${wid}/knowledge/sources`,
    tourId: 'knowledge',
    navTarget: '[data-tour="nav-knowledge"]',
  },
  {
    id: 'scriptReady',
    icon: Operation,
    title: '啟用一支客服腳本',
    why: '用來處理固定流程，例如預約、報名、領取優惠。沒有也能運作。',
    required: false,
    requires: 'settings',
    route: wid => `/admin/${wid}/ai-scripts`,
    tourId: 'ai-scripts',
    // 腳本已收進「自動回應」的第二個分頁，側欄不再有獨立的 nav-ai-scripts 可以指
    navTarget: '[data-tour="nav-auto-response"]',
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
    requires: 'settings',
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
  const { workspaceId, getBearer, canManageSettings, canOperate } = useWorkspace()

  // 全域共享，FAB 與面板共用同一份狀態
  const rawStatusMap = useState<Record<string, SetupItemStatus>>('setup-status-map', () => ({}))
  const rawLoaded = useState('setup-status-loaded', () => false)
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
   * 飛行中的那一支也要放進**共用狀態**（連同它是誰的、第幾號）。
   *
   * ⛔ 用函式內的 `let` 等於每個呼叫端各自一份閂：這支 composable 同一次載入就有兩個
   * 呼叫端各自 `refresh()`（`layouts/default.vue` 的開通引導判定、右下角小幫手），
   * 兩邊同時發車、互相看不到對方在查 → 每次開頁都把體檢打兩遍
   * （2026-08-27 正式站實測：17 個工作區頁面**全部**都是兩次）。
   * 下面的 TTL 節流攔不住同時發車：第一支還沒回來，`checkedAt` 還是舊的。
   * 寫法與 `useWorkspace` 的 `workspace:loadInFlight` 一致。
   */
  const inflight = useState<Promise<void> | null>('setup-status-inflight', () => null)
  const inflightFor = useState('setup-status-inflight-for', () => '')
  const inflightTicket = useState('setup-status-inflight-ticket', () => 0)

  /** 手上這份是不是「現在這個帳號」的 */
  const cacheMatchesWorkspace = computed(() =>
    !!workspaceId.value && checkedFor.value === workspaceId.value,
  )

  /** 對外一律走這兩個：對不上帳號就是空的／沒載入過，不會把別家的答案端出來 */
  const statusMap = computed<Record<string, SetupItemStatus>>(() =>
    cacheMatchesWorkspace.value ? rawStatusMap.value : {},
  )
  const loaded = computed(() => cacheMatchesWorkspace.value && rawLoaded.value)

  async function refresh(options: { force?: boolean } = {}): Promise<void> {
    const wid = workspaceId.value
    if (!wid)
      return
    // 只有「同一個帳號」的查詢能共用飛行中的那一支
    if (inflight.value && inflightFor.value === wid)
      return inflight.value
    // 快取只對得上自己那個帳號；換了帳號一律重查，不吃 TTL
    if (!options.force && checkedFor.value === wid && checkedAt.value && Date.now() - checkedAt.value < REFRESH_TTL_MS)
      return
    loading.value = true
    inflightFor.value = wid
    const ticket = ++inflightTicket.value
    const task = (async () => {
      try {
        const token = await getBearer()
        const data = await $fetch<SetupStatusResponse>('/api/admin/setup-status', {
          query: { workspaceId: wid },
          headers: { Authorization: `Bearer ${token}` },
        })
        // ⛔ 落地前先確認自己還是最新那一支：ticket 只守 finally 是不夠的。
        //    「A 送出 → 切到 B → B 先回來寫好 → A 才回來」是真的會發生的順序，
        //    A 一寫下去就把 checkedFor 蓋回 A：對 B 來說 cacheMatchesWorkspace 立刻變 false
        //    → 所有能力退回 unknown（面板顯示「這次查不到狀態」），更糟的是
        //    default.vue 的 maybePopOnboarding 會看到 onboardingIncomplete=false，
        //    把「其實還沒接完 LINE」的帳號放過去不再引導。
        if (inflightTicket.value !== ticket)
          return
        const next: Record<string, SetupItemStatus> = {}
        for (const item of data.items)
          next[item.id] = item.status
        rawStatusMap.value = next
        checkedFor.value = wid
        checkedAt.value = Date.now()
        rawLoaded.value = true
      }
      catch {
        // 靜默失敗，保留前一次結果；不要把查不到誤報成沒做
      }
      finally {
        // 只有「最後發出的那一支」有資格收尾——中途換帳號時舊的那支落地不能把新的清掉
        if (inflightTicket.value === ticket) {
          loading.value = false
          inflight.value = null
          inflightFor.value = ''
        }
      }
    })()
    inflight.value = task
    return task
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
    // 上一家還在飛的那支要放掉，否則「換帳號 → reset → 立刻 refresh」會被它擋住
    // （共用 promise 的代價），新帳號等於從來沒被查過。++ticket 讓它落地時自己認出已被接手。
    //
    // ⛔ 但**只放掉別家的**：切帳號時 layout 的開通判定往往比這裡先一步、已經替新帳號
    // 送出查詢了，連它一起放掉的話後面那次 refresh 會再送一支一模一樣的（實測：
    // 切帳號時 setup-status 變成兩次）。同一家的就留著讓後面的 refresh 共用。
    if (inflightFor.value !== (workspaceId.value ?? '')) {
      inflight.value = null
      inflightFor.value = ''
      inflightTicket.value++
      loading.value = false
    }
  }

  const capabilities = computed<ResolvedCapability[]>(() =>
    CAPABILITIES.map(c => ({ ...c, status: statusMap.value[c.id] ?? 'unknown' })),
  )

  /** 只保留「這個帳號有權限去做」的能力——沒權限的不顯示、也不算進進度與紅點 */
  const visibleCapabilities = computed(() =>
    capabilities.value.filter(c =>
      c.requires === 'settings' ? canManageSettings.value : canOperate.value,
    ),
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
   */
  const onboardingIncomplete = computed(() =>
    canManageSettings.value
    && loaded.value
    && (statusMap.value.lineConnected === 'incomplete' || statusMap.value.firstMessageReceived === 'incomplete'),
  )

  /** 開通範圍的兩個里程碑（小幫手英雄卡列「還缺哪幾步」用；跟 onboardingIncomplete 同一把尺） */
  const onboardingSteps = computed(() => ([
    { id: 'lineConnected', label: '接上 LINE 官方帳號', done: statusMap.value.lineConnected === 'done' },
    { id: 'firstMessageReceived', label: '收到第一則訊息（傳話測試）', done: statusMap.value.firstMessageReceived === 'done' },
  ]))

  /** 沒做完的項目（必要在前、進階在後，沿用註冊表順序） */
  const incompleteAll = computed(() =>
    visibleCapabilities.value.filter(c => c.status === 'incomplete'),
  )

  /** 這次查不到狀態的項目（要在 UI 現形，不能偷偷扣分又不解釋） */
  const unknownCaps = computed(() =>
    visibleCapabilities.value.filter(c => c.status === 'unknown'),
  )

  return {
    capabilities,
    hasItems,
    incompleteRequired,
    onboardingIncomplete,
    onboardingSteps,
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
