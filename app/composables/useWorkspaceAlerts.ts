/**
 * 工作區「目前異常」資料 + 白話文異常註冊表。
 *
 * 為什麼要有這個：後台有二十幾種持續性異常（知識庫同步失敗、AI 服務暫時失敗、
 * 扣款失敗…），但幾乎全部都要「進到那一頁」才看得到。使用者沒有理由天天巡每一頁，
 * 結果就是壞了好幾天才發現。這裡把它們收成一份訊號，讓右下角小幫手主動講。
 *
 * 分工同 useSetupStatus：後端只回「有沒有、幾個」，嚴重度與白話文案在這裡。
 * 小幫手只能「轉述」這份狀態，不能自己臆測。
 */

import type { Component } from 'vue'
import { AlarmClock, Bell, ChatDotRound, CreditCard, Guide, Link, MagicStick, Odometer, Opportunity, Pointer, Promotion, Reading, Refresh, Service, Tickets, Tools } from '@element-plus/icons-vue'
import { ALERT_LABELS } from '~~/shared/types/alerts'
import type { WorkspaceAlertId, WorkspaceAlertItem, WorkspaceAlertState, WorkspaceAlertsResponse } from '~~/shared/types/alerts'

/**
 * critical   = 現在就在影響客人（客人問了得不到回答、系統停擺）。只有這一級會亮紅點。
 * warning    = 建議處理，但客人暫時不會有感。可以按「暫停提醒」靜音 7 天。
 * suggestion = 沒有東西壞掉，是「可以更好」（例如建議收件匣有草稿）。不算異常、不進紅點、
 *              不影響「目前沒有發現異常」的結論。
 *
 * 這條線要守住：什麼都算紅點，紅點就等於沒有——使用者會學會忽略它。
 */
export type AlertSeverity = 'critical' | 'warning' | 'suggestion'

export interface AlertDefinition {
  id: WorkspaceAlertId
  icon: Component
  severity: AlertSeverity
  /** 白話文：不管它會怎樣（講後果，不是講原理） */
  impact: string
  /** 按鈕上的動作字樣 */
  cta: string
  /** 處理此項所需角色（對齊後端）：settings=admin、operate=agent 以上 */
  requires: 'settings' | 'operate'
  /** 去哪裡修 */
  route: (workspaceId: string) => string
}

export interface ResolvedAlert extends AlertDefinition {
  /** 一句話、零術語標題。來自 shared 的 ALERT_LABELS——與問助理工具同一份，不會漂移 */
  title: string
  state: WorkspaceAlertState
  count?: number
  detail?: string
}

/**
 * 異常註冊表。要新增一項，往這裡加一筆並在後端 alerts 端點加上對應訊號。
 * 文案一律白話、講後果，把使用者當第一次看到這個詞的人。
 */
