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
/**
 * ⚠️ **2026-09-10 起，開通引導那條路已經不吃這張表**——它改用下面的 `ONBOARDING_CAROUSELS`
 * （一步一張圖）。這裡剩下的呼叫點是 `field-help.ts`（設定頁欄位旁的「教我怎麼拿」）
 * 與 `agent-guides.ts`（帶你修好的診斷劇本）。
 *
 * 底下這六支**當天起零呼叫點**（檔案與產線都還在，沒有刪）：
 * `oamAccountList`、`oamEnableAnim`、`consoleChannelAnim`、`oamChannelSecretAnim`、
 * `oamWebhookUrlAnim`、`oamResponseSettingsAnim`。
 * ⛔ 留著不是忘了刪，是**輪播還沒上過真機**：真的出問題時，換回 `kind: 'image'` 就退得回去。
 * 退場時機記在 `docs/STATUS.md`（連同該不該一起從產線拿掉）。
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

/**
 * 步驟輪播的分鏡與圖說（2026-09-10 落地，示意頁第四十二～四十六版拍板）。
 *
 * **一步一張圖、圖在上步驟在下**，取代上面那些「一支動畫演三四個動作」的循環 webp。
 * 循環動畫的病：中途接上的人不知道演到第幾步、想多看一眼第②步只能等它繞回來，
 * 而該做什麼的字全擠在泡泡裡（`①…→②…→③…`）——眼睛要在一行長字與一直在動的圖之間對照。
 *
 * ⛔ **圖與圖說寫在同一個地方**（不是圖放這裡、①②③放劇本），這是刻意的：
 *    舊做法「動畫上的紅色編號」與「文案裡的①②③」是兩個檔案裡的兩份資料，
 *    改了一邊不會有任何測試變紅，只有使用者會發現③指到別的動作。綁在一起就不可能漂。
 * ⚠️ 分鏡檔上的紅色編號徽章**仍然在**（它指的是畫面上那個框），但右下角的
 *    「第幾格／共幾格」已經拿掉——步序由輪播卡自己的計數器與步驟軌講。
 * ⚠️ 圖說裡的 `<b>` 是**畫面上要找的那個東西**（會上綠色），不是拿來加強語氣的。
 * ⚠️ 檔名固定不帶日期，圖還沒補進 `public/onboarding/` 也能出貨：載不起來的那一步
 *    會被輪播卡自己濾掉，全部載不到就整張卡不畫、文字照常。
 */
