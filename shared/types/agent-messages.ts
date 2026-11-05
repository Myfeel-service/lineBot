/**
 * agent 對話的「結構化訊息」合約。
 *
 * 一個渲染層、兩種 driver：
 * - 劇本 driver（開通引導精靈，純前端狀態機、零 LLM）
 * - LLM driver（後台查詢助理；未來「從查到做」時回這些型別就能長出按鈕/卡片）
 * 兩邊產出的訊息長一樣、由同一個 AgentMessageRenderer 渲染——
 * 這層就是 docs/ASSISTANT-AGENT-EVAL-20260806.md 方向 D 缺的那塊地基。
 *
 * ⚠️ text 的 html 欄位會以 v-html 渲染：只能放我們自己寫的劇本文案；
 *    任何使用者輸入要先經過 escapeHtml 再插進去。
 */

/**
 * 圖解步驟卡的一小步。
 *
 * 一步只講一件事——「打開後台」跟「找到某個分頁」是兩步，不要併成一句。
 * 使用者是照著這行字在別人的網站上找東西，句子越長越難對照。
 */
export interface AgentHelpStep {
  /** 這一步要做什麼（白話、一件事） */
  text: string
  /**
   * 示意圖路徑（`public/` 底下，統一取自 app/utils/onboarding-shots）。
   * 圖檔還沒放進去時整塊自動不顯示、文字照常——所以可以先接圖再補檔。
   */
  image?: string
  /** 圖片替代文字（讀螢幕軟體會唸）。有圖就要寫，別讓它只唸出檔名 */
  alt?: string
  /**
   * 這一步自己的入口連結（另開分頁）。
   * 「打開某某後台」這種步驟一律用它——把連結擺在卡片最下面、步驟裡寫「下面有連結」，
   * 等於要人自己往下找一次，第一步就該直接點得到。
   */
  href?: string
  hrefLabel?: string
  /**
   * 岔路：預設收合的補充。用在「只有一部分人會遇到」的情況
   * （例：清單裡找不到自己的帳號），塞進主步驟會害所有人多讀一段不相干的字。
   * 岔路常常要跑去另一個後台，所以它自己也可以配一張圖。
   */
  aside?: { summary: string; text: string; image?: string; alt?: string }
}

