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
  /**
   * 同一個 LINE 官方帳號同時被兩個工作區接著：客人的訊息只會進到簽章先對上的那一邊，
   * 另一邊一則都收不到，而且兩邊的檢查看起來都是綠的（2026-08-19 實測挖到）。
   */
  | 'lineChannelConflict'
  /**
   * 有活動在跑，但活動自己沒指定 LIFF、工作區也沒有預設 LIFF＝活動連結在外面點下去打不開。
   * 條件式：沒開活動的帳號不需要 LIFF，不會亮這顆。
   */
  | 'liffMissing'
  /** LIFF 在 LINE 登記的開啟網址到不了活動頁（指到別的網站、或 LIFF 已被刪除）——客人點活動連結會迷路 */
  | 'liffEndpointBroken'
  /** LIFF 登記的網址跟正式網址不一致（多半是換網域沒改到）：登入會在兩個網址間繞，部分情況卡在載入中 */
  | 'liffEndpointUrlMismatch'
  /** 知識庫來源同步失敗（試算表沒分享、網頁被移走…） */
  | 'knowledgeSyncFailed'
  /** 網址來源每輪抓到的內容都不同＝變動偵測形同關閉（輪播/隨機區塊首頁必落入；官網改版不會通知） */
  | 'knowledgeDetectStalled'
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
  /**
   * AI 讀對話的背景掃描（貼標建議／發現新標籤）連續失敗中。
   * ⛔ 判定看的是**掃描器自己記下的失敗**，不是「游標有沒有前進」——
   *    追上進度後本來就不會寫入，拿游標當訊號會整天誤報（見 shared/scanner-health.ts）。
   */
  | 'scannerStalled'
  /** 知識庫建議收件匣有待處理草稿（客人問過但 AI 答不好的主題）。不是異常，是「可以更好」 */
  | 'knowledgeSuggestions'
  /** AI 從對話裡發現了「還沒有標籤」的新主題，等人決定要不要建。不是異常，是「可以更好」 */
  | 'tagDiscoverySuggestions'
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
  lineChannelConflict: '這個 LINE 帳號同時接在兩個地方',
  liffMissing: '活動連結點下去會打不開',
  liffEndpointBroken: '活動連結會把客人帶去錯的地方',
  liffEndpointUrlMismatch: 'LINE 填的活動頁網址不是正式網址',
  knowledgeSyncFailed: '有資料抓不到內容',
  knowledgeDetectStalled: '有網址的自動偵測失效',
  knowledgeIndexFailed: '有知識 AI 沒學起來',
  knowledgeOutdated: '有資料內容變了還沒重新學',
  anyTextBlocking: 'AI 被自動回覆規則擋住了',
  llmError: 'AI 服務近 24 小時失敗過',
  quotaExceeded: '本期回覆則數用完了',
  quotaRunningOut: '回覆則數快用完了',
  paymentPastDue: '自動扣款沒有成功',
  // 對客戶顯示「開立中」不是「失敗」（2026-08-16 拍板;系統每日自動補開、客戶無事可做）;
  // 真實 failed 狀態超管在金流總覽看
  invoiceFailed: '有發票還在開立中',
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
  scannerStalled: 'AI 讀對話的背景掃描一直失敗',
  knowledgeSuggestions: '有客人問過、AI 沒答好的主題',
  tagDiscoverySuggestions: 'AI 從對話裡發現可以建的新標籤',
  knowledgeWrongAnswers: '有內容被同事標記「AI 答錯了」',
  scriptUnreachable: '有客服流程永遠不會被啟動',
  scriptDeadEnd: '有客服流程客人走不完',
}

/**
 * critical   = 現在就在影響客人（客人問了得不到回答、系統停擺）。只有這一級會亮紅點，
 *              也只有這一級會主動推到 LINE。
 * warning    = 建議處理，但客人暫時不會有感。可以在面板上按「暫停提醒」靜音 7 天。
 * suggestion = 沒有東西壞掉，是「可以更好」（例如建議收件匣有草稿）。不算異常、不進紅點。
 *
 * 這條線要守住：什麼都算紅點，紅點就等於沒有——使用者會學會忽略它。
 */