export const ONBOARDING_CAROUSELS = {
  /** 「你已經有 LINE 官方帳號了嗎？」——最早的分岔，答錯整條路白走 */
  accountList: [
    { src: '/onboarding/oam-account-list-1.webp', caption: '先登入，<b>用你平常的方式</b>就可以' },
    { src: '/onboarding/oam-account-list-2.webp', caption: '列表裡<b>有帳號就是有</b>' },
  ],
  /**
   * 還沒有官方帳號 → 去申請。
   * ⚠️ 第一格特別點名「別按錯」：那一頁**更下面還有 LINE 廣告的申請入口**，
   *    長得很像，按下去是完全另一條路。
   */
  signupEntry: [
    { src: '/onboarding/line-signup-entry-1.webp', caption: '捲到「<b>LINE 官方帳號</b>」那一段，按下面的「<b>免費開設帳號</b>」<br>⚠️ 頁面更下面還有 LINE 廣告的申請，別按錯' },
    { src: '/onboarding/line-signup-entry-2.webp', caption: '用你平常的方式登入' },
  ],
  /**
   * 啟用 Messaging API——**兩處共用同一份**（「還沒有官方帳號」那條路，
   * 以及「清單裡沒看到我的帳號？」那條岔路）：走到這兩處的人都沒做過這件事。
   * ⛔ 停在第 4 步，**不演完成畫面**：演到「已經好了」會讓人以為不用按那顆確定。
   */
  enableMessagingApi: [
    { src: '/onboarding/oam-enable-messaging-api-1.webp', caption: '按「<b>啟用Messaging API</b>」' },
    { src: '/onboarding/oam-enable-messaging-api-2.webp', caption: '選「<b>建立服務提供者</b>」，名稱<b>用你的店名就好</b>，按「同意」' },
    { src: '/onboarding/oam-enable-messaging-api-3.webp', caption: '隱私權那兩欄<b>可以不填</b>，直接按「確定」' },
    { src: '/onboarding/oam-enable-messaging-api-4.webp', caption: '最後那句「無法變更或解除」是正常的，按「<b>確定</b>」' },
  ],
  /**
   * LINE Developers：登入 → 在清單裡挑對卡。
   * ⚠️ 第一格**刻意零標註**：圈哪顆登入按鈕都會誤導用其他方式登入的人，
   *    它在這裡的作用是定位（「你會看到這一頁」），不是指路。
   */
  consoleChannel: [
    { src: '/onboarding/line-console-channel-1.webp', caption: '先登入，<b>用你平常的方式</b>就可以' },
    { src: '/onboarding/line-console-channel-2.webp', caption: '<b>同名卡片可能有兩張</b>：認下面寫著「Messaging API」小字的那張' },
  ],
  /**
   * 拿第一組連線資訊（Channel Access Token）。
   * ⚠️ 第 2、3 格是用**還沒發過 token** 的帳號拍的：舊圖那顆按鈕寫「Reissue」，
   *    而第一次來的人看到的是「Issue」；第 3 格的複製圖示也是按完之後才會出現。
   */
  getToken: [
    { src: '/onboarding/line-console-get-token-1.webp', caption: '切到「<b>Messaging API</b>」分頁' },
    { src: '/onboarding/line-console-get-token-2.webp', caption: '捲到最下面，Channel access token 按「<b>Issue</b>」（發行）' },
    { src: '/onboarding/line-console-get-token-3.webp', caption: 'token 出來了 → 按<b>複製</b>圖示整串複製' },
  ],
  /**
   * 拿第二組連線資訊（Channel Secret）——在**官方帳號後台**，不是 LINE Developers。
   * ⚠️ Channel ID 與 Channel secret 上下相鄰、**各有一顆複製鈕**，所以第 3 格框的是
   *    整列不是按鈕，圖說也明講「上面一列是 Channel ID」。
   */
  channelSecret: [
    { src: '/onboarding/oam-channel-secret-1.webp', caption: '點右上角「<b>設定</b>」' },
    { src: '/onboarding/oam-channel-secret-2.webp', caption: '左邊選「<b>Messaging API</b>」' },
    { src: '/onboarding/oam-channel-secret-3.webp', caption: '找到 <b>Channel secret</b> 那一列，按右邊的「<b>複製</b>」<br>⚠️ 上面一列是 Channel ID，別按錯' },
  ],
  /**
   * 貼 Webhook 網址。⛔ 停在「按儲存」，**不演開 Use webhook**：那是下一支的事，
   * 演進來的話人會提前做完。
   * ⚠️ 含①②導航是刻意的：上一步跟這一步中間**離開過**（回來貼 secret、複製網址），
   *    回來的人可能已經不在那一頁——重新帶路是接住迷路的人，不是重複。
   */
  webhookUrl: [
    { src: '/onboarding/oam-webhook-url-1.webp', caption: '點右上角「<b>設定</b>」' },
    { src: '/onboarding/oam-webhook-url-2.webp', caption: '左邊選「<b>Messaging API</b>」' },
    { src: '/onboarding/oam-webhook-url-3.webp', caption: '把網址貼進「<b>Webhook網址</b>」那一格' },
    { src: '/onboarding/oam-webhook-url-4.webp', caption: '按右邊的「<b>儲存</b>」——<b>沒按儲存是接不通的第一名</b>' },
  ],
  /**
   * 開 Webhook 開關＋把回應方式改成手動聊天（同一頁做完兩件事）。
   * ⛔ 這一支**刻意不含「點右上角設定」**：走到這一步的人前兩步已經在「設定」裡面待過了，
   *    再叫他點一次是叫他去他已經站著的地方。判準是「中間有沒有離開」，不是「同不同一頁」。
   */
  responseSettings: [
    { src: '/onboarding/oam-response-settings-1.webp', caption: '左邊選「<b>回應設定</b>」' },
    { src: '/onboarding/oam-response-settings-2.webp', caption: '把「<b>Webhook</b>」<b>打開</b>（已經是綠的就不用動）' },
    { src: '/onboarding/oam-response-settings-3.webp', caption: '「聊天的回應方式」選「<b>手動聊天</b>」⛔ 別選「手動聊天＋自動回應訊息」' },
  ],
} as const
