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
 */
export const ONBOARDING_SHOTS = {
  /** LINE Developers 帳號清單（靜態，修復劇本用）：認卡片下方「Messaging API」小字 */
  consoleChannel: '/onboarding/line-console-channel.png',
  /** 循環動畫：帳號清單整頁（含麵包屑定位）→ 聚焦「Messaging API」小字（教學用） */
  consoleChannelAnim: '/onboarding/line-console-channel.webp',
  /** 循環動畫：切到 Messaging API 分頁 → 捲到最底 → 按 Issue 發鑰匙 → 按複製 */
  getTokenAnim: '/onboarding/line-console-get-token.webp',
  /** Messaging API 分頁最下方：發第一把鑰匙（Issue / Reissue） */
  issueToken: '/onboarding/line-console-issue-token.png',
  /** 官方帳號後台：設定 → Messaging API 按啟用（清單裡找不到帳號時的岔路） */
  oamEnableMessagingApi: '/onboarding/oam-enable-messaging-api.png',
  /** 循環動畫：切 Basic settings 分頁 → 捲下來 → 找到 Channel secret（緊裁列圖缺定位已退場） */
  channelSecretAnim: '/onboarding/line-console-channel-secret.webp',
  /** Messaging API 分頁：Webhook URL 欄位＋Use webhook 開關（靜態①②，修復劇本用） */
  webhookUrl: '/onboarding/line-console-webhook-url.png',
  /** 循環動畫：貼 Webhook 網址全程——選對卡（同名雙卡）→ 切分頁 → 貼網址按 Update → 開 Use webhook */
  webhookAnim: '/onboarding/line-console-webhook.webp',
  /** 循環動畫：官方帳號後台——右上「設定」→ 側欄「回應設定」→ 選「手動聊天」 */
  oamAutoReplyAnim: '/onboarding/oam-auto-reply.webp',
  /** 循環動畫：建活動頁 LIFF（LINE Login 那張卡 → LIFF 分頁 → Add → 貼 Endpoint）。⚠️截圖尚缺，補進 src 後產 */
  liffSetupAnim: '/onboarding/line-console-liff-setup.webp',
} as const
