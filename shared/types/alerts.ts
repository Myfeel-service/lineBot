/**
 * 工作區「目前異常」共用型別。
 *
 * 與 setup（就緒度）的分工：
 *   setup  = 「你還沒做」——第一次上線前的設定清單，做完就不再出現。
 *   alerts = 「本來會動的東西壞了」——上線後才會發生，修好就消失、壞了又會回來。
 *
 * 後端 GET /api/admin/alerts 只回「有沒有、幾個、一句話補充」這種訊號；
 * 白話文文案、嚴重度、去哪一頁修，放在前端的異常註冊表
 * （app/composables/useWorkspaceAlerts.ts），這裡只共用 id 與狀態。
 */

export type WorkspaceAlertId =
  /** 知識庫來源同步失敗（試算表沒分享、網頁被移走…） */
  | 'knowledgeSyncFailed'
  /** 知識卡學習失敗（embedding 失敗，這些卡答不出來） */
  | 'knowledgeIndexFailed'
  /** 來源內容變了但還沒重新學 */
  | 'knowledgeOutdated'
  /** 有「輸入任何內容」的自動回覆規則正在攔截全部訊息，AI 等於沒開 */
  | 'anyTextBlocking'
  /** 近期 AI 服務失敗（Gemini 暴掉），客人問了沒得到回答 */
  | 'llmError'
  /** 本期則數用完，AI 已停止回覆 */
  | 'quotaExceeded'
  /** 自動扣款失敗，寬限期中 */
  | 'paymentPastDue'
  /** 發票開立失敗 */
  | 'invoiceFailed'
  /** AI 答不出來會轉真人，但沒有人會被通知 */
  | 'handoffNotifyMissing'
  /** 客人在等真人、或對話卡在「真人處理中」太久 */
  | 'humanBacklog'
  /** 選單／圖卡上有按鈕指向已刪除或已停用的模組，客人按了什麼都不會收到 */
  | 'brokenModuleButton'
  /** 活動推播已送出，但「這場已回應」沒蓋上章 → 客服會看到一堆假的待處理 */
  | 'claimPushUnmarked'
  /** 知識庫建議收件匣有待處理草稿（客人問過但 AI 答不好的主題）。不是異常，是「可以更好」 */
  | 'knowledgeSuggestions'

/**
 * 各項的白話標題（單一事實來源）。
 * 前端異常註冊表與後台查詢助理的 get_current_alerts 工具都從這裡拿，
 * 兩邊各寫一份遲早漂移——小幫手面板和問助理講的必須是同一句話。
 */
export const ALERT_LABELS: Record<WorkspaceAlertId, string> = {
  knowledgeSyncFailed: '有資料抓不到內容',
  knowledgeIndexFailed: '有知識 AI 沒學起來',
  knowledgeOutdated: '有資料內容變了還沒重新學',
  anyTextBlocking: 'AI 被自動回覆規則擋住了',
  llmError: 'AI 服務近 24 小時失敗過',
  quotaExceeded: '本期回覆則數用完了',
  paymentPastDue: '自動扣款沒有成功',
  invoiceFailed: '有發票開立失敗',
  handoffNotifyMissing: '沒有人會收到轉真人通知',
  humanBacklog: '有客人在等真人回覆',
  brokenModuleButton: '有按鈕按下去沒反應',
  claimPushUnmarked: '活動推播後有對話被誤標成待處理',
  knowledgeSuggestions: '有客人問過、AI 沒答好的主題',
}

/**
 * active = 現在有這個問題；clear = 檢查過沒問題；
 * unknown = 這次查不到（查詢失敗或沒權限看），**不等於沒問題**，UI 要誠實講。
 */
export type WorkspaceAlertState = 'active' | 'clear' | 'unknown'

export interface WorkspaceAlertItem {
  id: WorkspaceAlertId
  state: WorkspaceAlertState
  /** 影響幾個（來源數 / 卡數 / 筆數）；沒有數量概念的異常不帶。 */
  count?: number
  /** 一句話補充，直接顯示給使用者看（例如失敗原因、最久等待時數）。 */
  detail?: string
}

export interface WorkspaceAlertsResponse {
  workspaceId: string
  items: WorkspaceAlertItem[]
  /** 這次檢查完成的時間（epoch ms），給前端顯示「幾分鐘前檢查」。 */
  checkedAt: number
}
