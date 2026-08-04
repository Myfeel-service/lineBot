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
import { Bell, ChatDotRound, CreditCard, MagicStick, Odometer, Pointer, Reading, Refresh, Service, Tickets } from '@element-plus/icons-vue'
import type { WorkspaceAlertId, WorkspaceAlertItem, WorkspaceAlertState, WorkspaceAlertsResponse } from '~~/shared/types/alerts'

/**
 * critical = 現在就在影響客人（客人問了得不到回答、系統停擺）。只有這一級會亮紅點。
 * warning  = 建議處理，但客人暫時不會有感。
 *
 * 這條線要守住：什麼都算紅點，紅點就等於沒有——使用者會學會忽略它。
 */
export type AlertSeverity = 'critical' | 'warning'

export interface AlertDefinition {
  id: WorkspaceAlertId
  icon: Component
  severity: AlertSeverity
  /** 一句話、零術語：發生了什麼事 */
  title: string
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
    id: 'anyTextBlocking',
    icon: ChatDotRound,
    severity: 'critical',
    title: 'AI 被自動回覆規則擋住了',
    impact: '有一條「輸入任何內容」的規則會先接走所有訊息，客人問什麼都只會拿到那句罐頭回覆，AI 等於沒開。',
    cta: '去看這條規則',
    requires: 'operate',
    route: wid => `/admin/${wid}/auto-reply`,
  },
  {
    id: 'llmError',
    icon: MagicStick,
    severity: 'critical',
    title: 'AI 服務近期失敗過',
    impact: '這些客人問了問題但 AI 當下答不出來，已轉給真人。若持續發生請先確認 AI 供應商狀態。',
    cta: '看是哪些對話',
    requires: 'operate',
    // 帶 ?reason= 讓監控頁自動套用「AI 服務暫時失敗」篩選並捲到案例清單
    // （不帶的話落在頁頂、使用者得自己想起去下拉選原因）。
    // 一併帶 includeResolved:這個警示是看「近 24 小時發生過幾次」、不看有沒有被標處理,
    // 清單預設只顯示未處理 → 標過的那幾筆會讓人看到「N 次」卻是空清單。
    route: wid => `/admin/${wid}/ai-usage?reason=llm_error&includeResolved=1`,
  },
  {
    id: 'knowledgeSyncFailed',
    icon: Reading,
    severity: 'critical',
    title: '有資料同步失敗',
    impact: '這些資料的內容沒有更新進 AI，客人問到相關問題會得到過時或空的答案。',
    cta: '去修這些資料',
    requires: 'operate',
    route: wid => `/admin/${wid}/knowledge/sources`,
  },
  {
    id: 'knowledgeIndexFailed',
    icon: Reading,
    severity: 'critical',
    title: '有知識沒學起來',
    impact: '這些知識存進去了但 AI 讀不到，等於白建——客人問到就會答不出來。',
    cta: '去看這些知識',
    requires: 'operate',
    route: wid => `/admin/${wid}/knowledge/sources`,
  },
  {
    id: 'quotaExceeded',
    icon: Odometer,
    severity: 'critical',
    title: '本期回覆則數用完了',
    impact: 'AI 已經停止回覆，現在客人的訊息會直接轉給真人處理。',
    cta: '去升級方案',
    requires: 'settings',
    route: wid => `/admin/${wid}/settings/billing`,
  },
  {
    id: 'paymentPastDue',
    icon: CreditCard,
    severity: 'critical',
    title: '自動扣款沒有成功',
    impact: '服務還在跑，但寬限期過了會被降回免費方案。請更新付款方式或改用手動付款。',
    cta: '去處理付款',
    requires: 'settings',
    route: wid => `/admin/${wid}/settings/billing`,
  },
  {
    id: 'handoffNotifyMissing',
    icon: Bell,
    severity: 'warning',
    title: '沒有人會收到轉真人通知',
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
    title: '有按鈕按下去沒反應',
    impact: '選單或圖卡上的按鈕指向已刪除／已停用的模組。客人按了收不到任何訊息，也不會看到錯誤提示。',
    cta: '去檢查選單按鈕',
    requires: 'settings',
    route: wid => `/admin/${wid}/richmenu`,
  },
  {
    id: 'humanBacklog',
    icon: Service,
    severity: 'warning',
    title: '有客人在等真人回覆',
    impact: '等待中的對話 AI 不會插手。處理完記得按「交回機器人」或「結束對話」，否則 AI 會一直被暫停。',
    cta: '去看對話',
    requires: 'operate',
    // 直接落在「待真人」分頁——不帶 tab 會落在「全部」,等真人的對話要自己再切一次
    route: wid => `/admin/${wid}/conversations?tab=pending_human`,
  },
  {
    id: 'knowledgeOutdated',
    icon: Refresh,
    severity: 'warning',
    title: '有資料內容變了還沒重新學',
    impact: '原始網頁或試算表被改過，但 AI 還在用舊版本回答。',
    cta: '去重新同步',
    requires: 'operate',
    route: wid => `/admin/${wid}/knowledge/sources`,
  },
  {
    id: 'invoiceFailed',
    icon: Tickets,
    severity: 'warning',
    title: '有發票開立失敗',
    impact: '款項已收到，但發票沒開成功，通常是統編或載具格式有問題，需要補開。',
    cta: '去看付款紀錄',
    requires: 'settings',
    route: wid => `/admin/${wid}/settings/billing`,
  },
]

