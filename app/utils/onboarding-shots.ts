/**
 * 開通引導／修復劇本用的示意圖：路徑單一來源。
 *
 * 圖檔放 `public/onboarding/`（拍攝清單、鏡位與更新規則見那個資料夾的 README.md）。
 *
 * ⚠️ **圖還沒放進去也能出貨**：卡片會先在背景載一次，載不起來就只顯示文字（不破圖）。
 * 所以劇本可以先把圖接上，截圖補進資料夾的那天就自動出現，不用再改程式。
 *
 * ⚠️ 檔名固定不帶日期——帶日期的話補新圖等於改程式，就失去上面那個好處。
 * 「這批圖什麼時候拍的、LINE 後台改版了沒」記在 README。
 *
 * ⚠️ **動畫上的號碼跟文案裡的①②③是同一套**（2026-09-02）：動畫是循環播放的，
 * 中途接上的人只能靠號碼知道自己看到的是第幾步。**改文案的步驟順序（或加減一步）
 * 就要一起改 `scripts/make-onboarding-shots.py` 重跑**，否則畫面上的③會指到別的動作，
 * 而且沒有任何測試會紅——只有使用者會發現。
 */
export const ONBOARDING_SHOTS = {
  /** LINE Developers 帳號清單（靜態，修復劇本用）：認卡片下方「Messaging API」小字 */
  consoleChannel: '/onboarding/line-console-channel.png',
  /** 循環動畫：登入頁 → 帳號清單整頁（含麵包屑定位）→ 聚焦「Messaging API」小字（教學用）。
   *  ⚠️ 登入頁那一格是 2026-09-07 老闆要求補的，**刻意零標註**——08-19「登入頁不配圖」的
   *  真正理由是圈哪顆按鈕都會誤導用其他方式登入的人；放進來當定位、不圈任何一顆，兩個拍板都守住 */
  consoleChannelAnim: '/onboarding/line-console-channel.webp',
  /** 循環動畫：①切到 Messaging API 分頁 → 捲到最底 → ②按 Issue 發一組 → ③按複製圖示。
   *  ⚠️②③是 2026-09-06 用**還沒發過 token** 的帳號重拍的——舊圖那顆按鈕寫「Reissue」，
   *  而第一次來的人看到的是「Issue」；③則是按完之後才會出現的複製圖示（舊圖那一列是空的） */
  getTokenAnim: '/onboarding/line-console-get-token.webp',
  /** Messaging API 分頁最下方：發第一把鑰匙（Issue / Reissue） */
  issueToken: '/onboarding/line-console-issue-token.png',
  /** 官方帳號後台的帳號一覽：「你已經有 LINE 官方帳號了嗎？」那一題的配圖。
   *  ⛔ 來源圖裡三列都是真實客戶的帳號名稱與頭像，產線有糊掉——換圖時要重新對座標 */
  oamAccountList: '/onboarding/oam-account-list.png',
  /** 官方帳號後台：設定 → Messaging API 按啟用（靜態，只圈那顆按鈕）。
   *  ⚠️ 教學用下面的動畫版——**按下去還要連過三個彈窗**，只給一張「按這裡」的圖等於教一半 */
  oamEnableMessagingApi: '/onboarding/oam-enable-messaging-api.png',
  /**
   * 循環動畫：啟用 Messaging API 全程——①按「啟用Messaging API」→ ②建立服務提供者（填店名）
   * → ③隱私權兩欄可不填、按確定 → ④最後確認按確定。
   *
   * 為什麼要動畫：文案原本只有「按啟用」四個字，實際上按下去要**連過三關**，
   * 第三關還跳一句「一旦與提供者連動即無法變更或解除」——沒被預告的人會停在那裡不敢按。
   * ⛔ 停在④，**不演完成畫面**：演到「已經好了」會讓人以為不用按那顆確定（同 webhook 動畫踩過的坑）。
   */
  oamEnableAnim: '/onboarding/oam-enable-messaging-api.webp',
  /** 循環動畫：①切 Basic settings 分頁 → 捲下來 → ②找到 Channel secret（緊裁列圖缺定位已退場）。
   *  ⚠️②的來源 2026-09-06 換成**那一列有值**的截圖（值已模糊）：舊圖整列空白，
   *  新手會以為自己那邊沒資料 */
  channelSecretAnim: '/onboarding/line-console-channel-secret.webp',
  /** Messaging API 分頁：Webhook URL 欄位＋Use webhook 開關（靜態①②，修復劇本用） */
  webhookUrl: '/onboarding/line-console-webhook-url.png',
  /** 認錯卡對照：左邊綠框＝Messaging API 那張（要點的），右邊紅框打叉＝LINE Login 那張。
   *  ⛔ 綠紅不是唯一差別（色盲看不出來），錯的那張有一個大叉，那才是訊號 */
  whichCard: '/onboarding/line-console-which-card.png',
  /** 認錯卡對照【LIFF 版】：綠框＝LINE Login 那張（LIFF 要點的），紅框打叉＝Messaging API。
   *  ⛔ 跟 whichCard **正好相反**，別互相代用——拿鑰匙教人別點 LINE Login，設 LIFF 教人
   *  就是要點它；同一張圖講不了兩件相反的事（`D-17` 抓到的「兩份教學互打」） */
  whichCardLiff: '/onboarding/line-console-which-card-liff.png',
  /** 只圈 Use webhook 開關（上面留網址那列當定位）：接線教學的第三步用，別跟上面那張混。
   *  ⚠️2026-09-06 換來源：舊圖上那個開關**已經是綠的**，而這一步要教的正是「把它打開」 */
  useWebhook: '/onboarding/line-console-use-webhook.png',
  /** 循環動畫：貼 Webhook 網址——①選對卡（同名雙卡）→ ②切分頁 → ③按 Edit → ④貼上按 Update。
   *  ⛔停在④：開 Use webhook 是教學的**下一步**，演進來的話人會提前做完。
   *  ⚠️2026-09-06 才真的修好：09-02 那次只挪了聚光位置、**底圖狀態沒換**，所以④畫面上
   *  網址早就存好、只有 Verify／Edit 兩顆鈕（沒有 Update）、而且開關已經是綠的。
   *  現在③是「Webhook URL 全空、只有一顆 Edit」、④是「輸入格＋網址＋Update」，都是真實狀態 */
  webhookAnim: '/onboarding/line-console-webhook.webp',
  /**
   * ⛔ **按錯 Issue** 的確認框：同一個後台有**兩顆都叫 Issue**——Messaging API 分頁最底那顆
   * 發 Access Token（按了沒事，就是重發一把）；Basic settings 裡 Channel secret 旁邊那顆
   * **重發 Channel Secret**，按下去已經接好的線當場斷、畫面上看不出異常、一小時內換不回來。
   * 拿第二組連線資訊那一步配這張：「看到這個框就是按錯了，按 Cancel」。
   * （2026-09-06 老闆補拍截圖時自己按錯才發現，教學原本一個字都沒提）
   */
  secretIssueWarning: '/onboarding/line-console-secret-issue-warning.png',
  /**
   * 官方帳號後台「設定 → Messaging API」那一頁：**Channel secret 就列在上面**，旁邊一顆複製鈕。
   *
   * ⛔ 第二組連線資訊改從這裡拿（2026-09-06 老闆實測兩邊同步）：LINE Developers 的同名雙卡是
   * 全流程**唯一「照著做也會錯」**的地方——挑錯那張，它的 Basic settings 也有一個 Channel secret，
   * 貼進來系統照收，然後客人每句話都被當成假冒的丟掉、畫面上一切正常。
   * 這一頁**沒有卡片可以挑**，錯誤機會直接消失。
   * ⚠️ 兩顆「複製」上下相鄰（Channel ID 一顆、secret 一顆），所以圖上框的是**整列**不是按鈕。
   *
   * ⛔ **一定要是帶路動畫，不可以退回緊裁的一列**（2026-09-06 老闆一看第一版就說「根本不知道
   * 在哪裡」）：第一次來的人不知道那一列在頁面的什麼地方。這條 README 早就寫著——
   * 靜態緊裁圖只用在「已經知道位置、回去再看一眼」的修復情境。
   * ①右上「設定」→ ②左欄「Messaging API」→ ③Channel secret 那一列按複製。
   */
  oamChannelSecretAnim: '/onboarding/oam-channel-secret.webp',
  /** 循環動畫：貼 Webhook 網址**全程**——①右上「設定」→ ②左欄「Messaging API」→ ③貼進「Webhook網址」→ ④按「儲存」。
   *  取代 LINE Developers 的 Edit／Update；⚠️貼上與存檔分兩格，因為「貼了沒按儲存」是接不通第一名。
   *  ⚠️ 2026-09-07 老闆拍板**恢復①②導航**：上一步跟這一步中間**離開過**（回 MiniMe 貼 secret、
   *  複製網址），回來的人可能已經不在那一頁——重新帶路是接住迷路的人，不是重複。
   *  判準＝「中間有沒有離開」：回應設定那支（緊接在後、沒離開）維持不含「點設定」 */
  oamWebhookUrlAnim: '/onboarding/oam-webhook-url.webp',
  /**
   * 循環動畫【**開通流程用**】：①左欄「回應設定」→ ②把 Webhook 打開 → ③選「手動聊天」。
   *
   * ⛔ **這一支刻意不含「點右上角設定」**（2026-09-06 老闆抓到重複）：走到這一步的人，
   * 前兩步（拿 Channel secret、貼網址）已經在「設定」裡面待過了，再叫他點一次
   * 是叫他去他已經站著的地方。
   * ⚠️ 用在**冷啟動**的地方要改用下面那支 `oamAutoReplyAnim`（多一格「點右上角設定」）。
   */
  oamResponseSettingsAnim: '/onboarding/oam-response-settings.webp',
  /**
   * 循環動畫【**冷啟動用**】：①右上「設定」→ ②側欄「回應設定」→ ③把 Webhook 打開 → ④選「手動聊天」。
   *
   * ⚠️ `field-help.ts` 的「教我怎麼關」用這一支：那裡的人是從**我們自己的設定頁**點進來的，
   * 沒進過 OA 後台，而我們給的連結**落在「主頁」不是設定頁**、左邊那排選單還沒展開——
   * 對他來說「先點右上角設定」是必要的第一步，不能省。
   */
  oamAutoReplyAnim: '/onboarding/oam-auto-reply.webp',
  /** 循環動畫：建活動頁 LIFF（LINE Login 那張卡 → LIFF 分頁 → Add → 貼 Endpoint）。⚠️截圖尚缺，補進 src 後產 */
  liffSetupAnim: '/onboarding/line-console-liff-setup.webp',

  // ── Google 試算表：把 FAQ 範本變成「改了自動更新」的資料來源（`C-106`，2026-09-03）──
  // 這四張取代了我憑記憶畫的示意圖（那張畫錯四處）。**站外畫面才配圖**，站內一律聚光燈導覽。
  /** `/copy` 的「複製文件」頁：圈唯一那顆「建立副本」 */
  gsheetCopy: '/onboarding/gsheet-copy.png',
  /** 範本副本長什麼樣（欄位名＋三列示範）。⛔這張刻意不打標註也不聚光：整張都是要讀的內容 */
  gsheetTemplate: '/onboarding/gsheet-template.png',
  /**
   * 共用流程三條**緊裁窄條**，一條一個動作：①貼帳號 ②權限改「檢視者」 ③按「傳送」。
   *
   * ⚠️ 鏡位刻意跟 LINE 那批一致（窄長條、框緊貼元件）：2026-09-03 老闆反映「紅框粗細要跟
   *    創建時一樣」，實測後發現框線本來就都是 2px，差的是**裁切的廣角程度**——
   *    原本把整個 Google 對話框收進來，同樣顯示寬度下框線看起來就變髮絲線。
   * ⛔ 號碼跨三張連續（同一段流程），改順序要一起改 `make-onboarding-shots.py` 重跑。
   */
  gsheetShare1: '/onboarding/gsheet-share-1.png',
  gsheetShare2: '/onboarding/gsheet-share-2.png',
  gsheetShare3: '/onboarding/gsheet-share-3.png',
} as const
