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
import { ALERT_LABELS, ALERT_SEVERITY, SYSTEM_OWNED_ALERTS } from '~~/shared/types/alerts'
import type { AlertSeverity, WorkspaceAlertId, WorkspaceAlertItem, WorkspaceAlertScope, WorkspaceAlertState, WorkspaceAlertsResponse } from '~~/shared/types/alerts'
import type { AlertFixOpId } from '~~/shared/types/alert-fix'
import type { AgentGuideId } from '~/utils/agent-guides'

// 嚴重度（ALERT_SEVERITY）與「這是系統這邊的狀況」（SYSTEM_OWNED_ALERTS）都定義在
// shared/types/alerts.ts——排程要決定哪些異常該主動推到商家的 LINE，用的必須是跟畫面
// 同一把尺。要用的地方直接從 shared 拿，⛔別在這裡再轉出去一份（會變成兩個 auto-import
// 同名來源，Nuxt 會挑一個、另一個靜靜被忽略）。

export interface AlertDefinition {
  id: WorkspaceAlertId
  icon: Component
  /** 白話文：不管它會怎樣（講後果，不是講原理） */
  impact: string
  /** 按鈕上的動作字樣 */
  cta: string
  /** 處理此項所需角色（對齊後端）：settings=admin、operate=agent 以上 */
  requires: 'settings' | 'operate'
  /** 去哪裡修 */
  route: (workspaceId: string) => string
  /**
   * 跨頁的異常：每個面向各自的落點（對應後端回的 `scopes`）。
   *
   * 有這個的異常，`route` 只是問不出面向時的退路。⛔別只留 `route`——側欄狀態點會照這裡
   * 把點畫到每一個真的壞掉的頁；只有一個 route 的話點會畫在錯的頁上，比沒有點更糟。
   */
  scopeRoutes?: Partial<Record<WorkspaceAlertScope, (workspaceId: string) => string>>
  /**
   * 頁內錨點（D-33 三輪，2026-08-27 老闆回饋）：**這一頁的哪個區塊能處理這件事**。
   *
   * 為什麼：提醒條的按鈕在本頁上按，原本等於原地重整。老闆講的優先序是對的——
   * 「頁面上有能解決它的區塊就帶人去那個區塊，沒有才用導航」。有掛錨點的異常，
   * 提醒條在本頁會把按鈕換成聚光燈（el-tour 高亮那個區塊＋講一句怎麼做），零重整。
   *
   * - `selector`：CSS 選擇器，通常是既有的 `data-tour` 錨。可用逗號列多個——
   *   跨頁異常（壞模組）在哪一頁就會亮哪一頁有的那個。
   * - `note`：聚光燈上那句「在這裡怎麼做」。講動作，不要重複 impact 的後果句。
   *
   * ⚠️2026-08-27 五輪拍板：提醒帶**不因頁面自己也有呈現而閉嘴**（四輪曾做過
   * presents 抑制，老闆否決：「進來之後就不知道問題在哪」）。頁內有重複呈現沒關係，
   * 提醒帶負責第一眼，「帶我看」聚光燈負責指到那個區塊。
   */
  anchor?: { selector: string, note: string }
  /** 有掛的話，卡片多一顆「用聊天帶我修」——對應的引導劇本（C-31 Phase 1，utils/agent-guides） */
  guideId?: AgentGuideId
  /**
   * 一鍵修（`D-34`，2026-08-27 拍板）：有掛的話，提醒帶與小幫手卡片多一顆「幫我修」——
   * 開確認 popup（AlertFixDialog）：後端 preview 講「會動哪幾筆」→ 人按確定 → 執行 →
   * refresh({force}) 重跑同一份訊號驗證。op 本體在 server/utils/alert-fix-ops.ts，
   * ⛔只掛「確定性動作、做錯可重來」的異常；錢／群發／憑證內容／刪除永遠不掛（紅線）。
   */
  fixOpId?: AlertFixOpId
}