export type AgentMsg =
  /**
   * 一般泡泡。html 僅限劇本文案 + 已跳脫的使用者輸入。
   *
   * `aside`＝預設**收合**的「為什麼／萬一沒做會怎樣」。
   * 2026-09-02 量過：開通引導 48 句共 2,627 字，其中**約四成是解釋不是動作**，
   * 全部攤在主線上＝使用者一句都不讀。⛔ 解法是收起來不是刪掉——那些解釋正好是
   * 接不通時的第一名與第二名原因，刪掉會讓人做錯。
   * 判準：**照著做需要的話留在外面，解釋為什麼要這樣做的收進去。**
   */
  | { kind: 'text'; html: string; aside?: { summary: string; html: string; image?: string; alt?: string } }
  /** 圖解步驟卡（「怎麼拿？」）：一步一格、可配示意圖；href 給可直接點開的入口（別讓使用者自己打網址） */
  | { kind: 'help'; summary: string; steps: AgentHelpStep[]; href?: string; hrefLabel?: string }
  /** 連結卡。internal＝站內頁（走 NuxtLink 同分頁導航）；否則視為外部連結另開分頁 */
  | { kind: 'link'; label: string; href: string; internal?: boolean }
  /**
   * 「帶我走一遍」卡（`D-109`）：按下去**直接開**一支導覽（tour）、一條劇本（guide），
   * 或打開小幫手的「目前狀況」分頁（status，異常與一鍵修都在那裡）——不是換頁。
   * `ref` 由 `shared/agent-teachings.ts` 的白名單決定（模型不生 id）；卡上的字由前端照教材名顯示。
   */
  | { kind: 'teach'; teach: 'tour' | 'guide' | 'status'; ref: string }
  /**
   * 單張示意圖卡（節點式教學「一步一張圖」用；也吃循環動畫 webp）。
   * 檔案載不到就整張不顯示——不破圖，所以劇本可以先接圖、截圖之後補檔。
   */
  | { kind: 'image'; src: string; alt: string }
  /**
   * 步驟輪播卡：**一步一張圖，圖在上、步驟在下**（2026-09-10 落地，示意頁第四十二～四十六版）。
   *
   * 取代「一支循環動畫演三四個動作」的舊做法。循環動畫的病：中途接上的人不知道演到第幾步、
   * 想多看一眼第②步只能等它繞回來，而該做什麼的字全擠在上面那則泡泡裡（`①…→②…→③…`），
   * 眼睛要在「一行長字」與「一直在動的圖」之間來回對照。
   * 輪播把兩者綁在一起：**這一格的圖配這一格的說明**，看不完就停在那裡。
   *
   * ⚠️ 圖上的紅色編號徽章仍在（它指的是畫面上那個框），但**右下角的「第幾格／共幾格」拿掉了**
   *    ——步序改由卡片自己的計數器與步驟軌講，留著就是同一件事講兩次。
   * ⚠️ 每一步的圖本身還是**小動畫**（無框→框亮起），所以「這一步在動」跟「換到下一步」
   *    是兩件事：前者是 webp 自己的事，後者由元件的計時器管。
   * ⛔ 步驟數要跟 `caption` 一一對應——少給一句說明那一格就是空的。
   */
  | { kind: 'carousel'; steps: readonly { readonly src: string; readonly caption: string }[] }
  /** 一鍵複製卡（例：Webhook 網址） */
  | { kind: 'copy'; label: string; value: string }
  /** 進行中/成功/失敗/略過 狀態卡。skipped 是使用者的正當選擇，語意中性——別用 fail 的警告色裝它 */
  | { kind: 'status'; state: 'pending' | 'ok' | 'fail' | 'skipped'; text: string }
  /** 強調卡：回顯收到的第一則訊息（見證時刻） */
  | { kind: 'highlight'; label: string; title: string; meta?: string }
  /**
   * 客人會收到的「告訴我生日」卡（`C-468`：接完 LINE 問要不要順便問生日）。
   * ⛔ 字由呼叫端從 `shared/birthday.ts` 帶進來（跟送出端、好友頁「生日」框同一份），這裡只管長相。
   */
  | { kind: 'birthday-card'; caption: string; title: string; note: string; button: string }
  /**
   * 見證時刻的**兩步驟卡**（2026-09-11 取代舊的 `oaInvite` ＋ 另一張獨立的等待狀態卡）。
   *
   * ⭐ 為什麼要併：原本 ①② 寫在泡泡裡、①要用的 QR 在下一張卡、②的狀態（還在等）在
   * 再下一張卡——**三個區塊講同一件事**，讀者得自己把「② 傳一句話」跟最底下那張轉圈的卡
   * 連起來。併成一張之後**每一步旁邊就是那一步要用的東西**。
   *
   * ⚠️ `basicId` 等三個欄位是**選填**：這張卡必須在問 LINE 拿帳號代號**之前**就先畫出來
   * （那支請求沒有逾時，等它回來才畫＝人已經照做了、畫面卻什麼都沒有）。拿到之後再
   * `updateMsg` 補上；拿不到就只少了 QR 與代號，第①②步照樣讀得懂。
   * ⚠️ 第②步的狀態是**這張卡的一部分**（`waitState`／`waitText`），不是另一張 status 卡；
   * 收到訊息時改成 `ok` 而**不是把它拿掉**——整張卡要收在打勾上，拿掉會像那一步沒做完。
   */
  | {
    kind: 'witness'
    basicId?: string
    addFriendUrl?: string
    qrDataUrl?: string
    /** 官方帳號在 LINE 上的名稱與頭像（`C-250`③：用他待會在手機上看到的樣子講「加哪一個」） */
    oaName?: string
    oaPictureUrl?: string
    waitState: 'pending' | 'ok' | 'skipped'
    waitText: string
  }
  /**
   * 完成摘要卡。`title` 不給＝預設「開通結果」（接 LINE 那一趟）；
   * 打造那一趟給「MiniMe 打造完成」（`C-250`，⛔ 不再叫「第 1 段完成」——老闆 09-25「第一段第二段不好理解」）。
   *
   * `C-457`（`D-172`，2026-11-04 John 哥會議、老闆照建議）打造那一趟多四格，接 LINE 那一趟不給＝照舊一列一列：
   * - `promise`：最上面那塊「接上 LINE 之後，我會幫你」——先講之後會做什麼，再講這一趟做了什麼。
   * - `itemsLabel`：有給就把 `items` 收成一排小標籤，這是那排的小標題（主角讓給 `promise`）。
   * - `preview`：客人會收到的那則（歡迎訊息真的採用了才給）。
   * - `footnote`：最下面一行小字（方案額度）。
   */
  | {
    kind: 'summary'
    title?: string
    items: { label: string; done: boolean; note?: string }[]
    promise?: { title: string; lines: string[] }
    itemsLabel?: string
    preview?: { caption: string; text: string }
    footnote?: string
  }
  /**
   * 店家輪廓卡（`D-85` / `C-219`）——接線成功那一刻揭曉「我對你的店的認識」。
   *
   * ⛔ 每一列都要帶 `source`：AI 猜的必須看得出是猜的。把猜的畫成確定的，
   *    人就會以為我們真的查到了（競爭對手那一格最危險）。
   * ⛔ 沒有值的列 `value` 是空字串、`hint` 講「為什麼還沒有」——
   *    「還沒問」與「讀了網站沒提到」是兩句不同的話。
   */
  | {
    kind: 'store-profile'
    rows: {
      /** 欄位 id——就地修改時要回報改的是哪一格（`editable` 的卡才需要） */
      fieldId?: string
      label: string
      value: string
      /** 沒有值時要顯示的說明（有值時不用） */
      hint?: string
      source: 'owner' | 'ai' | 'conversation' | 'none'
      sourceText: string
    }[]
    /** 讀網站的結果，一句話（讀完了／讀了一部分／讀不到） */
    siteNote?: string
    /**
     * 分組呈現（`D-93`，2026-09-24 拍板）：你告訴我的／我猜的 N 項（琥珀色塊）／還學不到的 N 項（收合）。
     * ⭐ 十列要他做的事完全不同（你說的＝不用管、AI 猜的＝要看、還學不到＝現在不用做），
     *    畫成一樣重就等於叫他自己分類。分組之後**每列的來源徽章拿掉**（組名已經講了）。
     */
    grouped?: boolean
    /** 「我猜的」那一組的出處（例：從你的網站 5 頁猜的）——⭐ 出處要跟主張長在一起 */
    aiNote?: string
    /**
     * 就地修改（`D-91`）：每列一顆「修改」、還學不到的一顆「填寫」。
     * ⛔ 揭曉那句話寫著「不對的直接改」時，卡片就**一定要改得動**（否則是一句假承諾）。
     * 改完由頁面把 `profile-edit` 事件交給劇本，劇本存檔後整張卡重畫（那一格變成「你說的」）。
     */
    editable?: boolean
  }
  /**
   * 一樣「草稿」（`D-85` / `C-221`）——從店家輪廓長出來的東西，按了採用才會寫出去。
   *
   * ⛔ `where` 一定要有：人最常問的不是「這是什麼」而是「它會跑到哪裡去」。
   * ⛔ `state` 是**採用之後**才填的，未決定時留空——先畫一個結果等於替他做了決定。
   */
  | {
    kind: 'store-draft'
    title: string
    /** 採用後東西會出現在後台哪裡（指路一律用側欄的名字） */
    where: string
    body: string
    note?: string
    /** 這一樣要不要按採用；`info`＝沒有東西要寫，只是告訴他已經有了 */
    variant: 'adopt' | 'info'
    state?: 'adopted' | 'declined' | 'failed'
    stateText?: string
    /**
     * 一開始就可以改（`D-94`，2026-09-24 拍板「給的時候就長這樣就好，不用再按什麼改一下」）：
     * - `text`＝一段話，直接給文字框
     * - `tags`＝三顆標籤，**名字欄＋勾選**（⛔ 不給大文字框：那等於請他把「名字——說明」的格式改壞）
     * ⚠️ 決定完（有 `state`）就收回唯讀——留著可編輯的框會讓人以為還沒定案。
     * 改的內容由頁面把 `draft-input` 事件交給劇本，按「採用」時用的是**他改過的那一版**。
     */
    editable?: 'text' | 'tags'
    /**
     * `editable === 'tags'` 時那一排（`D-171`：六顆、先勾三顆；`on`＝要不要建這一顆）。
     * `criteria`／`code` 跟著走到建立那一刻（AI 判斷條件、固定代號），畫面上不顯示。
     */
    tags?: DraftTagChip[]
    /** 卡片上面那一句（標籤卡：「勾起來，之後發推播就能只發給他們。」） */
    lead?: string
    /**
     * 標籤卡的「還想怎麼分？問 AI」（`D-171`）。有這個欄位才長那一行。
     * - `rev`＝問成一次加一；畫面看 rev 換了才把新的 `ideas` 攤出來（按過「加進上面」就收起來）
     * - `left`＝還能問幾次；0＝用完了，`note` 要講
     * - `note`＝擋掉了什麼／這次沒問成的原因（⛔ 不可以按了沒反應）
     */
    tagAsk?: { busy?: boolean; rev: number; left: number; ideas: DraftTagIdea[]; note?: string }
    /**
     * 「換個說法」（`D-89` ②）：有這個欄位才長那顆鈕（只有歡迎訊息與語氣，`REWORDABLE_DRAFTS`）。
     * - `rev`＝換過幾次；每換成一次加一，框裡的字就換成新的 `body`（⚠️ 靠它不靠 body 比對：
     *   新的一版剛好跟舊 body 一樣時，框裡他打的字不會被換掉，採用的卻是新那一版）
     * - `left`＝還能換幾次；0＝用完了，`note` 要講
     * - `note`＝這次沒換成的原因／用完了（⛔ 不可以按了沒反應）
     */
    reword?: { busy?: boolean; rev: number; left: number; note?: string }
  }

