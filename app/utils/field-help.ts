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
  /**
   * 「填錯會怎樣」——只給**填錯不會報錯、但客人一定壞掉**的欄位用。
   *
   * ⛔ 別拿它當第二段說明：這一塊是警告色，每個欄位都掛就等於沒有一個是警告。
   * 判準：畫面上有沒有任何地方會告訴你填錯了？沒有的話才需要它。
   * 目前只有 liffSetup 的 Endpoint URL 符合（客人卡在轉圈，後台一片正常）。
   */
  warn?: string
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
  // 2026-08-29 `D-40`：D-33 P2 就列了、一直沒做的那一組。
  | 'knowledgeAutoUpdate'

export const FIELD_HELP: Record<FieldHelpId, FieldHelpDef> = {
  channelAccessToken: {
    button: '教我怎麼拿',
    title: 'Channel Access Token 怎麼拿？',
    // ⚠️①②③要跟動畫上的紅色編號一致（2026-09-02，同 useOnboardingChat 的拿鑰匙教學）
    html: '到 <b>LINE Developers</b>，選掛著「<b>Messaging API</b>」小字的那張卡（同名卡片可能有兩張，認小字不認名稱）。照動畫做：<b>①</b> 切到 <b>Messaging API</b> 分頁 → 捲到最下面 → <b>②</b> 按「<b>Issue</b>」發一把（發過的話按 Reissue）→ <b>③</b> 按複製，回來貼進這一格。',
    image: ONBOARDING_SHOTS.getTokenAnim,
    alt: '循環動畫三格：①切到 Messaging API 分頁、②按 Issue 發鑰匙、③按複製圖示',
    href: 'https://developers.line.biz/console/',
    hrefLabel: '打開 LINE Developers',
  },
  channelSecret: {
    button: '教我怎麼拿',
    title: 'Channel Secret 怎麼拿？',
    html: '同一個 <b>LINE Developers</b> 後台，照動畫做：<b>①</b> 切到「<b>Basic settings</b>」分頁 → 捲下來 → <b>②</b> 找到 <b>Channel secret</b>，整串複製回來貼進這一格。',
    image: ONBOARDING_SHOTS.channelSecretAnim,
    alt: '循環動畫兩格：①切到 Basic settings 分頁、②Channel secret 那一列',
    href: 'https://developers.line.biz/console/',
    hrefLabel: '打開 LINE Developers',
  },
  webhookUrl: {
    button: '教我怎麼用',
    title: 'Webhook 網址要貼去哪？',
    // ⚠️動畫只演到④存檔（2026-09-02 重裁）——開關那一步動畫裡沒有，文案必須自己講完，
    // 否則跟著動畫做的人會漏掉「接不通的第二名」。這裡是單一彈窗，要覆蓋整件事。
    html: '這一格<b>不用填</b>——按旁邊的「複製」拿到網址，照動畫貼到 LINE（動畫上的紅色號碼就是順序）：<b>①</b> 選掛著「<b>Messaging API</b>」小字的那張卡（同名卡片可能有兩張）→ <b>②</b> 切到 <b>Messaging API</b> 分頁 → <b>③</b> Webhook URL 按「<b>Edit</b>」打開輸入格 → <b>④</b> 貼上網址按「<b>Update</b>」存檔。<br>最後再把網址下方的「<b>Use webhook</b>」開關<b>打開</b>——這一步動畫沒有演到，但沒開的話訊息一樣不會進來。',
    image: ONBOARDING_SHOTS.webhookAnim,
    alt: '循環動畫四格：①選 Messaging API 卡、②切到 Messaging API 分頁、③按 Edit 打開輸入格、④貼上網址按 Update 存檔',
    href: 'https://developers.line.biz/console/',
    hrefLabel: '打開 LINE Developers',
  },
  liffSetup: {
    button: '教我怎麼設',
    title: '活動頁 LIFF 怎麼設？',
    // ⚠️跟拿鑰匙相反：LIFF 住在「LINE Login」那張卡下面——拿鑰匙教學教人別點的那張，
    // 這裡必須明講，否則兩份教學互打（2026-08-19 D-17 盤點抓到的雷）
    // 2026-09-02 老闆補拍了 LIFF 清單與 Add 表單，動畫從兩格補到四格（原本後半段只有文字）。
    // ⛔ 第一句刻意先講「你可能不需要」：LIFF **只有活動連結在用**（`server/api/liff/` 底下
    //    只有 claim／apply／config 三支，全是活動的）。客服對話、AI、推播、圖文選單、標籤、
    //    成員收通知都不碰它——成員綁定走的是「綁定 XXXXXX」那組碼，跟 LIFF 無關。
    //    不講的話，只想做客服的人會以為自己少做一步、卡在這裡研究。
    html: '<b>還沒要辦活動的話可以先不設</b>——這一格只有「活動連結」會用到，不設不影響客服、AI、推播與圖文選單。<br>要設的話：活動頁的 LIFF 建在「<b>LINE Login</b>」那張卡下面（⚠️<b>跟拿鑰匙相反</b>，這次別點 Messaging API）。照動畫做：<b>①</b> 點 <b>LINE Login</b> 那張卡 → <b>②</b> 切到 <b>LIFF</b> 分頁 → <b>③</b> 按「<b>Add</b>」→ <b>④</b> <b>Endpoint URL</b> 貼下面「活動 LIFF 頁」的網址（按它旁邊的「複製」）。<br>建好後把 <b>LIFF ID</b>（長得像 2007123456-AbCdEfGh）複製回來貼進這一格。',
    image: ONBOARDING_SHOTS.liffSetupAnim,
    alt: '循環動畫四格：①點 LINE Login 那張卡、②切到 LIFF 分頁、③按 Add、④填 Endpoint URL',
    // ⚠️ 這段非講不可（2026-08-07 換網域災情的形狀）：Endpoint URL 是整支教學唯一
    //    「填錯不會報錯、但客人一定壞掉」的一格
    warn: '<b>④ 那一格填錯，客人會卡在轉圈。</b>客人登入後，LINE <b>一定</b>把他送回這裡登記的網址——跟你分享出去的連結是什麼網域無關。填錯的話貼標與綁定都不會發生。',
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
  /**
   * 自動更新三格一組（D-33 P2 列了沒做，D-40 補上）。
   *
   * 為什麼是一組一顆：每一格自己都有說明，缺的是**三格之間的連動**——
   * 「偵測到變動時」選了只記錄，下面那格就整個失效；「偵測頻率」選不自動偵測，
   * 上面兩格講什麼都不會發生。而使用者真正想問的只有一句：
   * <b>它會不會自己改掉我編過的東西</b>。那句話要第一個回答。
   */
  knowledgeAutoUpdate: {
    button: '它會自己改我的知識嗎',
    title: '自動更新會動什麼、不會動什麼',
    html: `
      <p><b>先回答最重要的一句：你自己編輯過的知識，永遠不會被自動蓋掉。</b>
      自動更新只會動「從這個網址／試算表原封抓進來、之後沒人碰過」的那些。</p>
      <svg viewBox="0 0 520 96" role="img" aria-label="流程示意：網頁改了之後，小幅文字更新會自動套用，新增刪除或大幅改版會先問過你" style="width:100%;height:auto;margin:10px 0">
        <rect x="4" y="30" width="120" height="34" rx="5" fill="var(--el-fill-color-light)" stroke="var(--el-border-color-lighter)" />
        <text x="64" y="51" font-size="12" text-anchor="middle" fill="var(--text-primary)">網頁改了</text>
        <path d="M128 47 L162 47" stroke="var(--border-active)" stroke-width="1.5" marker-end="url(#fhArrow)" />
        <rect x="168" y="4" width="164" height="38" rx="5" fill="var(--el-color-success-light-9)" stroke="var(--el-color-success-light-5)" />
        <text x="250" y="20" font-size="11" text-anchor="middle" fill="var(--el-color-success)">只是改字、錯字、小段落</text>
        <text x="250" y="35" font-size="12" text-anchor="middle" fill="var(--text-primary)">自動更新，不吵你</text>
        <rect x="168" y="52" width="164" height="38" rx="5" fill="var(--el-color-warning-light-9)" stroke="var(--el-color-warning-light-5)" />
        <text x="250" y="68" font-size="11" text-anchor="middle" fill="var(--el-color-warning)">新增／刪除／大幅改版</text>
        <text x="250" y="83" font-size="12" text-anchor="middle" fill="var(--text-primary)">先標提示，等你看過</text>
        <path d="M336 23 L370 23" stroke="var(--border-active)" stroke-width="1.5" marker-end="url(#fhArrow)" />
        <path d="M336 71 L370 71" stroke="var(--border-active)" stroke-width="1.5" marker-end="url(#fhArrow)" />
        <rect x="376" y="30" width="140" height="34" rx="5" fill="var(--el-fill-color-light)" stroke="var(--el-border-color-lighter)" />
        <text x="446" y="45" font-size="11" text-anchor="middle" fill="var(--text-primary)">你編過的那幾條</text>
        <text x="446" y="58" font-size="11" text-anchor="middle" fill="var(--el-color-success)">一律保留</text>
        <defs>
          <marker id="fhArrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0 0 L8 4 L0 8 z" fill="var(--border-active)" />
          </marker>
        </defs>
      </svg>
      <p>三格是<b>由上往下連動</b>的，設定前先看這個順序：</p>
      <p><b>① 偵測頻率</b>＝多久去看一次。選「不自動偵測」的話，<b>下面兩格就都不會發生</b>，
      要更新只能自己按「重新同步」。<br>
      <b>② 偵測到變動時</b>＝發現不一樣了要不要告訴你。選「只記錄不通知」的話，
      <b>第三格會整個變灰</b>——都不通知了，也就沒有「要不要自動套用」的問題。<br>
      <b>③ 小幅文字變動</b>＝只有改字這種小變動，要直接套用還是等你確認。</p>
      <p>不確定就用<b>預設值</b>（每天偵測、通知我、小幅自動更新）：這組的意思是
      「錯字幫你跟上，重要的事一定問過你」。</p>
    `,
  },

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
    html: '到 <b>LINE 官方帳號後台</b>（綠色那個，跟拿鑰匙的後台不同），照動畫做：<b>①</b> 點右上角「<b>設定</b>」→ <b>②</b> 左邊選「<b>回應設定</b>」→ <b>③</b>「聊天的回應方式」選「<b>手動聊天</b>」——不要選「手動聊天＋自動回應訊息」。',
    image: ONBOARDING_SHOTS.oamAutoReplyAnim,
    alt: '循環動畫三格：①右上設定、②側欄回應設定、③選手動聊天',
    href: 'https://manager.line.biz/',
    hrefLabel: '打開官方帳號後台',
  },
}