export interface ResolvedAlert extends AlertDefinition {
  /** 一句話、零術語標題。來自 shared 的 ALERT_LABELS——與問助理工具同一份，不會漂移 */
  title: string
  /** 來自 shared 的 ALERT_SEVERITY（見檔頭）：畫面與推播用同一把尺 */
  severity: AlertSeverity
  /** 'system'＝系統這邊的狀況，使用者動不了手（來自 shared 的 SYSTEM_OWNED_ALERTS） */
  owner?: 'system'
  state: WorkspaceAlertState
  count?: number
  detail?: string
  /** 後端回的「壞在哪幾種設定上」（只有跨頁的異常會有） */
  scopes?: WorkspaceAlertScope[]
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
    impact: 'LINE 沒有把客人的訊息送進系統——機器人、AI、真人對話全都收不到，客人傳什麼都不會有回應。',
    cta: '去檢查 LINE 連接',
    requires: 'settings',
    // ?verify=webhook：進頁直接捲到「檢查連線」並實跑一次測試——
    // 使用者在卡片上已經按過一次「去檢查」，到頁面不該再自己找一遍要修什麼
    route: wid => `/admin/${wid}/settings/organization?verify=webhook`,
    anchor: { selector: '[data-tour="org-verify"]', note: '在這裡按「測試連線」重新檢查，照跳出來的狀態卡指示到 LINE 後台修正。' },
    guideId: 'line-webhook',
    // 一鍵只修得了「沒填網址」這種病因（LINE 有寫入 API）；Token 失效／開關沒開的病因
    // preview 會如實說修不了、指去劇本——同一顆按鈕，能不能修由後端當下判斷
    fixOpId: 'line-webhook-set-url',
  },
  {
    // 2026-08-08 老闆拍板升紅：實務上「不一致」＝填著已排定停用的舊網址，是顆定時炸彈——
    // 網址一停所有訊息無聲斷掉，等真的斷了才紅就是事後通知。與 lineWebhookBroken 仍分
    // 兩張卡，因為講的話不同：這張是「快斷了、趁現在改」，那張是「已經斷了」。
    id: 'lineWebhookUrlMismatch',
    icon: Link,
    impact: 'LINE 後台填的收訊網址不是這套系統的正式網址，多半是換網域前的舊網址。訊息目前可能還進得來，但那個網址一停用，所有客人訊息會無聲斷掉、不會有任何預警。趁還沒斷，把 LINE 後台換成正式網址。',
    cta: '去檢查 LINE 連接',
    requires: 'settings',
    route: wid => `/admin/${wid}/settings/organization?verify=webhook`,
    anchor: { selector: '[data-tour="org-verify"]', note: '在這裡按「測試連線」，狀態卡會列出 LINE 現在填的網址；把 LINE 後台換成本頁給的正式網址。' },
    guideId: 'line-webhook',
    fixOpId: 'line-webhook-set-url',
  },
  {
    // 紅：這是「看起來全綠、其實一則都收不到」的那種壞法，比明著壞掉更難自己發現。
    // 2026-08-19 老闆實測「亂打 Secret 卻綠燈」挖出來的——當時是同一個頻道被兩個
    // 工作區綁著，正確的鑰匙在另一邊，訊息整批被接走。
    id: 'lineChannelConflict',
    icon: Link,
    impact: '同一個 LINE 官方帳號同時接在兩個地方。客人傳的訊息只會進到其中一邊，另一邊一則都收不到——而且兩邊的檢查看起來都正常，不會有任何錯誤訊息。請決定這個官方帳號要留在哪一邊，另一邊把 LINE 連接清掉。',
    cta: '去檢查 LINE 連接',
    requires: 'settings',
    route: wid => `/admin/${wid}/settings/organization?verify=webhook`,
    anchor: { selector: '[data-tour="org-verify"]', note: '先決定這個官方帳號要留在哪一邊；要留這邊的話，把另一邊的 LINE 連接清掉，再回這裡按「測試連線」確認。' },
    // 修法本質＝做決定＋動憑證（紅線，動手留人）→ 對話式帶決策與指路（C-87）
    guideId: 'line-channel',
  },
  {
    // 紅（2026-08-21 老闆拍板做）：這是「客人已經在外面點連結、點下去什麼都沒有」，
    // 照 08-08 分級＝正在影響客人。⚠️條件式——沒開活動的帳號後端根本不會回這一項，
    // 所以它不會變成所有新帳號都掛著的紅點（LIFF 本身仍是加分項）。
    id: 'liffMissing',
    icon: Promotion,
    impact: '你有活動在跑，但還沒設定活動頁（LIFF）——客人在外面點活動連結會打不開，貼標與綁定都不會發生。設定只要一次，之後所有活動共用。',
    cta: '去設定活動頁',
    requires: 'settings',
    route: wid => `/admin/${wid}/settings/organization?focus=liff`,
    anchor: { selector: '[data-tour="org-liff"]', note: '在這裡把 LIFF ID 填進來就好；不知道去哪拿，按旁邊的「教我怎麼設」。' },
    guideId: 'liff-setup',
  },
  {
    // 與 webhook 那對同一套分級：到不了活動頁＝確定壞掉（紅）；下面那顆「網址不一致」
    // 是還到得了但會多繞（黃）。訊號來源＝LINE 公開轉址頁上登記的 Endpoint URL。
    id: 'liffEndpointBroken',
    icon: Promotion,
    impact: '這個 LIFF 在 LINE 登記的開啟網址不是活動頁——客人點活動連結會被帶去別的網站或看到錯誤頁，貼標與綁定完全不會發生。到 LINE Developers 把該 LIFF 的 Endpoint URL 換成設定頁的「活動 LIFF 頁」網址。',
    cta: '去檢查 LIFF 設定',
    requires: 'settings',
    // ?verify=liff：進頁直接捲到 LIFF 區塊並重新檢查一次（跳過快取）
    route: wid => `/admin/${wid}/settings/organization?verify=liff`,
    anchor: { selector: '[data-tour="org-liff"]', note: '這一區會列出 LINE 上的登記狀態；到 LINE Developers 把該 LIFF 的 Endpoint URL 換成本區給的「活動 LIFF 頁」網址，再按「重新檢查」。' },
    guideId: 'liff-endpoint',
  },
  {
    // 同 lineWebhookUrlMismatch，2026-08-08 拍板升紅：填著的是遲早停用的舊網址，
    // 而且現在就有感——客人登入活動頁會在兩個網址間繞，部分情況卡在載入中。
    id: 'liffEndpointUrlMismatch',
    icon: Promotion,
    impact: 'LINE 登記的活動頁網址不是這套系統的正式網址，多半是換網域前的舊網址。客人點活動連結登入時會在兩個網址之間繞，部分情況會卡在載入中；那個舊網址一停用，活動連結會整個打不開。把 LINE Developers 那邊換成設定頁的「活動 LIFF 頁」網址。',
    cta: '去檢查 LIFF 設定',
    requires: 'settings',
    route: wid => `/admin/${wid}/settings/organization?verify=liff`,
    anchor: { selector: '[data-tour="org-liff"]', note: '到 LINE Developers 把該 LIFF 的 Endpoint URL 換成本區給的「活動 LIFF 頁」網址，改完回來按「重新檢查」。' },
    guideId: 'liff-endpoint',
  },
  {
    id: 'anyTextBlocking',
    icon: ChatDotRound,
    impact: '有一條設定的觸發是「客人輸入任何內容」，會先接走所有訊息，客人問什麼都只會拿到那一套回應，AI 等於沒開。',
    cta: '去看這條設定',
    requires: 'operate',
    route: wid => `/admin/${wid}/ai-scripts`,
    anchor: { selector: '[data-tour="scr-list"]', note: '觸發方式寫「客人輸入任何內容」的那條就在這份清單裡，點開把觸發改成關鍵字或範例句。' },
    // 一鍵＝停用那條（可回復）；想保留內容改觸發的走頁面（popup 會講清楚兩條路）
    fixOpId: 'script-disable-anytext',
  },
  {
    id: 'llmError',
    icon: MagicStick,
    impact: '這些客人問了問題但 AI 當下答不出來，已轉給真人。這通常會自己恢復；若一整天都在發生，請聯絡我們處理。',
    cta: '看是哪些對話',
    requires: 'operate',
    // 帶 ?reason= 讓監控頁自動套用「AI 服務暫時失敗」篩選並捲到案例清單
    // （不帶的話落在頁頂、使用者得自己想起去下拉選原因）。
    // 一併帶 includeResolved:這個警示是看「近 24 小時發生過幾次」、不看有沒有被標處理,
    // 清單預設只顯示未處理 → 標過的那幾筆會讓人看到「N 次」卻是空清單。
    route: wid => `/admin/${wid}/ai-usage?reason=llm_error&includeResolved=1`,
    anchor: { selector: '[data-tour="usg-cases"]', note: '案例都列在這裡；用上面的「原因」下拉選「AI 服務暫時失敗」，就只看這批。' },
  },
  {
    // 措辭與知識庫頁「要處理的事」同一句話（見 ALERT_LABELS）:
    // 兩邊講的是同一件事,不該一邊「同步失敗」一邊「抓不到內容」
    id: 'knowledgeSyncFailed',
    icon: Reading,
    impact: '這些資料的內容沒有更新進 AI，客人問到相關問題會得到過時或空的答案。',
    cta: '去修這些資料',
    requires: 'operate',
    // ?health= 直接開對應的問題清單:使用者在這裡已經按過一次「去修」,
    // 到頁面後不該再自己找一遍同一件事
    route: wid => `/admin/${wid}/knowledge/sources?health=failedSources`,
    anchor: { selector: '[data-tour="kb-health"]', note: '「要處理的事」這一區就列著同步失敗的資料，照各筆的按鈕處理。' },
    guideId: 'knowledge-sync',
    fixOpId: 'knowledge-refetch-sources',
  },
  {
    // 措辭與知識庫頁體檢同一件事（stalledSources）:輪播/隨機區塊的首頁每輪抓到的內容都不同,
    // 系統分不出哪一版算數 → 官網真的改版也不會通知——畫面上還一切正常,最容易被忽略
    id: 'knowledgeDetectStalled',
    icon: Reading,
    impact: '這些網址每次抓到的內容都不一樣，系統已無法替你盯改版——官網改了也不會提醒。建議改用內容固定的頁面當資料來源。',
    cta: '去看這些網址',
    requires: 'operate',
    route: wid => `/admin/${wid}/knowledge/sources?health=stalledSources`,
    anchor: { selector: '[data-tour="kb-health"]', note: '「要處理的事」這一區列著這些網址，建議換成內容固定的頁面當來源。' },
  },
  {
    id: 'knowledgeIndexFailed',
    icon: Reading,
    impact: '這些知識存進去了但 AI 讀不到，等於白建——客人問到就會答不出來。',
    cta: '去看這些知識',
    requires: 'operate',
    route: wid => `/admin/${wid}/knowledge/sources?health=failedChunks`,
    anchor: { selector: '[data-tour="kb-health"]', note: '「要處理的事」這一區列著 AI 讀不到的知識，照各筆的按鈕處理。' },
    fixOpId: 'knowledge-retry-index',
  },
  {
    // critical 不是「有人回報」而已：同事看到 AI 用這條答錯客人、而它還沒被改過，
    // 代表它現在仍然在用同樣的內容回答下一位客人（紅＝正在影響客人）。
    id: 'knowledgeWrongAnswers',
    icon: Reading,
    impact: '同事在對話上看到 AI 用這些內容答錯客人，而它們到現在都還沒被修改過——同樣的問題會繼續答錯。',
    cta: '去修這些知識',
    requires: 'operate',
    route: wid => `/admin/${wid}/knowledge/sources?health=wrongAnswerChunks`,
    anchor: { selector: '[data-tour="kb-health"]', note: '「要處理的事」這一區列著被標答錯、又還沒改過的知識，點進去修內容。' },
  },
  {
    id: 'quotaExceeded',
    icon: Odometer,
    impact: 'AI 已經停止回覆，現在客人的訊息會直接轉給真人處理。',
    cta: '去升級方案',
    requires: 'settings',
    route: wid => `/admin/${wid}/settings/billing`,
  },
  {
    // 提前量：quotaExceeded 亮的時候 AI 已經停了。這顆在停之前就講
    id: 'quotaRunningOut',
    icon: Odometer,
    impact: '用完之後 AI 會停止回覆，客人的訊息只能等真人接手。趁還沒停先升級方案，就不會中斷。',
    cta: '去看用量與方案',
    requires: 'settings',
    route: wid => `/admin/${wid}/settings/billing`,
  },
  {
    id: 'paymentPastDue',
    icon: CreditCard,
    impact: '服務目前照常，但一直扣不到款會被降回免費方案、AI 停止回覆。請更新付款方式，或改用手動付款。',
    cta: '去處理付款',
    requires: 'settings',
    route: wid => `/admin/${wid}/settings/billing`,
  },
  {
    id: 'handoffNotifyMissing',
    icon: Bell,
    // 這份名單擋的不只轉真人:每日摘要、額度、嚴重異常的 LINE 通知全部靠它(D-36③)
    impact: '客人轉真人、每日摘要、額度與異常警報的 LINE 通知都要靠這份名單——現在沒有任何人會收到通知，客人可能等很久都沒人接手。',
    cta: '去設定通知對象',
    requires: 'settings',
    route: wid => `/admin/${wid}/ai-settings`,
    anchor: { selector: '[data-tour="ais-handoff"]', note: '在這一區把「通知對象」加上至少一位，AI 轉真人時才有人會收到通知。' },
    guideId: 'handoff-notify',
  },
  {
    // 紅點：客人按下去真的什麼都收不到，屬於「正在影響客人」
    id: 'brokenModuleButton',
    icon: Pointer,
    impact: '選單、圖卡、關鍵字回覆或活動指向已刪除／已停用的模組。客人觸發時收不到任何訊息，也不會看到錯誤提示。',
    cta: '去檢查設定',
    requires: 'settings',
    // 退路：問不出面向時（舊版後端沒回 scopes）沿用原本的落點
    route: wid => `/admin/${wid}/richmenu`,
    // 2026-08-26：這顆一顆管四種設定，以前一律指到圖文選單——壞在活動的人被帶去
    // 一個沒有問題的頁面找半天。後端已經知道壞在哪（`scopes`），這裡照它分流。
    scopeRoutes: {
      richmenu: wid => `/admin/${wid}/richmenu`,
      flow: wid => `/admin/${wid}/flow`,
      script: wid => `/admin/${wid}/ai-scripts`,
      campaign: wid => `/admin/${wid}/campaigns`,
    },
    // 逗號選擇器：這顆會落在四頁，querySelector 會亮「這一頁有的那個」清單
    anchor: { selector: '[data-tour="rm-list"], [data-tour="flow-list"], [data-tour="scr-list"], [data-tour="cmp-list"]', note: '壞掉的設定就在這份清單裡——照上面提到的名稱點開，就會看到哪裡壞、該改成什麼。' },
    // 修法要人做選擇（停用的重新啟用？刪掉的改指到哪？）→ 對話式收決定後代改（C-87）；
    // ⛔圖文選單類代改不了（按鈕資料發佈時燒進 LINE），劇本會如實引導去重新發佈
    guideId: 'broken-module',
  },
  {
    // 紅點：客人已經走進這條流程了，卡在同一題被無限重問——正在影響客人。
    // （2026-08-08 的真實災情：問訂單編號沒給「我沒有訂單編號」的退路，沒編號的客人出不去，
    //   後台完全看不出來，只有自己去測才會發現。）
    id: 'scriptDeadEnd',
    icon: Guide,
    impact: '這條流程中間有一題問的是客人可能根本沒有的資料（訂單編號、序號…），又沒有給「我沒有」的退路。答不出來的客人會被一直重問同一題，走不到後面任何一步。到腳本編輯器幫那一題加一顆跳過按鈕。',
    cta: '去修這條流程',
    requires: 'operate',
    route: wid => `/admin/${wid}/ai-scripts`,
    anchor: { selector: '[data-tour="scr-list"]', note: '點開那條流程，上方的紅色狀態列會直接指出是哪一題、旁邊就有補退路的按鈕。' },
    // 一鍵＝補「我沒有這項資料」跳過出口（與 AI 生成端同一套確定性補法）；
    // 按鈕字樣客人看得到，popup 會原文展示、人看過才執行（08-27 拍板的守門方式）
    fixOpId: 'script-add-skip-exit',
  },
  {
    // 黃燈不是紅點：客人還是有 AI 或別的設定接住，壞的是「你設的流程沒生效」——
    // 沒有人正在被卡住，但你以為在跑的東西其實一次都沒跑過。
    id: 'scriptUnreachable',
    icon: Guide,
    impact: '這條流程啟用著，但客人講什麼都輪不到它——觸發詞沒填，或是會先被自動回覆規則、敏感情境轉真人、另一條觸發詞更寬的流程接走。換一組更明確的觸發詞，或調整擋在前面的那個設定。',
    cta: '去看這條流程',
    requires: 'operate',
    route: wid => `/admin/${wid}/ai-scripts`,
    anchor: { selector: '[data-tour="scr-list"]', note: '點開那條流程，上方的黃色狀態列會講它為什麼輪不到、該調哪個設定。' },
  },
  {
    id: 'firstReplyBacklog',
    icon: ChatDotRound,
    impact: '這些對話到現在還沒有任何人回覆過。AI 草稿模式下尤其要看：AI 只擬好草稿等人送出，沒人處理＝客人一直收不到回覆。',
    cta: '去看未回覆的對話',
    requires: 'operate',
    // 與側欄「未首接」同一份佇列口徑，直接落在該分頁
    route: wid => `/admin/${wid}/conversations?tab=open`,
    anchor: { selector: '[data-tour="conv-tabs"]', note: '按「待處理」分頁，就只會看到還沒有人回過的客人，點進去回覆。' },
  },
  {
    id: 'humanBacklog',
    icon: Service,
    impact: '等待中的對話 AI 不會插手。處理完記得按「交回機器人」或「結束對話」，否則 AI 會一直被暫停（久到沒動靜的才會由系統自動收尾）。',
    cta: '去看對話',
    requires: 'operate',
    // 直接落在「待真人」分頁——不帶 tab 會落在「全部」,等真人的對話要自己再切一次
    route: wid => `/admin/${wid}/conversations?tab=pending_human`,
    anchor: { selector: '[data-tour="conv-tabs"]', note: '「待真人」是在等的客人、「真人處理」是接了還沒收尾的——處理完按「交回機器人」或「結束對話」。' },
  },
  {
    // 與 knowledgeIndexFailed（明確失敗）不同：這批是「一直沒學完」——重試放生或排程沒跑
    id: 'knowledgeIndexStuck',
    icon: Reading,
    impact: '這些知識卡等了超過一小時還沒學完，AI 目前讀不到它們——客人問到相關問題會答不出來。若一直卡著，請聯絡我們。',
    cta: '去看這些知識',
    requires: 'operate',
    route: wid => `/admin/${wid}/knowledge/sources`,
    // 雖在 SYSTEM_OWNED（卡住的根因在系統端），但「再排一次學習」是安全冪等的自救動作
    // ——有 fixOpId 時 UI 不再講「不用你操作」（那句話在有按鈕可按之後就不是真的了）
    fixOpId: 'knowledge-retry-index-stuck',
  },
  {
    id: 'knowledgeOutdated',
    icon: Refresh,
    impact: '原始網頁或試算表被改過，但 AI 還在用舊版本回答。',
    cta: '去重新同步',
    requires: 'operate',
    route: wid => `/admin/${wid}/knowledge/sources`,
    anchor: { selector: '[data-tour="kb-health"]', note: '「要處理的事」的「前往比對」會逐份對照新舊內容。' },
  },
  {
    // 不用「蓋章 / system_notice」這種內部說法:客服看到的後果是「假的待處理」
    id: 'claimPushUnmarked',
    icon: Service,
    impact: '客人已經收到活動推播，但系統沒記下「已回應」，這些對話會出現在待處理清單上，其實不用處理。清單暫時會偏多，客人沒有受影響。',
    cta: '去看待處理清單',
    requires: 'operate',
    route: wid => `/admin/${wid}/conversations?tab=open`,
  },
  {
    id: 'renewalNotBound',
    icon: CreditCard,
    impact: '這期的錢付成功了，但自動扣款的卡片沒有綁定成功——下期不會自動扣款，方案會被降回免費、AI 停止回覆。請重新設定付款方式，或聯絡我們處理。',
    cta: '去處理付款方式',
    requires: 'settings',
    route: wid => `/admin/${wid}/settings/billing`,
  },
  {
    id: 'invoiceFailed',
    icon: Tickets,
    // 對客戶的口徑是「開立中」不是「失敗」（2026-08-16 拍板）：系統每日自動補開、客戶無事可做,
    // 驚動他只會製造「系統壞了」的觀感。⛔真實狀態不動——超管金流總覽有紅色「發票未開成」計數。
    impact: '款項已收到，電子發票正由系統自動開立，完成後會顯示在付款紀錄並寄送通知。若需要我們處理（例如統編設定），會主動聯繫你。',
    cta: '去看付款紀錄',
    requires: 'settings',
    route: wid => `/admin/${wid}/settings/billing`,
  },
  {
    id: 'broadcastFailed',
    icon: Promotion,
    impact: '這批推播發送失敗，名單上的客人沒有收到訊息。進去看失敗原因，處理後可以重新發送。',
    cta: '去看推播',
    requires: 'operate',
    route: wid => `/admin/${wid}/broadcasts`,
    anchor: { selector: '[data-tour="bc-list"]', note: '失敗的那批就在這份清單（看狀態章），點開看失敗原因，可以「重設為草稿再發一次」。' },
    // 一鍵＝重設回草稿（走既有 retry 端點，刻意不代發——發送留人＝群發紅線的正確形狀）
    fixOpId: 'broadcast-reset-failed',
  },
  {
    id: 'broadcastOverdue',
    icon: AlarmClock,
    impact: '排定的發送時間已經過了，推播卻還沒送出去——排程可能卡住了。若一直沒動，請聯絡我們。',
    cta: '去看排程',
    requires: 'operate',
    route: wid => `/admin/${wid}/broadcasts`,
    anchor: { selector: '[data-tour="bc-list"]', note: '逾時的排程就在這份清單裡，點開看它排定的時間；一直沒動請聯絡我們。' },
  },
  {
    // 系統端問題：使用者修不了，但影響要現形（轉真人提醒、自動回收都靠它）
    id: 'maintenanceStalled',
    icon: Tools,
    impact: '背景的自動維護（轉真人提醒、逾時自動交回、資料更新偵測）已停擺超過一小時。這是系統端的問題，通常不用你操作；若持續一整天，請聯絡我們。',
    cta: '去看連接狀態',
    requires: 'settings',

    route: wid => `/admin/${wid}/settings/organization`,
  },
  {
    /**
     * 系統端問題（C-68 的治本）：AI 讀對話的背景掃描一直失敗。
     * 之前這種死法完全沒有現形機制——開關開著、畫面什麼都不說，兩天後才被發現。
     */
    id: 'scannerStalled',
    icon: Tools,
    impact: 'AI 讀對話的背景掃描（貼標建議、發現新標籤）連續失敗中，所以不會有新的標籤建議出現。這是系統端的問題，不用你操作，請聯絡我們處理。',
    cta: '去看標籤',
    requires: 'operate',
    route: wid => `/admin/${wid}/tags`,
  },
  {
    /**
     * 「可以更好」：AI 從對話裡發現「你還沒有這顆標籤」的主題（D-30②）。
     * 沒有這條的話建議只躺在標籤頁——而沒有人會沒事去開標籤頁。
     */
    id: 'tagDiscoverySuggestions',
    icon: Opportunity,
    impact: 'AI 讀最近的對話，發現有些主題很多客人在聊、但你還沒有對應的標籤。判斷條件我都擬好了，你按「建立」才會新增，而且會順手把聊過的那批客人標起來。',
    cta: '去看建議',
    requires: 'operate',
    route: wid => `/admin/${wid}/tags`,
  },
  {
    // 「可以更好」：沒有東西壞掉。建議收件匣的草稿是 AI 學習迴圈撿回來的知識缺口
    id: 'knowledgeSuggestions',
    icon: Opportunity,
    impact: '這些是客人問過、但 AI 沒答好的主題。草稿我都擬好了，採用之後 AI 下次就答得出來。',
    cta: '去看建議',
    requires: 'operate',
    route: wid => `/admin/${wid}/knowledge/sources`,
  },
]