export type AlertSeverity = 'critical' | 'warning' | 'suggestion'

/**
 * 各異常的嚴重度（**單一事實來源**）。
 *
 * 2026-08-21 從前端註冊表搬到 shared：分級原本只有畫面知道，但排程要決定
 * 「哪些該主動推到商家的 LINE」也得用同一把尺（`D-8`②）。前後端各留一份分級，
 * 遲早會出現「畫面是紅的、推播不推」這種對不起來的狀況。
 * 文案（ALERT_LABELS）早就是這樣共用的，分級跟著同一個做法。
 */
export const ALERT_SEVERITY: Record<WorkspaceAlertId, AlertSeverity> = {
  lineWebhookBroken: 'critical',
  lineWebhookUrlMismatch: 'critical',
  lineChannelConflict: 'critical',
  liffMissing: 'critical',
  liffEndpointBroken: 'critical',
  liffEndpointUrlMismatch: 'critical',
  anyTextBlocking: 'critical',
  llmError: 'critical',
  knowledgeSyncFailed: 'critical',
  knowledgeDetectStalled: 'warning',
  knowledgeIndexFailed: 'critical',
  knowledgeWrongAnswers: 'critical',
  quotaExceeded: 'critical',
  quotaRunningOut: 'warning',
  paymentPastDue: 'critical',
  handoffNotifyMissing: 'warning',
  brokenModuleButton: 'critical',
  scriptDeadEnd: 'critical',
  scriptUnreachable: 'warning',
  firstReplyBacklog: 'warning',
  humanBacklog: 'warning',
  knowledgeIndexStuck: 'warning',
  knowledgeOutdated: 'warning',
  claimPushUnmarked: 'warning',
  renewalNotBound: 'warning',
  invoiceFailed: 'suggestion',
  broadcastFailed: 'warning',
  broadcastOverdue: 'warning',
  maintenanceStalled: 'warning',
  scannerStalled: 'warning',
  knowledgeSuggestions: 'suggestion',
  tagDiscoverySuggestions: 'suggestion',
}

/**
 * 「這是系統這邊的狀況，使用者動不了手」（2026-08-21 老闆拍板做，原 `D-8`③）。
 *
 * 外部服務暫時掛掉、背景排程沒跑、我方蓋章漏掉——使用者去點任何按鈕都不會讓它好。
 * 這些項目仍然照嚴重度顯示（llmError 就是客人問了得不到回答），但畫面與推播都要
 * 明講「不用你操作」，否則使用者會反覆點進去找不到能做的事，最後學會忽略整個面板。
 *
 * ⛔ 不要因為「使用者不用動手」就把它降級或藏起來：嚴重度看的是客人受多少影響，
 *    與誰動手無關。
 */
export const SYSTEM_OWNED_ALERTS: ReadonlySet<WorkspaceAlertId> = new Set<WorkspaceAlertId>([
  'llmError',
  'claimPushUnmarked',
  'maintenanceStalled',
  'scannerStalled',
  'broadcastOverdue',
  'knowledgeIndexStuck',
  'invoiceFailed',
])