export interface AgentChatEntry {
  /** 遞增流水號，當 v-for key */
  id: number
  role: 'agent' | 'user'
  msg: AgentMsg
}

/** 標籤卡上的一顆（`D-171`） */
export interface DraftTagChip {
  name: string
  why: string
  on: boolean
  /** AI 判斷條件（建立時寫進標籤的 aiCriteria） */
  criteria?: string
  /** 固定代號（跟「標籤管理」範本同一顆時用範本的） */
  code?: string
}

/** 「問 AI」回來、還沒加進那一排的一顆 */
export interface DraftTagIdea {
  name: string
  why: string
  criteria: string
}

export interface AgentChoice {
  label: string
  value: string
  /** 主要動作（填色按鈕），一組選項最多一顆 */
  primary?: boolean
  /** 現在不能按（例：標籤一顆都沒勾時的「建立 0 顆」）。按了也當沒發生 */
  disabled?: boolean
  /**
   * 跳過／離開類（例：先跳過測試、我會了直接貼上）。
   * 只影響排版位置——會被排到最左邊，遠離拇指落點與主要鈕，降低誤按
   * （2026-08-28 拍板，見 docs/ONBOARDING-FIRSTUSE-EVAL-20260828.md 附記三）。
   */
  escape?: boolean
  /**
   * 按下去**不留使用者泡泡**（2026-09-10）。
   *
   * 用在「這是導覽動作，不是對話內容」的鈕——例如「回看教學」，它做的事是把畫面捲回
   * 上面某一則，聊天記錄裡多一句「回看教學」只是雜訊。
   * ⚠️ 而且它是**捲回能成立的前提**：使用者泡泡一 push 進去就會把畫面拉回底部，
   *    剛好抵銷掉那次捲回。
   * ⛔ 別拿它藏真正的回答（例：「有」「還沒」）——那些是使用者說過的話，記錄要留。
   */
  silent?: boolean
}

export interface AgentPickerOption {
  id: string
  label: string
  sub?: string
  pictureUrl?: string
}

/** 目前輪到使用者做什麼（畫在輸入區）。idle = 沒有要問的（等待/處理中） */
export type AgentAsk =
  | { kind: 'idle'; hint?: string }
  | { kind: 'choices'; options: AgentChoice[] }
  | {
    kind: 'input'
    inputType: 'text' | 'secret' | 'url'
    placeholder?: string
    maxLength?: number
    /** 顯示跳過鈕 */
    skippable?: boolean
    /**
     * 跳過鈕的字樣（預設「先跳過"）。輸入格是死路的時候用它開後門——
     * 例：貼鑰匙的輸入格給「等等，我想看教學」，否則一開始選了「直接貼上」的人
     * 對話裡沒有教學、也沒有任何按鈕能叫出來（2026-08-19 老闆實測抓到的死路）。
     */
    skipLabel?: string
  }
  /** 引導式選人（例：轉真人通知對象，2026-08-07 拍板用選的、不自動綁） */
  | { kind: 'picker'; options: AgentPickerOption[]; skippable?: boolean }

/** 插進 html 前先跳脫使用者輸入（renderer 用 v-html） */
export function escapeHtml(s: string): string {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;')
}