const ALERTS: AlertDefinition[] = [
  {
    // 所有異常裡最致命的：webhook 掛了＝訊息完全進不來，機器人等於死機
    id: 'lineWebhookBroken',
    icon: Link,
    severity: 'critical',
    impact: 'LINE 沒有把客人的訊息送進系統——機器人、AI、真人對話全都收不到，客人傳什麼都不會有回應。',
    cta: '去檢查 LINE 連接',
    requires: 'settings',
    // ?verify=webhook：進頁直接捲到「檢查連線」並實跑一次測試——
    // 使用者在卡片上已經按過一次「去檢查」，到頁面不該再自己找一遍要修什麼
    route: wid => `/admin/${wid}/settings/organization?verify=webhook`,
  },
  {
    // 2026-08-08 老闆拍板升紅：實務上「不一致」＝填著已排定停用的舊網址，是顆定時炸彈——
    // 網址一停所有訊息無聲斷掉，等真的斷了才紅就是事後通知。與 lineWebhookBroken 仍分
    // 兩張卡，因為講的話不同：這張是「快斷了、趁現在改」，那張是「已經斷了」。
    id: 'lineWebhookUrlMismatch',
    icon: Link,
    severity: 'critical',
    impact: 'LINE 後台填的收訊網址不是這套系統的正式網址，多半是換網域前的舊網址。訊息目前可能還進得來，但那個網址一停用，所有客人訊息會無聲斷掉、不會有任何預警。趁還沒斷，把 LINE 後台換成正式網址。',
    cta: '去檢查 LINE 連接',
    requires: 'settings',
    route: wid => `/admin/${wid}/settings/organization?verify=webhook`,
  },
  {
    // 與 webhook 那對同一套分級：到不了活動頁＝確定壞掉（紅）；下面那顆「網址不一致」
    // 是還到得了但會多繞（黃）。訊號來源＝LINE 公開轉址頁上登記的 Endpoint URL。
    id: 'liffEndpointBroken',
    icon: Promotion,
    severity: 'critical',
    impact: '這個 LIFF 在 LINE 登記的開啟網址不是活動頁——客人點活動連結會被帶去別的網站或看到錯誤頁，貼標與綁定完全不會發生。到 LINE Developers 把該 LIFF 的 Endpoint URL 換成設定頁的「活動 LIFF 頁」網址。',
    cta: '去檢查 LIFF 設定',
    requires: 'settings',
    // ?verify=liff：進頁直接捲到 LIFF 區塊並重新檢查一次（跳過快取）
    route: wid => `/admin/${wid}/settings/organization?verify=liff`,
  },
  {
    // 同 lineWebhookUrlMismatch，2026-08-08 拍板升紅：填著的是遲早停用的舊網址，
    // 而且現在就有感——客人登入活動頁會在兩個網址間繞，部分情況卡在載入中。
    id: 'liffEndpointUrlMismatch',
    icon: Promotion,
    severity: 'critical',
    impact: 'LINE 登記的活動頁網址不是這套系統的正式網址，多半是換網域前的舊網址。客人點活動連結登入時會在兩個網址之間繞，部分情況會卡在載入中；那個舊網址一停用，活動連結會整個打不開。把 LINE Developers 那邊換成設定頁的「活動 LIFF 頁」網址。',
    cta: '去檢查 LIFF 設定',
    requires: 'settings',
    route: wid => `/admin/${wid}/settings/organization?verify=liff`,
  },
  {
    id: 'anyTextBlocking',
    icon: ChatDotRound,
    severity: 'critical',
    impact: '有一條設定的觸發是「客人輸入任何內容」，會先接走所有訊息，客人問什麼都只會拿到那一套回應，AI 等於沒開。',
    cta: '去看這條設定',
    requires: 'operate',
    route: wid => `/admin/${wid}/ai-scripts`,
  },
  {
    id: 'llmError',
    icon: MagicStick,
    severity: 'critical',
    impact: '這些客人問了問題但 AI 當下答不出來，已轉給真人。這通常會自己恢復；若一整天都在發生，請聯絡我們處理。',
    cta: '看是哪些對話',
    requires: 'operate',
    // 帶 ?reason= 讓監控頁自動套用「AI 服務暫時失敗」篩選並捲到案例清單
    // （不帶的話落在頁頂、使用者得自己想起去下拉選原因）。
    // 一併帶 includeResolved:這個警示是看「近 24 小時發生過幾次」、不看有沒有被標處理,
    // 清單預設只顯示未處理 → 標過的那幾筆會讓人看到「N 次」卻是空清單。
    route: wid => `/admin/${wid}/ai-usage?reason=llm_error&includeResolved=1`,
  },
  {
    // 措辭與知識庫頁「要處理的事」同一句話（見 ALERT_LABELS）:
    // 兩邊講的是同一件事,不該一邊「同步失敗」一邊「抓不到內容」
    id: 'knowledgeSyncFailed',
    icon: Reading,
    severity: 'critical',
    impact: '這些資料的內容沒有更新進 AI，客人問到相關問題會得到過時或空的答案。',
    cta: '去修這些資料',
    requires: 'operate',
    // ?health= 直接開對應的問題清單:使用者在這裡已經按過一次「去修」,
    // 到頁面後不該再自己找一遍同一件事
    route: wid => `/admin/${wid}/knowledge/sources?health=failedSources`,
  },
  {
    id: 'knowledgeIndexFailed',
    icon: Reading,
    severity: 'critical',
    impact: '這些知識存進去了但 AI 讀不到，等於白建——客人問到就會答不出來。',
    cta: '去看這些知識',
    requires: 'operate',
    route: wid => `/admin/${wid}/knowledge/sources?health=failedChunks`,
  },
  {
    // critical 不是「有人回報」而已：同事看到 AI 用這條答錯客人、而它還沒被改過，
    // 代表它現在仍然在用同樣的內容回答下一位客人（紅＝正在影響客人）。
    id: 'knowledgeWrongAnswers',
    icon: Reading,
    severity: 'critical',
    impact: '同事在對話上看到 AI 用這些內容答錯客人，而它們到現在都還沒被修改過——同樣的問題會繼續答錯。',
    cta: '去修這些知識',
    requires: 'operate',
    route: wid => `/admin/${wid}/knowledge/sources?health=wrongAnswerChunks`,
  },
  {
    id: 'quotaExceeded',
    icon: Odometer,
    severity: 'critical',
    impact: 'AI 已經停止回覆，現在客人的訊息會直接轉給真人處理。',
    cta: '去升級方案',
    requires: 'settings',
    route: wid => `/admin/${wid}/settings/billing`,
  },
  {
    // 提前量：quotaExceeded 亮的時候 AI 已經停了。這顆在停之前就講
    id: 'quotaRunningOut',
    icon: Odometer,
    severity: 'warning',
    impact: '用完之後 AI 會停止回覆，客人的訊息只能等真人接手。趁還沒停先升級方案，就不會中斷。',
    cta: '去看用量與方案',
    requires: 'settings',
    route: wid => `/admin/${wid}/settings/billing`,
  },
  {
    id: 'paymentPastDue',
    icon: CreditCard,
    severity: 'critical',
    impact: '服務目前照常，但一直扣不到款會被降回免費方案、AI 停止回覆。請更新付款方式，或改用手動付款。',
    cta: '去處理付款',
    requires: 'settings',
    route: wid => `/admin/${wid}/settings/billing`,
  },
  {
    id: 'handoffNotifyMissing',
    icon: Bell,
    severity: 'warning',
    impact: 'AI 答不出來時會轉給真人，但目前沒設定要通知誰——客人可能等很久都沒人接手。',
    cta: '去設定通知對象',
    requires: 'settings',
    route: wid => `/admin/${wid}/ai-settings`,
  },
  {
    // 紅點：客人按下去真的什麼都收不到，屬於「正在影響客人」
    id: 'brokenModuleButton',
    icon: Pointer,
    severity: 'critical',
    impact: '選單、圖卡、關鍵字回覆或活動指向已刪除／已停用的模組。客人觸發時收不到任何訊息，也不會看到錯誤提示。',
    cta: '去檢查設定',
    requires: 'settings',
    route: wid => `/admin/${wid}/richmenu`,
  },
  {
    // 紅點：客人已經走進這條流程了，卡在同一題被無限重問——正在影響客人。
    // （2026-08-08 的真實災情：問訂單編號沒給「我沒有訂單編號」的退路，沒編號的客人出不去，
    //   後台完全看不出來，只有自己去測才會發現。）
    id: 'scriptDeadEnd',
    icon: Guide,
    severity: 'critical',
    impact: '這條流程中間有一題問的是客人可能根本沒有的資料（訂單編號、序號…），又沒有給「我沒有」的退路。答不出來的客人會被一直重問同一題，走不到後面任何一步。到腳本編輯器幫那一題加一顆跳過按鈕。',
    cta: '去修這條流程',
    requires: 'operate',
    route: wid => `/admin/${wid}/ai-scripts`,
  },
  {
    // 黃燈不是紅點：客人還是有 AI 或別的設定接住，壞的是「你設的流程沒生效」——
    // 沒有人正在被卡住，但你以為在跑的東西其實一次都沒跑過。
    id: 'scriptUnreachable',
    icon: Guide,
    severity: 'warning',
    impact: '這條流程啟用著，但客人講什麼都輪不到它——觸發詞沒填，或是會先被自動回覆規則、敏感情境轉真人、另一條觸發詞更寬的流程接走。換一組更明確的觸發詞，或調整擋在前面的那個設定。',
    cta: '去看這條流程',
    requires: 'operate',
    route: wid => `/admin/${wid}/ai-scripts`,
  },
  {
    id: 'firstReplyBacklog',
    icon: ChatDotRound,
    severity: 'warning',
    impact: '這些對話到現在還沒有任何人回覆過。AI 草稿模式下尤其要看：AI 只擬好草稿等人送出，沒人處理＝客人一直收不到回覆。',
    cta: '去看未回覆的對話',
    requires: 'operate',
    // 與側欄「未首接」同一份佇列口徑，直接落在該分頁
    route: wid => `/admin/${wid}/conversations?tab=open`,
  },
  {
    id: 'humanBacklog',
    icon: Service,
    severity: 'warning',
    impact: '等待中的對話 AI 不會插手。處理完記得按「交回機器人」或「結束對話」，否則 AI 會一直被暫停。',
    cta: '去看對話',
    requires: 'operate',
    // 直接落在「待真人」分頁——不帶 tab 會落在「全部」,等真人的對話要自己再切一次
    route: wid => `/admin/${wid}/conversations?tab=pending_human`,
  },
  {
    // 與 knowledgeIndexFailed（明確失敗）不同：這批是「一直沒學完」——重試放生或排程沒跑
    id: 'knowledgeIndexStuck',
    icon: Reading,
    severity: 'warning',
    impact: '這些知識卡等了超過一小時還沒學完，AI 目前讀不到它們——客人問到相關問題會答不出來。若一直卡著，請聯絡我們。',
    cta: '去看這些知識',
    requires: 'operate',
    route: wid => `/admin/${wid}/knowledge/sources`,
  },
  {
    id: 'knowledgeOutdated',
    icon: Refresh,
    severity: 'warning',
    impact: '原始網頁或試算表被改過，但 AI 還在用舊版本回答。',
    cta: '去重新同步',
    requires: 'operate',
    route: wid => `/admin/${wid}/knowledge/sources`,
  },
  {
    // 不用「蓋章 / system_notice」這種內部說法:客服看到的後果是「假的待處理」
    id: 'claimPushUnmarked',
    icon: Service,
    severity: 'warning',
    impact: '客人已經收到活動推播，但系統沒記下「已回應」，這些對話會出現在待處理清單上，其實不用處理。清單暫時會偏多，客人沒有受影響。',
    cta: '去看待處理清單',
    requires: 'operate',
    route: wid => `/admin/${wid}/conversations?tab=open`,
  },
  {
    id: 'renewalNotBound',
    icon: CreditCard,
    severity: 'warning',
    impact: '這期的錢付成功了，但自動扣款的卡片沒有綁定成功——下期不會自動扣款，方案會被降回免費、AI 停止回覆。請重新設定付款方式，或聯絡我們處理。',
    cta: '去處理付款方式',
    requires: 'settings',
    route: wid => `/admin/${wid}/settings/billing`,
  },
  {
    id: 'invoiceFailed',
    icon: Tickets,
    severity: 'warning',
    impact: '款項已收到，但發票沒開成功，通常是統編或載具格式有問題，需要補開。',
    cta: '去看付款紀錄',
    requires: 'settings',
    route: wid => `/admin/${wid}/settings/billing`,
  },
  {
    id: 'broadcastFailed',
    icon: Promotion,
    severity: 'warning',
    impact: '這批推播發送失敗，名單上的客人沒有收到訊息。進去看失敗原因，處理後可以重新發送。',
    cta: '去看推播',
    requires: 'operate',
    route: wid => `/admin/${wid}/broadcasts`,
  },
  {
    id: 'broadcastOverdue',
    icon: AlarmClock,
    severity: 'warning',
    impact: '排定的發送時間已經過了，推播卻還沒送出去——排程可能卡住了。若一直沒動，請聯絡我們。',
    cta: '去看排程',
    requires: 'operate',
    route: wid => `/admin/${wid}/broadcasts`,
  },
  {
    // 系統端問題：使用者修不了，但影響要現形（轉真人提醒、自動回收都靠它）
    id: 'maintenanceStalled',
    icon: Tools,
    severity: 'warning',
    impact: '背景的自動維護（轉真人提醒、逾時自動交回、資料更新偵測）已停擺超過一小時。這是系統端的問題，通常不用你操作；若持續一整天，請聯絡我們。',
    cta: '去看連接狀態',
    requires: 'settings',
    route: wid => `/admin/${wid}/settings/organization`,
  },
  {
    // 「可以更好」：沒有東西壞掉。建議收件匣的草稿是 AI 學習迴圈撿回來的知識缺口
    id: 'knowledgeSuggestions',
    icon: Opportunity,
    severity: 'suggestion',
    impact: '這些是客人問過、但 AI 沒答好的主題。草稿我都擬好了，採用之後 AI 下次就答得出來。',
    cta: '去看建議',
    requires: 'operate',
    route: wid => `/admin/${wid}/knowledge/sources`,
  },
]

