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
  /** LINE Webhook 確定收不到（沒設定／被停用／權杖失效）——所有訊息都進不來 */
  | 'lineWebhookBroken'
  /** LINE 填的 Webhook 和正式網址不一致：舊網址還指向這套系統時訊息照進，但舊網址一失效就無聲斷線 */
  | 'lineWebhookUrlMismatch'
  /** LIFF 在 LINE 登記的開啟網址到不了活動頁（指到別的網站、或 LIFF 已被刪除）——客人點活動連結會迷路 */
  | 'liffEndpointBroken'
  /** LIFF 登記的網址跟正式網址不一致（多半是換網域沒改到）：登入會在兩個網址間繞，部分情況卡在載入中 */
  | 'liffEndpointUrlMismatch'
  /** 知識庫來源同步失敗（試算表沒分享、網頁被移走…） */
  | 'knowledgeSyncFailed'
  /** 知識卡學習失敗（embedding 失敗，這些卡答不出來） */
  | 'knowledgeIndexFailed'
  /**
   * 客服在對話上按過「AI 答錯了」、而那張知識卡到現在都還沒被改過。
   * 這是唯一「有人親眼看到 AI 答錯客人」的訊號，比任何自動偵測都確定。
   */
  | 'knowledgeWrongAnswers'
  /** 來源內容變了但還沒重新學 */
  | 'knowledgeOutdated'
  /** 有「輸入任何內容」的自動回覆規則正在攔截全部訊息，AI 等於沒開 */
  | 'anyTextBlocking'
  /** 近期 AI 服務失敗（Gemini 暴掉），客人問了沒得到回答 */
  | 'llmError'
  /** 本期則數用完，AI 已停止回覆 */
  | 'quotaExceeded'
  /** 本期則數快用完（達 80% 門檻、或照目前速度會在期末前用完）。AI 還在回，是提前量 */
  | 'quotaRunningOut'
  /** 自動扣款失敗，寬限期中 */
  | 'paymentPastDue'
  /** 發票開立失敗 */
  | 'invoiceFailed'
  /** AI 答不出來會轉真人，但沒有人會被通知 */
  | 'handoffNotifyMissing'
  /** 客人在等真人、或對話卡在「真人處理中」太久 */
  | 'humanBacklog'
  /** 「未首接」佇列有對話等超過 1 小時完全沒人回（草稿模式沒人審＝客人一句回覆都沒有） */
  | 'firstReplyBacklog'
  /** 知識卡卡在 pending 超過 1 小時沒學完（重試放生或排程沒跑），AI 檢索不到 */
  | 'knowledgeIndexStuck'
  /** 首期付款成功但約定卡沒綁成：下期不會自動扣款，會靜默降級 */
  | 'renewalNotBound'
  /** 選單／圖卡上有按鈕指向已刪除或已停用的模組，客人按了什麼都不會收到 */
  | 'brokenModuleButton'
  /** 活動推播已送出，但「這場已回應」沒蓋上章 → 客服會看到一堆假的待處理 */
  | 'claimPushUnmarked'
  /** 有推播發送失敗（近 3 天內），名單上的客人沒收到 */
  | 'broadcastFailed'
  /** 排程推播過了排定時間還沒送（排程可能卡住） */
  | 'broadcastOverdue'
  /** 背景自動維護（轉真人提醒、過期回收、資料更新偵測）心跳停了 */
  | 'maintenanceStalled'
  /** 知識庫建議收件匣有待處理草稿（客人問過但 AI 答不好的主題）。不是異常，是「可以更好」 */
  | 'knowledgeSuggestions'
  /** 有啟用中的客服流程永遠輪不到（沒填觸發詞、或被規則／敏感情境／別條腳本先接走） */
  | 'scriptUnreachable'
  /** 有客服流程中間有「客人答不出來就卡死」的步驟，走進去出不來 */
  | 'scriptDeadEnd'

/**
 * 各項的白話標題（單一事實來源）。
 * 前端異常註冊表與後台查詢助理的 get_current_alerts 工具都從這裡拿，
 * 兩邊各寫一份遲早漂移——小幫手面板和問助理講的必須是同一句話。
 */
export const ALERT_LABELS: Record<WorkspaceAlertId, string> = {
  lineWebhookBroken: '機器人收不到客人訊息',
  lineWebhookUrlMismatch: 'LINE 填的收訊網址不是正式網址',
  liffEndpointBroken: '活動連結會把客人帶去錯的地方',
  liffEndpointUrlMismatch: 'LINE 填的活動頁網址不是正式網址',
  knowledgeSyncFailed: '有資料抓不到內容',
  knowledgeIndexFailed: '有知識 AI 沒學起來',
  knowledgeOutdated: '有資料內容變了還沒重新學',
  anyTextBlocking: 'AI 被自動回覆規則擋住了',
  llmError: 'AI 服務近 24 小時失敗過',
  quotaExceeded: '本期回覆則數用完了',
  quotaRunningOut: '回覆則數快用完了',
  paymentPastDue: '自動扣款沒有成功',
  invoiceFailed: '有發票開立失敗',
  handoffNotifyMissing: '沒有人會收到轉真人通知',
  humanBacklog: '有客人在等真人回覆',
  firstReplyBacklog: '有客人的訊息一直沒人回',
  knowledgeIndexStuck: '有知識卡一直沒學完',
  renewalNotBound: '付款成功但自動扣款沒綁好',
  brokenModuleButton: '有按鈕按下去沒反應',
  claimPushUnmarked: '活動推播後有對話被誤標成待處理',
  broadcastFailed: '有推播沒有送出去',
  broadcastOverdue: '有排程推播過時間還沒送',
  maintenanceStalled: '系統自動維護沒在跑',
  knowledgeSuggestions: '有客人問過、AI 沒答好的主題',
  knowledgeWrongAnswers: '有內容被同事標記「AI 答錯了」',
  scriptUnreachable: '有客服流程永遠不會被啟動',
  scriptDeadEnd: '有客服流程客人走不完',
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