/**
 * 每日摘要尾巴會順路提的黃級異常（`D-36`①，2026-08-27 拍板）。
 *
 * 黃級本來只在後台顯示——「推播沒送出去」這種事，商家幾天不開後台就永遠不知道。
 * 摘要要發的時候順路查一次、尾巴加一行，不開新通知、不加提醒疲勞。
 *
 * 挑選規則（新的黃級異常要不要進來，照這四條判）：
 * ① 要人動手的才進——SYSTEM_OWNED「不用你操作」的事佔摘要版面只會稀釋
 * ② 摘要本文已逐項講過的不重複（等待真人／沒人回／知識庫變動是摘要本文）
 * ③ 有自己 LINE 通知路徑的不重複（quotaRunningOut 有 80% 預警；
 *    handoffNotifyMissing 發生時摘要根本送不到任何人）
 * ④ 便宜的才進——純 Firestore 窄查詢、無外部呼叫。
 *    ~~renewalNotBound 是帳單探針，刻意捨去~~ → **2026-08-28 老闆拍板收進來**：
 *    它是唯一「付了錢的客戶會被靜默降級、唯一知道的方法是自己開後台」的黃級，
 *    而它的查詢本身就是一次純 Firestore 等值查詢，符合④的本意（當初捨去是因為
 *    它掛在 canSettings 探針組，不是因為它貴）。摘要端用 countRecentUnboundRenewals
 *    單獨查這一顆，不為它跑整組帳單探針。
 *
 * 順序＝重要度：摘要的「最重要」取第一個命中的。錢的事排最前。
 */
export const DIGEST_WARNING_ALERTS: readonly WorkspaceAlertId[] = [
  'renewalNotBound',
  'broadcastFailed',
  'knowledgeDetectStalled',
  'scriptUnreachable',
]

/**
 * active = 現在有這個問題；clear = 檢查過沒問題；
 * unknown = 這次查不到（查詢失敗或沒權限看），**不等於沒問題**，UI 要誠實講。
 */
export type WorkspaceAlertState = 'active' | 'clear' | 'unknown'

/**
 * 一顆異常涵蓋的「面向」（哪幾種設定出事）。
 *
 * 只有橫跨多個頁面的異常才需要：`brokenModuleButton` 一顆同時涵蓋圖文選單、機器人模組、
 * 客服腳本、活動——註冊表只能寫一個 `route`，所以在 2026-08-26 之前它一律指到圖文選單，
 * 壞在活動的人被帶去一個沒有問題的頁面。側欄狀態點更嚴重：**點會畫在錯的頁上，比沒有點更糟**。
 *
 * 有這個欄位之後，前端能把同一顆異常落到它真正涉及的每一頁。⛔ 值是路由對照表的鍵，
 * 不是給人看的文字（白話標籤在前端註冊表）。
 */
export type WorkspaceAlertScope = 'richmenu' | 'flow' | 'script' | 'campaign'

/**
 * 面向的白話名稱（**單一事實來源**）。
 *
 * 2026-08-27 code review 抓到：後端 detail 用「選單／模組／客服腳本／活動」、
 * 修復劇本用「圖文選單／機器人模組／客服流程／活動」——同一個 `sourceKind` 兩套詞，
 * 而且是在同一個畫面上下相鄰兩句話裡。統一取這一份（跟側欄與 ALERT_LABELS 同一套詞：
 * 側欄寫「機器人模組」「圖文選單」、ALERT_LABELS 寫「客服流程」）。
 * ⛔加第五種面向時只改這裡，不要在任何地方再寫第二份對照表。
 */
export const ALERT_SCOPE_LABELS: Record<WorkspaceAlertScope, string> = {
  richmenu: '圖文選單',
  flow: '機器人模組',
  script: '客服流程',
  campaign: '活動',
}

export interface WorkspaceAlertItem {
  id: WorkspaceAlertId
  state: WorkspaceAlertState
  /** 影響幾個（來源數 / 卡數 / 筆數）；沒有數量概念的異常不帶。 */
  count?: number
  /** 一句話補充，直接顯示給使用者看（例如失敗原因、最久等待時數）。 */
  detail?: string
  /** 這顆異常實際壞在哪幾種設定上（只有跨頁的異常會帶，見 WorkspaceAlertScope）。 */
  scopes?: WorkspaceAlertScope[]
}

export interface WorkspaceAlertsResponse {
  workspaceId: string
  items: WorkspaceAlertItem[]
  /** 這次檢查完成的時間（epoch ms），給前端顯示「幾分鐘前檢查」。 */
  checkedAt: number
}
