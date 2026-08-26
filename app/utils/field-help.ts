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

export type FieldHelpId =
  | 'channelAccessToken'
  | 'channelSecret'
  | 'webhookUrl'
  | 'liffSetup'
  | 'oamAutoReply'
  // 2026-08-26 `D-33` P1：逐頁盤點後真的缺教學的三格。
  // ⚠️盤點的教訓：先看那一格「現在有沒有說明」再決定要不要加——這一頁大多數欄位
  // 底下已經有一段白話 hint，再塞一顆問號只是把畫面弄吵。
  | 'aiThresholds'
  | 'scriptCustomFormat'
  | 'memberRole'

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
    html: '這一格<b>不用填</b>——按旁邊的「複製」拿到網址，照動畫貼到 LINE：選掛著「<b>Messaging API</b>」小字的那張卡（同名卡片可能有兩張）→ 切到 <b>Messaging API</b> 分頁 → Webhook URL 按「<b>Edit</b>」打開輸入格 → 貼上網址按「<b>Update</b>」存檔 → 打開「<b>Use webhook</b>」開關。',
    image: ONBOARDING_SHOTS.webhookAnim,
    alt: '循環動畫：選 Messaging API 卡、切分頁、貼 Webhook 網址、開 Use webhook',
    href: 'https://developers.line.biz/console/',
    hrefLabel: '打開 LINE Developers',
  },
  liffSetup: {
    button: '教我怎麼設',
    title: '活動頁 LIFF 怎麼設？',
    // ⚠️跟拿鑰匙相反：LIFF 住在「LINE Login」那張卡下面——拿鑰匙教學教人別點的那張，
    // 這裡必須明講，否則兩份教學互打（2026-08-19 D-17 盤點抓到的雷）
    html: '活動頁的 LIFF 建在「<b>LINE Login</b>」那張卡下面——⚠️<b>跟拿鑰匙相反</b>，這次別點 Messaging API。流程：到 LINE Developers 點 <b>LINE Login</b> 那張卡 → 切到 <b>LIFF</b> 分頁按「Add」→ <b>Endpoint URL</b> 貼下面「活動 LIFF 頁」的網址（按它旁邊的「複製」）→ 建好後把 <b>LIFF ID</b>（長得像 2007123456-AbCdEfGh）複製回來貼進這一格。',
    image: ONBOARDING_SHOTS.liffSetupAnim,
    alt: '循環動畫：LINE Login 頻道的 LIFF 分頁、Add LIFF、貼 Endpoint URL',
    href: 'https://developers.line.biz/console/',
    hrefLabel: '打開 LINE Developers',
  },
  /**
   * 三個門檻的關係（D-33 P1）。
   *
   * 為什麼是「一組一顆」不是「一格一顆」：這裡有五、六個 0 到 1 的小數，每一格底下都已經
   * 有一句說明了——**缺的不是各自的定義，是它們之間的關係**。分開再各加一顆問號，等於五顆
   * 問號還是講不出「這條線上哪一段會直接答、哪一段會反問、哪一段會轉真人」。
   */
  aiThresholds: {
    button: '這幾個門檻怎麼看',
    title: '三個門檻在講同一條線上的三個位置',
    html: `
      <p>AI 每次回答前，都會先在知識庫裡找最接近的一條，算出一個 <b>0 到 1 的相關度</b>。
      下面這三個門檻，就是在這條線上畫界線——決定它<b>直接答、先問清楚、還是交給真人</b>。</p>
      <svg viewBox="0 0 520 108" role="img" aria-label="0 到 1 的相關度軸線，分成轉真人、先問清楚、直接回答三段" style="width:100%;height:auto;margin:10px 0">
        <rect x="20" y="34" width="140" height="22" fill="var(--el-color-danger-light-9)" />
        <rect x="160" y="34" width="150" height="22" fill="var(--el-color-warning-light-9)" />
        <rect x="310" y="34" width="190" height="22" fill="var(--el-color-success-light-9)" />
        <line x1="20" y1="56" x2="500" y2="56" stroke="var(--border-active)" stroke-width="1" />
        <text x="20" y="72" font-size="11" fill="var(--text-muted)">0</text>
        <text x="486" y="72" font-size="11" fill="var(--text-muted)">1</text>
        <text x="30" y="49" font-size="12" fill="var(--el-color-danger)">交給真人</text>
        <text x="186" y="49" font-size="12" fill="var(--el-color-warning)">先問清楚（反問）</text>
        <text x="356" y="49" font-size="12" fill="var(--el-color-success)">直接回答</text>
        <text x="120" y="26" font-size="11" fill="var(--text-secondary)">↓ 反問下限</text>
        <text x="272" y="26" font-size="11" fill="var(--text-secondary)">↓ 反問上限</text>
        <text x="20" y="97" font-size="11" fill="var(--text-secondary)">往右拉＝AI 更敢答（也更可能答錯）　往左拉＝更常轉真人（客人要等人）</text>
      </svg>
      <p><b>信心門檻</b>：AI 對自己這次的答案有多少把握，低於它就不答、轉真人。<br>
      <b>知識庫相關度門檻</b>：找到的那條知識夠不夠貼題，不夠就不硬掰。<br>
      <b>反問下限／上限</b>：中間那一段——沾得上邊但不夠明確，才值得反問客人一句。</p>
      <p>不確定就<b>別動</b>：上面的「回答風格」會幫你一次設好這一整組。真的要調，
      一次只動一個、跑兩三天看「AI 表現」那頁的轉真人比例再決定下一步——同時動三個，
      出問題會分不出是哪一個造成的。</p>
    `,
  },

  /**
   * 自訂格式（D-33 P1）。這一格的標籤自己就寫著「需懂正規表達式」＝已經承認是術語，
   * 而旁邊沒有任何求救出口，只有一個 placeholder。
   */
  scriptCustomFormat: {
    button: '給我幾個例子',
    title: '自訂格式怎麼寫？',
    html: `
      <p>這一格是在教系統「客人回的這串字，長什麼樣才算對」。<b>先看上面的預設格式夠不夠用</b>
      （純數字、英文＋數字、電話、Email…），大多數情況都不用自己寫。</p>
      <p>真的要自訂，直接照抄改：</p>
      <p><b>1 個英文字母＋3 碼以上數字</b>（A123、B4567）→ <code>[A-Za-z]\\d{3,}</code><br>
      <b>固定 6 碼數字</b>（123456）→ <code>\\d{6}</code><br>
      <b>兩個英文字母＋橫線＋4 碼數字</b>（OD-2024）→ <code>[A-Za-z]{2}-\\d{4}</code><br>
      <b>只收「是」或「否」</b> → <code>^(是|否)$</code></p>
      <p>意思：<code>\\d</code>＝一個數字、<code>[A-Za-z]</code>＝一個英文字母、
      <code>{3,}</code>＝前面那個至少 3 次、<code>{2}</code>＝剛好 2 次、
      <code>|</code>＝或、<code>^…$</code>＝整句只能是這樣。</p>
      <p>寫完<b>一定要用上面的「測試觸發」實際打一句試試</b>：格式寫太嚴，客人打對了也會被系統
      一直重問同一題——而後台看起來完全正常。</p>
    `,
  },

  /**
   * 邀請成員時選角色（D-33 P1）。這是四個下拉選項、零說明，而選錯的後果是
   * 把金流與設定權限給錯人——這件事算資安，不算 UX。
   */
  memberRole: {
    button: '各個角色差在哪',
    title: '這三種角色看得到什麼、動得了什麼',
    html: `
      <p><b>管理員</b>：除了刪掉整個帳號以外什麼都能做——<b>包含訂閱與付款、LINE 金鑰、
      成員邀請</b>。給錯人等於把帳單和金鑰一起交出去。</p>
      <p><b>客服</b>：日常做事的角色。回客人訊息、接手對話、改知識庫與自動回應、發推播、貼標籤。
      <b>看不到訂閱付款，也改不了 LINE 連線設定。</b>第一線同事選這個。</p>
      <p><b>觀察者</b>：只能看，不能新增、儲存或發送。適合主管、實習生、外部顧問。</p>
      <p>不確定就先給<b>客服</b>：不夠用隨時可以往上調，反過來收回權限之前，對方已經看過的東西
      收不回來。</p>
    `,
  },

  oamAutoReply: {
    button: '教我怎麼關',
    title: '內建自動回應怎麼關？',
    html: '到 <b>LINE 官方帳號後台</b>（綠色那個，跟拿鑰匙的後台不同）：照動畫點右上角「<b>設定</b>」→ 左邊選「<b>回應設定</b>」→「聊天的回應方式」選「<b>手動聊天</b>」——不要選「手動聊天＋自動回應訊息」。',
    image: ONBOARDING_SHOTS.oamAutoReplyAnim,
    alt: '循環動畫：右上設定、側欄回應設定、選手動聊天',
    href: 'https://manager.line.biz/',
    hrefLabel: '打開官方帳號後台',
  },
}