/** 兩次自動檢查之間的最短間隔：頁面切換不該每次都打一輪彙總查詢 */
const REFRESH_TTL_MS = 60_000
/**
 * 背景自動重查間隔：使用者停在同一頁時也要能發現新異常。
 * 訂在 10 分鐘是成本考量——後台整天開著就是一天幾十次查詢，
 * 而這些異常都是「壞了幾小時也還是壞著」的狀態，不需要秒級新鮮度。
 */
const POLL_INTERVAL_MS = 10 * 60_000

export function useWorkspaceAlerts() {
  const { workspaceId, getBearer, canManageSettings, canOperate } = useWorkspace()

  // 全域共享，FAB 與面板共用同一份狀態
  const alertMap = useState<Record<string, WorkspaceAlertItem>>('workspace-alerts-map', () => ({}))
  const loaded = useState('workspace-alerts-loaded', () => false)
  const loading = useState('workspace-alerts-loading', () => false)
  const checkedAt = useState<number>('workspace-alerts-checked-at', () => 0)
  /** 每次有人來要資料就記一次時間；「幾分鐘前檢查」靠它重算，不會停在「剛剛」不動 */
  const tick = useState<number>('workspace-alerts-tick', () => 0)

  let inflight: Promise<void> | null = null

  async function refresh(options: { force?: boolean } = {}): Promise<void> {
    const wid = workspaceId.value
    if (!wid)
      return
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
          query: { workspaceId: wid },
          headers: { Authorization: `Bearer ${token}` },
        })
        const next: Record<string, WorkspaceAlertItem> = {}
        for (const item of data.items)
          next[item.id] = item
        alertMap.value = next
        checkedAt.value = data.checkedAt || Date.now()
        loaded.value = true
      }
      catch {
        // 靜默失敗，保留前一次結果；查不到不等於沒異常，也不要清空既有警訊
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
  }

  /** 只保留「這個帳號有權限去處理」的異常——沒權限的不顯示、也不算進紅點 */
  const visibleAlerts = computed<ResolvedAlert[]>(() =>
    ALERTS
      .filter(a => (a.requires === 'settings' ? canManageSettings.value : canOperate.value))
      .map((a) => {
        const item = alertMap.value[a.id]
        return { ...a, state: item?.state ?? 'unknown', count: item?.count, detail: item?.detail }
      }),
  )

  const activeAlerts = computed(() => visibleAlerts.value.filter(a => a.state === 'active'))
  const criticalAlerts = computed(() => activeAlerts.value.filter(a => a.severity === 'critical'))
  const warningAlerts = computed(() => activeAlerts.value.filter(a => a.severity === 'warning'))

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
    unknownAlerts,
    loaded,
    loading,
    checkedAt,
    checkedAgo,
    refresh,
    reset,
    POLL_INTERVAL_MS,
  }
}
