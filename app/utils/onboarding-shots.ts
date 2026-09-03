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
  /** 循環動畫：帳號清單整頁（含麵包屑定位）→ 聚焦「Messaging API」小字（教學用） */
  consoleChannelAnim: '/onboarding/line-console-channel.webp',
  /** 循環動畫：①切到 Messaging API 分頁 → 捲到最底 → ②按 Issue 發鑰匙 → ③按複製 */
  getTokenAnim: '/onboarding/line-console-get-token.webp',
  /** Messaging API 分頁最下方：發第一把鑰匙（Issue / Reissue） */
  issueToken: '/onboarding/line-console-issue-token.png',
  /** 官方帳號後台的帳號一覽：「你已經有 LINE 官方帳號了嗎？」那一題的配圖。
   *  ⛔ 來源圖裡三列都是真實客戶的帳號名稱與頭像，產線有糊掉——換圖時要重新對座標 */
  oamAccountList: '/onboarding/oam-account-list.png',
  /** 官方帳號後台：設定 → Messaging API 按啟用（清單裡找不到帳號時的岔路） */
  oamEnableMessagingApi: '/onboarding/oam-enable-messaging-api.png',
  /** 循環動畫：①切 Basic settings 分頁 → 捲下來 → ②找到 Channel secret（緊裁列圖缺定位已退場） */
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
  /** 只圈 Use webhook 開關（上面留網址那列當定位）：接線教學的第三步用，別跟上面那張混 */
  useWebhook: '/onboarding/line-console-use-webhook.png',
  /** 循環動畫：貼 Webhook 網址——①選對卡（同名雙卡）→ ②切分頁 → ③按 Edit → ④貼上按 Update。
   *  ⛔停在④：開 Use webhook 是教學的**下一步**，演進來的話人會提前做完（2026-09-02 重裁） */
  webhookAnim: '/onboarding/line-console-webhook.webp',
  /** 循環動畫：官方帳號後台——①右上「設定」→ ②側欄「回應設定」→ ③選「手動聊天」 */
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
