/**
 * 欄位教學登記表（2026-08-19 拍板）——「這個欄位怎麼填」的就地教學。
 *
 * 三種教學形式的分工（別混用，詳見 public/onboarding/README.md）：
 * - 從零到完成的旅程 → 滿版對話教學（開通引導）
 * - 單一欄位怎麼填 → 欄位旁按鈕＋就地彈窗（這份登記表＋AdminFieldHelp）
 * - 東西壞了要修 → 右下角小幫手劇本＋聚光燈（agent-guides）
 *
 * 為什麼是彈窗不是滿版也不是小幫手：教學的終點動作是「貼回這個欄位」，
 * 任何把人帶離欄位的形式都輸在起跑點；而單一欄位的內容只有一支動畫＋兩句話，
 * 不需要對話節奏。動畫素材直接複用開通引導那幾支（onboarding-shots）。
 *
 * 加一個欄位教學＝這裡加一筆＋欄位標籤旁掛 <AdminFieldHelp id="..." />。
 * ⚠️ html 以 v-html 渲染：只能放我們自己寫的劇本文案。
 */
import { ONBOARDING_SHOTS } from '~/utils/onboarding-shots'

export interface FieldHelpDef {
  /** 欄位旁按鈕的字樣（「教我怎麼拿」「教我怎麼用」……照欄位的動詞走） */
  button: string
  /** 彈窗標題 */
  title: string
  /** 白話說明（v-html，僅限劇本文案） */
  html: string
  /** 帶路動畫或標註圖（onboarding-shots 的路徑） */
  image?: string
  alt?: string
  /** 外部入口（另開分頁） */
  href?: string
  hrefLabel?: string
}

export type FieldHelpId = 'channelAccessToken' | 'channelSecret' | 'webhookUrl'

export const FIELD_HELP: Record<FieldHelpId, FieldHelpDef> = {
  channelAccessToken: {
    button: '教我怎麼拿',
    title: 'Channel Access Token 怎麼拿？',
    html: '到 <b>LINE Developers</b>，選掛著「<b>Messaging API</b>」小字的那張卡（同名卡片可能有兩張，認小字不認名稱），照動畫切到 <b>Messaging API</b> 分頁 → 捲到最下面按「<b>Issue</b>」發一把（發過的話按 Reissue）→ 按複製，回來貼進這一格。',
    image: ONBOARDING_SHOTS.getTokenAnim,
    alt: '循環動畫：切到 Messaging API 分頁、捲到最下方、按 Issue 發鑰匙、按複製',
    href: 'https://developers.line.biz/console/',
    hrefLabel: '打開 LINE Developers',
  },
  channelSecret: {
    button: '教我怎麼拿',
    title: 'Channel Secret 怎麼拿？',
    html: '同一個 <b>LINE Developers</b> 後台：照動畫切到「<b>Basic settings</b>」分頁，捲下來找到 <b>Channel secret</b>，整串複製回來貼進這一格。',
    image: ONBOARDING_SHOTS.channelSecretAnim,
    alt: '循環動畫：切到 Basic settings 分頁、捲到 Channel secret 那一列',
    href: 'https://developers.line.biz/console/',
    hrefLabel: '打開 LINE Developers',
  },
  webhookUrl: {
    button: '教我怎麼用',
    title: 'Webhook 網址要貼去哪？',
    html: '這一格<b>不用填</b>——按旁邊的「複製」拿到網址，貼到 <b>LINE Developers → Messaging API</b> 的 <b>Webhook URL</b> 欄位（圖上的 ①），按「Update」存檔，再把「<b>Use webhook</b>」開關打開（圖上的 ②）。',
    image: ONBOARDING_SHOTS.webhookUrl,
    alt: 'Messaging API 分頁，標出 Webhook URL 欄位與 Use webhook 開關',
    href: 'https://developers.line.biz/console/',
    hrefLabel: '打開 LINE Developers',
  },
}
