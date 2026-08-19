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
  /** LINE Developers 首頁：選到自己的官方帳號 */
  consoleChannel: '/onboarding/line-console-channel.png',
  /** Messaging API 分頁最下方：發第一把鑰匙（Issue / Reissue） */
  issueToken: '/onboarding/line-console-issue-token.png',
  /** 官方帳號後台：設定 → Messaging API 按啟用（清單裡找不到帳號時的岔路） */
  oamEnableMessagingApi: '/onboarding/oam-enable-messaging-api.png',
  /** Basic settings 分頁：第二把鑰匙 Channel secret */
  channelSecret: '/onboarding/line-console-channel-secret.png',
  /** Messaging API 分頁：Webhook URL 欄位＋Update 鈕＋Use webhook 開關（一張圖三個框） */
  webhookUrl: '/onboarding/line-console-webhook-url.png',
  /** 官方帳號後台：回應設定 → 關掉內建自動回應 */
  oamAutoReply: '/onboarding/oam-auto-reply.png',
} as const