/**
 * 這顆異常實際要落在哪幾頁：跨頁的照後端回的 `scopes` 展開，其餘就是它自己的 `route`。
 * 問不出面向（舊後端、或 scopes 是空的）一律退回 `route`——寧可指到一個能修的頁，
 * 也不要因為問不出來就不指。
 */
function alertRoutes(def: AlertDefinition, scopes: WorkspaceAlertScope[] | undefined, wid: string): string[] {
  const map = def.scopeRoutes
  if (map && scopes?.length) {
    const hits = scopes.map(s => map[s]).filter(Boolean).map(fn => fn!(wid))
    if (hits.length)
      return [...new Set(hits)]
  }
  return [def.route(wid)]
}

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

  /**
   * 進行中的那一次查詢也要放進**共用狀態**。
   *
   * ⛔ 用函式內的 `let` 等於每個呼叫端各自一份閂：這支 composable 同一個畫面上就有兩個
   * 呼叫端一起掛上（頁頂提醒條 `AdminPageAlertStrip`、右下角小幫手 `TutorialAgent`），
   * 兩邊在同一個 tick 發車、互相看不到對方正在查 → 每次開頁把全站最慢的那支彙總查詢
   * 打兩遍（2026-08-27 正式站實測：17 個工作區頁面裡有 15 頁都是兩次，而它正是 11 個
   * 頁面「最後才回來」的那一支）。
   * 下面的 `checkedAt` 節流攔不住這種情形——同時發車時第一支還沒回來，沒有東西可比。
   * 寫法與 `useWorkspace` 的 `workspace:loadInFlight` 一致。
   */
  const inflight = useState<Promise<void> | null>('workspace-alerts-inflight', () => null)
  /**
   * 飛行中那一支是**誰的**。共用一支 promise 之前一定要先比帳號：
   * 這支查詢正式站要 1.3～4.1 秒，使用者在這段時間內切帳號是真的會發生的順序，
   * 拿 A 家的查詢回答 B 家＝B 家永遠沒被查、而且 A 家的異常會寫進 B 家畫面
   * （`reset()` 自己的註解就說了：這比暫時沒有資料嚴重得多）。
   */
  const inflightFor = useState('workspace-alerts-inflight-for', () => '')
  /** 第幾號查詢：收尾時用來確認「我還是最新那一支嗎」（⛔別拿 promise 自己比，會踩 TDZ） */
  const inflightTicket = useState('workspace-alerts-inflight-ticket', () => 0)

  async function refresh(options: { force?: boolean } = {}): Promise<void> {
    const wid = workspaceId.value
    if (!wid)
      return
    loadSnoozes(wid)
    tick.value = Date.now()
    // 只有「同一個帳號」的查詢能共用飛行中的那一支
    if (inflight.value && inflightFor.value === wid)
      return inflight.value
    // 節流：非強制刷新且剛查過就跳過（面板開開關關不該重打）
    if (!options.force && checkedAt.value && Date.now() - checkedAt.value < REFRESH_TTL_MS)
      return

    loading.value = true
    inflightFor.value = wid
    const ticket = ++inflightTicket.value
    const task = (async () => {
      try {
        const token = await getBearer()
        const data = await $fetch<WorkspaceAlertsResponse>('/api/admin/alerts', {
          // force 也要傳到後端：前端節流只是「不要重打」，後端還有一層外部查詢快取
          // （LINE webhook 那顆存五分鐘）。使用者剛改完設定回來確認時，只擋前端沒用，
          // 後端會回修好之前那份答案，變成一直說「還沒好」
          query: { workspaceId: wid, ...(options.force ? { force: '1' } : {}) },
          headers: { Authorization: `Bearer ${token}` },
        })
        // ⛔ 落地前再比一次帳號：回應在路上時使用者可能已經切走了，
        //    而後端**有**回它是誰的（`data.workspaceId`），不比就是把 A 家的異常寫到 B 家。
        //    比目前的 workspaceId 而不是比 wid：要擋的是「現在畫面是誰的」。
        if ((data.workspaceId || wid) !== workspaceId.value)
          return
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
        // 只有自己還是「最新那一支」才收尾：切帳號後新的那支已經接手，舊的落地不能把它清掉
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
   * 清掉現有結果。換工作區時一定要呼叫：把 A 帳號的「扣款失敗」留在 B 帳號畫面上，
   * 比暫時沒有資料嚴重得多。
   */
  function reset() {
    alertMap.value = {}
    loaded.value = false
    checkedAt.value = 0
    lastRefreshFailed.value = false
    snoozedMap.value = {} // 換工作區後由下一次 refresh 重新載入該工作區的靜音
    // ⛔ 上一家還在飛的那支要放掉：不放的話「換帳號 → reset → 立刻 refresh」會被它擋住
    //    （共用 promise 的代價），新帳號等於從來沒被查過。
    //    ++ticket 讓舊的那支落地時自己認出已被接手，不會回頭清掉新的旗標。
    //    ⛔ 只放掉**別家的**：同一家已經在飛的那支要留著讓後面的 refresh 共用，
    //    否則切帳號時會送出兩支一模一樣的查詢（同 useSetupStatus 的註解）。
    if (inflightFor.value !== workspaceId.value) {
      inflight.value = null
      inflightFor.value = ''
      inflightTicket.value++
      loading.value = false // 被放掉的那支不會再回來收轉圈（ticket 已經對不上）
    }
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
    if (ALERT_SEVERITY[id] !== 'warning')
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
        const scopes = item?.scopes
        // 標題來自 shared 的 ALERT_LABELS：面板與問助理工具講同一句話
        return {
          ...a,
          title: ALERT_LABELS[a.id],
          severity: ALERT_SEVERITY[a.id],
          owner: SYSTEM_OWNED_ALERTS.has(a.id) ? 'system' as const : undefined,
          state: item?.state ?? 'unknown',
          count: item?.count,
          detail: item?.detail,
          scopes,
          // 跨頁異常：卡片上那顆按鈕改帶去真的壞掉的那一頁（多個面向就帶去第一個，
          // 側欄的點會把其餘的面向也標出來）
          route: (wid: string) => alertRoutes(a, scopes, wid)[0] ?? a.route(wid),
        }
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

  /**
   * 側欄狀態點（2026-08-26 `D-33` P0-1）：路徑 → 這一頁現在有什麼事。
   *
   * 為什麼：異常本來只在右下角小幫手講，使用者要「想到去點它」才看得到——17 個側欄入口
   * 全是一樣的灰字，哪一頁出事完全看不出來。這裡不打任何新查詢，只是把同一份 `activeAlerts`
   * 換一個位置畫出來。
   *
   * ⛔ 三條鐵律（改這裡之前先讀）：
   * 1. **吃 `activeAlerts`，不要自己另外過濾一輪**——它已經處理掉沒權限、查不到（unknown）、
   *    被靜音、以及建議類（老闆 08-26 拍板：建議不上側欄，常年都有的東西掛上去會變裝飾）。
   * 2. **鍵是「去掉查詢字串」的路徑**：異常的 route 帶著 `?verify=`、`?health=`、`?tab=`
   *    這些深連結，側欄項的 `to` 不帶——不剝掉就永遠對不上。
   * 3. **紅蓋過琥珀**：同一頁兩種都有時畫紅色，句子照嚴重度排。
   */
  const navAlerts = computed<Record<string, { severity: AlertSeverity, titles: string[] }>>(() => {
    const wid = workspaceId.value
    if (!wid)
      return {}
    const out: Record<string, { severity: AlertSeverity, titles: string[] }> = {}
    for (const a of activeAlerts.value) {
      for (const full of alertRoutes(a, a.scopes, wid)) {
        const path = full.split('?')[0]!
        const cur = out[path]
        if (!cur)
          out[path] = { severity: a.severity, titles: [a.title] }
        else {
          cur.titles.push(a.title)
          if (a.severity === 'critical')
            cur.severity = 'critical'
        }
      }
    }
    return out
  })

  /**
   * 「這一頁現在有的事」（D-33 二輪，2026-08-27 老闆回饋）：給頁面級提醒條用。
   *
   * 側欄的點只回答「去哪一頁」，人到了頁面沒有東西接手講「有什麼事、下一步按哪裡」——
   * 這支跟 `navAlerts` 用**同一個展開**（alertRoutes），保證「點亮在哪頁、那頁就列得出同一批事」。
   * 回傳的 `to` 是完整深連結（含 `?tab=`／`?health=`／`?verify=`），按鈕就是下一步。
   */
  function alertsForPath(path: string): { alert: ResolvedAlert, to: string }[] {
    const wid = workspaceId.value
    if (!wid)
      return []
    const out: { alert: ResolvedAlert, to: string }[] = []
    for (const a of activeAlerts.value) {
      for (const to of alertRoutes(a, a.scopes, wid)) {
        if (to.split('?')[0] === path) {
          out.push({ alert: a, to })
          break // 同一顆異常在同一頁只列一次
        }
      }
    }
    return out // activeAlerts 已經紅在前，這裡不用再排
  }

  /** 這次查不到狀態的項目（要現形，不能偷偷當成沒事） */
  const unknownAlerts = computed(() =>
    loaded.value ? visibleAlerts.value.filter(a => a.state === 'unknown') : [],
  )

  /**
   * 這一輪真的問出答案的項數（2026-08-21 老闆拍板做，原 `D-8`①）。
   *
   * 用途：「目前沒有發現異常」後面要講「這次檢查了 N 項」。沒有這個數字的話，
   * 那句話跟「我根本沒檢查」在畫面上長得一模一樣——使用者無從分辨系統是真的看過，
   * 還是在對他敷衍。
   *
   * ⛔ 只數 active／clear，**不含 unknown**：查不到的那幾項另外列（checkGapLines），
   *    算進來就變成「檢查了 12 項」其實只查到 9 項——那正是這個數字要防的事。
   */
  const checkedCount = computed(() =>
    loaded.value ? visibleAlerts.value.filter(a => a.state !== 'unknown').length : 0,
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
    navAlerts,
    alertsForPath,
    checkedCount,
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