/**
 * 各異常的嚴重度對照（單一事實來源＝上面的註冊表）。
 * 組織頁彙總跨工作區訊號時用同一把尺，不另寫第二份分級。
 */
export const ALERT_SEVERITY: Record<WorkspaceAlertId, AlertSeverity> = Object.fromEntries(
  ALERTS.map(a => [a.id, a.severity]),
) as Record<WorkspaceAlertId, AlertSeverity>

/** 兩次自動檢查之間的最短間隔：頁面切換不該每次都打一輪彙總查詢 */
const REFRESH_TTL_MS = 60_000
/**
 * 背景自動重查間隔：使用者停在同一頁時也要能發現新異常。
 * 訂在 10 分鐘是成本考量——後台整天開著就是一天幾十次查詢，
 * 而這些異常都是「壞了幾小時也還是壞著」的狀態，不需要秒級新鮮度。
 */
const POLL_INTERVAL_MS = 10 * 60_000
/** warning 靜音時長：7 天後自動恢復提醒（若問題還在） */
const SNOOZE_MS = 7 * 24 * 3600_000

export function useWorkspaceAlerts() {
  const { workspaceId, getBearer, canManageSettings, canOperate } = useWorkspace()

  // 全域共享，FAB 與面板共用同一份狀態
  const alertMap = useState<Record<string, WorkspaceAlertItem>>('workspace-alerts-map', () => ({}))
  const loaded = useState('workspace-alerts-loaded', () => false)
  const loading = useState('workspace-alerts-loading', () => false)
  const checkedAt = useState<number>('workspace-alerts-checked-at', () => 0)
  /**
   * 上一次檢查是否失敗。要現形：查不到不等於沒異常——
   * 首查就失敗時使用者得知道「還沒檢查到」，不能讓異常區靜默消失像沒事一樣；
   * 已有舊結果時也要講「這次沒查成，看到的是稍早的結果」。
   */
  const lastRefreshFailed = useState('workspace-alerts-failed', () => false)
  /** 每次有人來要資料就記一次時間；「幾分鐘前檢查」靠它重算，不會停在「剛剛」不動 */
  const tick = useState<number>('workspace-alerts-tick', () => 0)

  let inflight: Promise<void> | null = null

  async function refresh(options: { force?: boolean } = {}): Promise<void> {
    const wid = workspaceId.value
    if (!wid)
      return
    loadSnoozes(wid)
    tick.value = Date.now()
    if (inflight)
      return inflight
    // 節流：非強制刷新且剛查過就跳過（面板開開關關不該重打）
    if (!options.force && checkedAt.value && Date.now() - checkedAt.value < REFRESH_TTL_MS)
      return

    loading.value = true
    inflight = (async () => {
      try {
        const token = await getBearer()
        const data = await $fetch<WorkspaceAlertsResponse>('/api/admin/alerts', {
          // force 也要傳到後端：前端節流只是「不要重打」，後端還有一層外部查詢快取
          // （LINE webhook 那顆存五分鐘）。使用者剛改完設定回來確認時，只擋前端沒用，
          // 後端會回修好之前那份答案，變成一直說「還沒好」
          query: { workspaceId: wid, ...(options.force ? { force: '1' } : {}) },
          headers: { Authorization: `Bearer ${token}` },
        })
        const next: Record<string, WorkspaceAlertItem> = {}
        for (const item of data.items)
          next[item.id] = item
        alertMap.value = next
        checkedAt.value = data.checkedAt || Date.now()
        loaded.value = true
        lastRefreshFailed.value = false
      }
      catch {
        // 保留前一次結果（查不到不等於沒異常，不清空既有警訊），但失敗要現形
        lastRefreshFailed.value = true
      }
      finally {
        loading.value = false
        inflight = null
      }
    })()
    return inflight
  }

  /**
   * 清掉現有結果。換工作區時一定要呼叫：把 A 帳號的「扣款失敗」留在 B 帳號畫面上，
   * 比暫時沒有資料嚴重得多。
   */
  function reset() {
    alertMap.value = {}
    loaded.value = false
    checkedAt.value = 0
    lastRefreshFailed.value = false
    snoozedMap.value = {} // 換工作區後由下一次 refresh 重新載入該工作區的靜音
  }

  // ── 靜音（只有 warning 可以）─────────────────────────────────
  // 使用者對「知道了但暫時不處理」的 warning 沒有出口的話，清單會養成被整片忽略的習慣。
  // critical 不給靜音：正在影響客人的事沒有「不想看」這個選項。
  const snoozedMap = useState<Record<string, number>>('workspace-alerts-snoozed', () => ({}))

  function snoozeStoreKey(wid: string) {
    return `ta-alert-snooze:${wid}`
  }
  /** 從 localStorage 載入未過期的靜音（refresh 時呼叫，過期項順手清掉） */
  function loadSnoozes(wid: string) {
    if (!import.meta.client)
      return
    try {
      const raw = JSON.parse(localStorage.getItem(snoozeStoreKey(wid)) ?? '{}') as Record<string, number>
      const now = Date.now()
      snoozedMap.value = Object.fromEntries(
        Object.entries(raw).filter(([, until]) => typeof until === 'number' && until > now),
      )
    }
    catch {
      snoozedMap.value = {}
    }
  }
  function persistSnoozes(wid: string) {
    try {
      localStorage.setItem(snoozeStoreKey(wid), JSON.stringify(snoozedMap.value))
    }
    catch {}
  }
  function snoozeAlert(id: WorkspaceAlertId) {
    const wid = workspaceId.value
    if (!wid)
      return
    if (ALERTS.find(a => a.id === id)?.severity !== 'warning')
      return
    snoozedMap.value = { ...snoozedMap.value, [id]: Date.now() + SNOOZE_MS }
    persistSnoozes(wid)
  }
  function unsnoozeAll() {
    const wid = workspaceId.value
    if (!wid)
      return
    snoozedMap.value = {}
    persistSnoozes(wid)
  }
  function isSnoozed(a: ResolvedAlert) {
    return a.severity === 'warning' && (snoozedMap.value[a.id] ?? 0) > Date.now()
  }

  /** 只保留「這個帳號有權限去處理」的項目——沒權限的不顯示、也不算進紅點 */
  const visibleAlerts = computed<ResolvedAlert[]>(() =>
    ALERTS
      .filter(a => (a.requires === 'settings' ? canManageSettings.value : canOperate.value))
      .map((a) => {
        const item = alertMap.value[a.id]
        // 標題來自 shared 的 ALERT_LABELS：面板與問助理工具講同一句話
        return { ...a, title: ALERT_LABELS[a.id], state: item?.state ?? 'unknown', count: item?.count, detail: item?.detail }
      }),
  )

  /**
   * 進行中的「異常」：不含 suggestion（那是可以更好，不是壞掉）、不含被靜音的 warning。
   * critical 一律排前（註冊表順序是維護順序，不是急迫順序）。
   */
  const activeAlerts = computed(() =>
    [...visibleAlerts.value.filter(a => a.state === 'active' && a.severity !== 'suggestion' && !isSnoozed(a))]
      .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1)),
  )
  const criticalAlerts = computed(() => activeAlerts.value.filter(a => a.severity === 'critical'))
  const warningAlerts = computed(() => activeAlerts.value.filter(a => a.severity === 'warning'))
  /** 「可以更好」：建議類，另立一區呈現，不進異常結論 */
  const suggestionAlerts = computed(() =>
    visibleAlerts.value.filter(a => a.state === 'active' && a.severity === 'suggestion'),
  )
  /** 被靜音但其實還在發生的 warning：要現形（「已暫停提醒 N 項」），不能像沒事一樣 */
  const snoozedAlerts = computed(() =>
    visibleAlerts.value.filter(a => a.state === 'active' && isSnoozed(a)),
  )

  /** 這次查不到狀態的項目（要現形，不能偷偷當成沒事） */
  const unknownAlerts = computed(() =>
    loaded.value ? visibleAlerts.value.filter(a => a.state === 'unknown') : [],
  )

  /** 「上次檢查」的白話說法，給面板顯示資料有多新 */
  const checkedAgo = computed(() => {
    if (!checkedAt.value)
      return ''
    const mins = Math.floor((Math.max(tick.value, checkedAt.value) - checkedAt.value) / 60_000)
    if (mins < 1)
      return '剛剛檢查過'
    if (mins < 60)
      return `${mins} 分鐘前檢查`
    return `${Math.floor(mins / 60)} 小時前檢查`
  })

  return {
    alerts: visibleAlerts,
    activeAlerts,
    criticalAlerts,
    warningAlerts,
    suggestionAlerts,
    snoozedAlerts,
    unknownAlerts,
    loaded,
    loading,
    lastRefreshFailed,
    checkedAt,
    checkedAgo,
    refresh,
    reset,
    snoozeAlert,
    unsnoozeAll,
    POLL_INTERVAL_MS,
  }
}
