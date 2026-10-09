/**
 * 教學小幫手的「教學內容」——純資料，沒有狀態機。
 *
 * 引擎（導航、開關 tour、對位）在 composables/useTutorial.ts；這裡只放要教什麼。
 * 分開的理由：內容會隨產品功能一直長，引擎幾乎不動；混在一起會讓引擎被埋在上千行文案裡。
 *
 * 寫作規則：
 * - 標題只寫「這步在做什麼」，**不要寫「第 N 步」或 ①②③**。步數由畫面自動標，
 *   手寫編號在功能旗標關掉某一步時會跳號，也一定會跟實際步數漂移。
 * - blurb 同理不要寫「共 N 步」，畫面會自己算。
 * - 文案一律白話、講後果，把使用者當第一次看到這個詞的人。
 */

import type { Component } from 'vue'
import type { Capability } from '~~/shared/permissions'
import {
  Bell, Box, ChatDotRound, ChatLineSquare, Connection, DataLine, Document, EditPen, Files,
  FolderOpened, Grid, Lightning, MagicStick, Monitor, OfficeBuilding, Operation, PieChart,
  Pointer, Postcard, PriceTag, Promotion, Reading, Tickets, TrendCharts, User, UserFilled,
} from '@element-plus/icons-vue'

export interface TutorialStep {
  /** CSS selector，對準頁面上標了 data-tour 的元素；留空字串＝置中說明卡（不高亮） */
  target: string
  /** 顯示這步之前，先點一下這個 selector 的元素（例如先進入新增模式，編輯區才會出現） */
  clickBefore?: string
  /**
   * 有這個東西在畫面上就**不要**點 `clickBefore`（2026-08-28 code review 抓到）。
   *
   * 為什麼需要：對話頁那幾步靠 `clickBefore` 幫使用者點開第一筆，但客服很可能**正在讀某一場**——
   * 無條件點下去等於把他手上的對話切掉，而且按導覽的「上一步」回到這步又會再切一次。
   * 填「右半邊已經開著」的錨點，就變成「沒開才幫你開」。
   */
  clickBeforeUnless?: string
  /**
   * 這一步的**前提**必須先在畫面上，否則整步跳過（2026-08-28 code review 抓到）。
   *
   * 跟 `target` 的差別：`target` 常常是「點開之後才會出現」的東西（右半邊、編輯區），
   * 開場當下本來就查不到；這一欄要填的是「有沒有東西可以點開」那個前提。
   * 例：剛開通、還沒收到過任何客人訊息的帳號一場對話都沒有，對話頁右半邊那幾步
   * 會連續跳五次「這一步要指的位置目前不在畫面上」、每次乾等兩秒——而最可能開這支
   * 導覽的正是這種新帳號。
   */
  requiresPresent?: string
  /**
   * 主目標查不到時退去指這個（2026-08-28 code review 修）。
   *
   * 有些錨點的渲染條件比「這一頁打得開」細一層，開場時算不出來：
   * 例如對話頁那排「我接手／交還／結束」只在**這場有進行中的會話**時才渲染——
   * 客服點開的第一則剛好是已結束的對話，那一步就會顯示「位置不在畫面上」。
   * 填一個「同一塊、一定在」的上層錨點，就退而指它，說明照樣講得通。
   *
   * ⛔ 不是拿來當「隨便找個東西指」的萬用退路：填進來的必須是**同一件事的上層容器**，
   *    指到不相干的地方比誠實說「不在畫面上」更糟。
   */
  targetFallback?: string
  /**
   * 主目標**比它所在的捲動區還高**時退去指這個（2026-08-28 code review 修）。
   *
   * 側欄那三段各有 6～10 列（「每天在用的」約 410px），而筆電短螢幕扣掉 logo 與帳號
   * 切換之後，側欄看得到的地方只剩 350～460px。el-tour 是照元素的完整外框挖洞的，
   * 挖出來會超出可視範圍、上下還有列藏在捲動區外——使用者看到一個框住空白的洞。
   * 「捲到中間」那套機制救不了這種情況（它只處理比容器小的目標）。
   */
  targetTooTallFallback?: string
  /**
   * 這一步**順手標亮**的幾個元素（逗號分隔的 selector，`C-250`②）。
   *
   * 為什麼要有：el-tour 一步只挖得出一個洞。打造完落地導覽第 1 步要講「你剛剛做的都在這幾頁」，
   * 那幾頁散在側欄三段（自動回應／標籤管理／AI 設定）——框整個側欄、再把那幾列標亮，
   * 他才看得出是**哪幾列**。⚠️ 標的東西要在 `target` 裡面，不然會被遮罩蓋掉。
   * 換步、關掉、完成時一律收掉。
   */
  mark?: string
  /** 在機器人模組頁示範這種訊息卡（會在示範草稿裡放一張該類型的卡，下一步自動換掉） */
  demoType?: string
  /** 只寫「這步在做什麼」，不要加「第 N 步」——步數由畫面自動標 */
  title: string
  /** 支援簡單 HTML（會以 v-html 呈現） */
  description: string
  placement?:
    | 'top' | 'top-start' | 'top-end'
    | 'bottom' | 'bottom-start' | 'bottom-end'
    | 'left' | 'left-start' | 'left-end'
    | 'right' | 'right-start' | 'right-end'
  /** 該步驟內附「帶我做這項」按鈕時，要啟動的教學主題 id（給缺項巡覽用） */
  actionTopicId?: string
  /**
   * 同一顆「帶我做這項」改開對話劇本（`utils/agent-guides` 的 id）。
   * 有這個就優先於 `actionTopicId`——同一件事不該因為從哪個入口進來就給不同的教法
   * （D-40：知識庫那項從清單點是劇本、從缺項巡覽點卻是導覽，那就是兩套）。
   */
  actionGuideId?: string
  /** 此步驟依賴的功能旗標（關閉時整步跳過），對應 useFlowFeatures 的開關 */
  requiresFeature?: string
  /**
   * 這一步要指的東西只有「有這項能力的人」畫面上才有——沒有的人根本沒有那顆按鈕，
   * 不跳過的話他會看到一句「這一步要指的位置目前不在畫面上」。
   *
   * `G-109`：填那顆按鈕在頁面上 `v-if="can('…')"` 用的**同一項**能力（＝它打的端點用的），
   * 錨點出現的條件跟這一步出現的條件才會是同一件事。⛔ 不要照「客服以上／管理員以上」去猜。
   */
  requires?: Capability
}

export interface TutorialTopic {
  id: string
  icon: Component
  label: string
  /** 一句話說明「點下去會教什麼」，顯示在教學清單上。不要寫步數，畫面會自己算 */
  blurb: string
  /** 歸到哪一組（對應 CATEGORY_META）。放在主題自己身上，不另開對照表——漏填會被型別擋下 */
  category: TutorialCategoryId
  /** 導覽開跑前要導航到的路由（吃 workspaceId） */
  route?: (workspaceId: string) => string
  /**
   * 有這項能力才顯示整支教學（`G-109`）：填這支教學要人去按的那顆主按鈕用的能力
   * （例：「建立好友標籤」＝標籤頁「新增」鈕的 `tags.write`）。不填＝誰進得了那一頁都看得到。
   * 教學的權限一律跟著**頁面實際的權限**走，不要各訂一套（`D-82`）。
   */
  requires?: Capability
  /** 依賴的功能旗標（關閉時整個教學隱藏），對應 useFlowFeatures 的開關 */
  requiresFeature?: string
  steps: TutorialStep[]
}

export type TutorialCategoryId = 'intro' | 'setup' | 'ai' | 'daily' | 'bot' | 'growth'

/**
 * 「認識後台」總覽導覽的 id。開通引導結尾的「帶你認識後台」用 `?tour=` 帶這個值進後台
 * （見 useOnboardingChat 的 stepDone），所以兩邊吃同一個常數、不要各寫一次字串。
 */
// ⛔ 這裡刻意**只 import 不 re-export**（2026-08-28 code review 修）：
// 常數本體住在 utils/tutorial-ids.ts（沒有任何相依的小檔），開通頁自動匯入吃的是那一支，
// 所以不會為了一個字串把這一千行內容與二十幾個圖示元件拉進它的 chunk。
// 這裡再 export 一次就會變成兩個同名的自動匯入來源——Nuxt 會挑一個、另一個靜靜被忽略，
// 而被挑中的若是這一支，上面那個 bundle 問題等於沒修。
import { OVERVIEW_TOPIC_ID } from './tutorial-ids'

export interface TutorialCategoryGroup {
  id: TutorialCategoryId
  label: string
  topics: TutorialTopic[]
}

/** 分類顯示順序與名稱 */
export const CATEGORY_META: { id: TutorialCategoryId, label: string }[] = [
  { id: 'intro', label: '認識後台' },
  { id: 'setup', label: '開始設定' },
  { id: 'ai', label: 'AI 客服' },
  { id: 'daily', label: '日常客服' },
  { id: 'bot', label: '機器人模組' },
  { id: 'growth', label: '經營工具' },
]

/**
 * 匯入視窗**裡面**那幾步（單一事實來源）。
 *
 * 兩個地方吃同一份：①「知識庫：建立與匯入」導覽（前面多一步「點加入知識」把視窗開起來）
 * ②視窗標題旁那顆問號（視窗已經開著，用 `startAdHocTour` 直接跑這幾步）。
 * ⛔ 不可以在視窗那邊另抄一份：教材只有一份，抄兩份下次只會改到一邊
 *    （`D-40` 明列「劇本不重講視窗內已有的說明＝教材只一份」的同一個道理）。
 * ⛔ 問號那條路要記得把 `clickBefore` 拿掉：視窗已經開了，而那顆「加入知識」按鈕在遮罩後面。
 */
export const KB_IMPORT_DIALOG_STEPS: TutorialStep[] = [
      {
        target: '[data-tour="kb-drop"]',
        clickBefore: '[data-tour="kb-import"]',
        title: '丟進來就好，不用先選種類',
        description:
          '把檔案拖進框裡，或貼上<strong>網址、試算表連結、一段文字</strong>——系統會自己認出是什麼。<strong>不知道該丟什麼的話，框下面把五種做法都列出來了</strong>；貼上之後視窗也會就地講該注意什麼。',
        placement: 'bottom',
      },
      {
        // 起步選項只在投放框還空的時候才在畫面上（見 KnowledgeImportDialog 的 kb-start）：
        // 使用者若有貼到一半的內容，這一步整步跳過而不是指著空氣
        target: '[data-tour="kb-start"]',
        requiresPresent: '[data-tour="kb-start"]',
        clickBefore: '[data-tour="kb-import"]',
        title: '五種做法都在這裡',
        // ⚠️ 2026-09-13 換口徑：原本寫「差別是準備時間」，但視窗那邊的順序已改成
        //    試算表優先（理由見 KnowledgeImportDialog 的三版說明），準備時間正好是它最吃虧的維度。
        //    教材跟畫面講反了比沒教還糟，所以這裡也改成先講「改了會不會自動更新」。
        // ⚠️ 同日四版再改：選項從三顆變五顆，且定位從「挑一條」改成「把能怎麼做都列出來」。
        //    ⛔ 這裡別再寫死顆數以外的細節（哪一條排第幾），順序之後可能再調，
        //       寫死了就是下一個 `C-180`（文案裡埋一份沒人維護的畫面副本）。
        description:
          '這裡把<strong>能怎麼做都列出來了</strong>，點一下就會展開那一條要做什麼。小字一律回答同一個問題：'
          + '<strong>之後資料改了會怎樣</strong>——只有 Google 試算表會自己跟著更新，其餘都要回來動手。'
          + '要花多少時間、有什麼限制，寫在各自展開後的第一行。',
        placement: 'top',
      },
      {
        target: '[data-tour="kb-preview"]',
        title: '先看 AI 整理的結果再匯入',
        description:
          '按這裡，AI 會先<strong>切好知識給你預覽</strong>：可以逐條改、取消不要的，確認才匯入——<strong>不會直接上線亂答</strong>。',
        placement: 'top',
      },
]

/** 目前提供的教學主題。要新增教學，往這個陣列加一筆即可（記得填 category）。 */
export const TUTORIAL_TOPICS: TutorialTopic[] = [
  /**
   * 認識後台（2026-08-28）：整個後台的地圖，**不教任何操作**。
   *
   * 為什麼要有這一支：接完 LINE 之後畫面上有 17 個入口、右下角一顆圓鈕，
   * 而 22 支現成導覽全是「單頁怎麼用」，沒有一支回答「東西都放在哪」。
   * 一支同時解掉三件事：不認識後台、找不到頁首那顆「？」、不知道教學可以重看。
   *
   * ⛔ 不自動跑（2026-08-26 拍板）：入口在開通引導結尾與教學清單，點了才跑。
   */
  {
    id: OVERVIEW_TOPIC_ID,
    category: 'intro',
    icon: Pointer,
    label: '帶你認識後台',
    blurb: '東西都放在哪、有問題找誰——不教操作，先給地圖。',
    route: wid => `/admin/${wid}/conversations`,
    steps: [
      {
        target: '[data-tour="nav-group-daily"]',
        // 短螢幕上整段比側欄看得到的範圍還高：太高就退去指這一段的小標
        // （2026-09-04 起這一段也有小標了，跟其他三段同一種退法）
        targetTooTallFallback: '.nav-group[data-tour="nav-group-daily"] .nav-section-label',
        title: '每天的工作都在這一段',
        // ⛔ 這一段的那一頁叫「自動回應」：側欄上沒有「自動回覆」四個字（2026-08-09 已下架併進前者）
        description:
          '客人傳來的訊息在<strong>客服對話</strong>；客人在 LINE 看到的選單、'
          + '以及<strong>自動回應</strong>，也都在這一段設定。',
        placement: 'right',
      },
      {
        // 好友經營段（G-44，2026-09-04）：⛔ 這一步的順序不可以跟上一步互換——
        // 講的是「先有名單、才談得上分群與發訊息」，倒過來說故事線就斷了。
        target: '[data-tour="nav-group-crm"]',
        targetTooTallFallback: '.nav-group[data-tour="nav-group-crm"] .nav-section-label',
        title: '客人是誰、怎麼分群發訊息',
        description:
          '<strong>好友</strong>是加過你官方帳號的人。用<strong>標籤管理</strong>把他們分群'
          + '（例如「問過出貨」、「買過東西」），再用<strong>推播</strong>只發給其中一群人。',
        placement: 'right',
      },
      {
        target: '[data-tour="nav-group-ai"]',
        // 短螢幕上整段比側欄看得到的範圍還高（遮罩挖的洞會超出可視區）：
        // 太高就退去指這一段的小標，說明講的還是整段
        targetTooTallFallback: '.nav-group[data-tour="nav-group-ai"] .nav-section-label',
        title: '教 AI 回答客人的一切',
        description:
          '先把商品、規則這些資料放進<strong>知識庫</strong>，AI 才有東西可以答；'
          + '在<strong>測試對話</strong>可以先問問看它會怎麼回，<strong>那裡的回答不會送給客人</strong>。',
        placement: 'right',
      },
      {
        target: '[data-tour="nav-group-settings"]',
        // 短螢幕上整段比側欄看得到的範圍還高（遮罩挖的洞會超出可視區）：
        // 太高就退去指這一段的小標，說明講的還是整段
        targetTooTallFallback: '.nav-group[data-tour="nav-group-settings"] .nav-section-label',
        title: '一次性的設定',
        description:
          '邀請同事、LINE 的連線狀態、方案與付款都在這裡。設定好之後，平常不太需要進來。',
        placement: 'right',
        // `G-109`：這一段客服其實也看得到（只剩「LINE 通知」一列，`notify.self`），但這句講的
        // 邀請同事、LINE 連線、方案付款全是管理員的事——照說明講的東西挑，「組織與 LINE」那一列的 `line.manage`
        requires: 'line.manage',
      },
      {
        target: '[data-tour="ta-fab"]',
        title: '有問題，先看右下角的小幫手',
        description:
          // `D-114`（2026-10-05）：小幫手的「教學」分頁拿掉了，全部教學改從頁首問號進（下一步講）
          '哪裡壞了、下一步要做什麼，它會<strong>主動說</strong>。點開就能直接問它，也能叫它幫你改設定。',
        placement: 'left',
      },
      {
        target: '[data-tour="page-help"]',
        // ⛔別寫「右上」（2026-08-28 code review 抓到）：那顆問號一直都在**頁面標題旁邊**
        // （側欄式頁面在左上的清單標題後、solo 頁在大標題後），包括這一步正在指的那一顆。
        // ⛔ 不是「每一頁」：訂閱與付款那頁沒有掛（全站唯一）。講絕對值就會有人去驗，
        // 驗到一次不對，後面講什麼都要打折（2026-09-02 改）
        title: '幾乎每一頁標題旁都有「這頁怎麼用」',
        description:
          '點了就在<strong>真實畫面</strong>上一步步帶你操作。這支導覽也一樣——'
          + '之後想再看，按這顆問號就找得到，最下面還有「看全部教學」。',
        placement: 'bottom',
      },
      {
        // 2026-09-02 老闆拍板：開通結尾那排拿掉「去看剛剛那則對話」，改成**第一次一定
        // 要看導覽**、由導覽自己把人送到終點。所以這一步是新的最後一步。
        // 為什麼值得加：以前這支收在上面那句「每一頁都有問號」＝一個關於介面的註腳，
        // 而客人剛剛親手讓機器人收到人生第一則訊息——那才是整段旅程的高點，導覽卻沒回到它。
        target: '[data-tour="conv-messages"]',
        // 右半邊在「沒選對話」時整棵 DOM 都不存在，先幫他點開第一筆（同下面 CONV 那幾步）
        clickBefore: '.conv-list-row .split-list-item',
        clickBeforeUnless: '[data-tour="conv-messages"]',
        // ⛔ 一場對話都沒有就整步跳過——跳過傳話測試的人沒有那則訊息可指，
        //    不擋的話會指著空氣。⚠️ 這條要有效，`startTopic` 的前提判斷必須在導航**之後**
        //    才問（2026-09-02 一起修的，原本問的是上一頁的 DOM＝這一步 100% 被靜默刷掉）。
        requiresPresent: '.conv-list-row .split-list-item',
        title: '最後，你剛剛傳的那句話就在這裡',
        description:
          '客人傳的每一句話都會這樣進來，<strong>你直接在這裡回</strong>就送到他的 LINE。'
          + '接下來就交給右下角的小幫手——哪裡怪怪的、下一步做什麼，它會主動說。',
        placement: 'left',
      },
    ],
  },
  {
    id: 'organization',
    category: 'setup',
    icon: OfficeBuilding,
    label: '設定組織與 LINE',
    blurb: '把 LINE 官方帳號接上系統。過程中可以隨時點「結束」離開。',
    // 這一頁的進入門檻（`workspace-settings` 中介層）與儲存都是 `line.manage`
    requires: 'line.manage',
    route: wid => `/admin/${wid}/settings/organization`,
    steps: [
      {
        target: '[data-tour="nav-organization"]',
        title: '這裡是入口',
        description:
          '左側選單的 <strong>設定 → 組織與 LINE</strong> 就是這頁。之後要改 LINE 憑證、Webhook，都從這裡進來。',
        placement: 'right',
      },
      {
        target: '[data-tour="org-identity"]',
        title: '先確認身分',
        description:
          '這一條顯示你的<strong>組織名稱、官方帳號名稱</strong>，以及<strong>你的角色</strong>。只有「擁有者／管理員」能改這頁設定。',
        placement: 'bottom',
      },
      {
        target: '[data-tour="org-liff"]',
        // ⛔ 別只寫「選填」（`G-83`，欄位上已經改過；`D-109` 抓到導覽還是舊字）：
        //    準備辦活動的人看到「選填」就會跳過，活動頁就開不起來
        title: '填預設 LIFF（要辦活動就必填）',
        description:
          '先到 <strong>LINE Developers</strong> 建一個 LIFF App，把它的 LIFF ID 貼進來（例：2007123456-AbCdEfGh）。LIFF 的 Endpoint URL 要設成下方「活動 LIFF 頁」，<strong>不要</strong>填 Webhook 路徑。',
        placement: 'top',
      },
      {
        target: '[data-tour="org-token"]',
        title: '貼 Channel Access Token',
        description:
          '到 <strong>LINE Developers → Messaging API</strong> 複製 Channel Access Token，貼進這欄。存過之後會以黑點隱藏，點黑點可重新輸入。',
        placement: 'top',
      },
      {
        target: '[data-tour="org-secret"]',
        title: '貼 Channel Secret',
        description:
          '同一個 channel 的 <strong>Channel Secret</strong> 貼這裡。<strong>一定要跟 LINE 後台同一組</strong>，填錯的話 LINE 會拒絕連線、機器人就收不到客人訊息。',
        placement: 'top',
      },
      {
        target: '[data-tour="org-webhook"]',
        title: '把 Webhook 網址貼回 LINE',
        description:
          '點「複製」拿到這串網址，貼到 <strong>LINE Developers → Messaging API → Webhook URL</strong>，並把 Webhook 設為啟用。',
        placement: 'top',
      },
      {
        // 2026-09-29（`D-109`）：先講「關掉 LINE 內建自動回應」——系統偵測不到它，沒關的話
        // 客人每句話都收到兩套回覆（LINE 的罐頭＋我們的），而第一次接的人十個有九個不知道要關
        target: '[data-tour="org-oam-autoreply"]',
        title: '順手把 LINE 內建的自動回應關掉',
        description:
          'LINE 官方帳號後台有一個<strong>自己的自動回應</strong>，沒關的話客人每句話會收到<strong>兩套回覆</strong>'
          + '（LINE 的罐頭訊息＋我們的）。這個開關在 LINE 那邊、系統偵測不到——按旁邊的「<strong>教我怎麼關</strong>」照著做。',
        placement: 'top',
      },
      // ⛔ 2026-09-29（`D-109`）：順序原本是「測試 → 儲存」——但沒存檔時「測試連線」是**鎖住的**
      //    （測的是已儲存的內容），第一次設定照導覽的順序做，走到測試那步就卡住。
      {
        target: '[data-tour="org-save"]',
        title: '先儲存',
        description:
          '都填好先按右上角「<strong>儲存</strong>」，系統會順手驗一次 Webhook。',
        placement: 'bottom-end',
      },
      {
        target: '[data-tour="org-verify"]',
        title: '再測試有沒有通',
        description:
          '存好之後按「<strong>測試連線</strong>」：LINE 會真的送一則測試訊息，確認網站收得到、驗簽過。'
          + '（測的是<strong>已儲存</strong>的內容，還沒存之前這顆會鎖住。）測試有額度，別狂按。看到成功就完成囉',
        placement: 'top',
      },
    ],
  },
  {
    id: 'ai-settings',
    category: 'ai',
    // 儲存鈕與整張表單都是 `canEditSettings`＝`ai.settings.write`
    requires: 'ai.settings.write',
    icon: MagicStick,
    label: '開啟 AI 自動回覆',
    blurb: '把 AI 客服打開、選好回覆模式與語氣。',
    route: wid => `/admin/${wid}/ai-settings`,
    steps: [
      {
        target: '[data-tour="ais-toggle"]',
        title: '打開總開關',
        description:
          // ⛔ 2026-09-29（`D-109`）：原本寫「關著的話，知識庫和客服流程都不會生效」——後半句是錯的，
          //    自動回應不看這個開關（`handler.ts` 的 `runScriptStart` 不讀 enabled），關掉 AI 照樣在回客人。
          '先把「<strong>啟用 AI 自動回覆</strong>」打開——關著的話 AI 一句都不會回，知識庫也就用不上。'
          + '（<strong>自動回應不受這個開關影響</strong>，照常運作。）下面的「回覆模式」<strong>新導入建議先選「草稿」</strong>跑一兩週：AI 只給客服建議、不直接回客人，穩了再切「全自動」。',
        placement: 'right',
      },
      {
        // ⛔ 2026-09-29（`D-109`）：這一步原本叫「調回答風格」、講「語氣與人設」，
        //    但 `ais-style` 框的是「多有把握才開口」三檔——語氣是下一張卡，下一步自己講。
        target: '[data-tour="ais-style"]',
        title: 'AI 多有把握才開口',
        description:
          '三檔選一：<strong>嚴格</strong>＝寧可轉真人也不答錯；<strong>寬鬆</strong>＝多答少轉；'
          + '<strong>平衡</strong>介於中間。知識庫剛起步先用嚴格或平衡，看「AI 表現」頁穩了再放寬。',
        placement: 'right',
      },
      {
        target: '[data-tour="ais-tone"]',
        title: 'AI 講話的口吻與禁則',
        description:
          '這一段是<strong>給 AI 的指示</strong>：講話口吻、不能說什麼、特殊狀況怎麼處理。'
          + '不知道怎麼寫就先按上面的<strong>範本</strong>（親切活潑／專業簡潔／溫暖體貼）再改。'
          + '⚠️ 套範本會<strong>整段換掉</strong>你原本寫的。',
        placement: 'right',
      },
      // （原本這裡有一步「設定轉真人通知」，2026-09-27 `C-270` 那一區搬到「設定 → LINE 通知」，
      //   那一頁有自己的導覽 `line-notify`；這裡只剩一行指路，⛔ 不再花一步講它）
      // ── 2026-09-18 `D-82` 第二批：這一頁 14 個區塊只教了 3 個，補兩塊
      //    **會直接改變客人收到什麼**的（其餘的頁面上各自有說明，不逐塊教）。
      {
        target: '[data-tour="ais-hours"]',
        title: '下班時間不要吵客服',
        description:
          '設了服務時間之後，<strong>非服務時間內不會推播通知客服</strong>（半夜不會被叫醒）。'
          + '⚠️ 轉真人本身<strong>照常發生</strong>——客人還是會被接住、隔天上班在「對話」頁就看得到，'
          + '只是當下不吵人。還可以設一句勿擾時段要回客人的話，例如「我們明天 9 點回覆您」。',
        placement: 'right',
      },
      {
        // 這一塊住在預設收合的「進階調校」裡：先幫他展開，否則整步變成「位置不在畫面上」。
        // ⛔ 已經展開就不可以再點一次 toggle——那會把它收起來。
        target: '[data-tour="ais-handback"]',
        clickBefore: '[data-tour="ais-advanced"]',
        clickBeforeUnless: '[data-tour="ais-handback"]',
        title: '客服忘記交還時，機器人自己接回去',
        description:
          '我幫你展開了「<strong>進階調校</strong>」（更細的設定都收在這裡）。'
          + '這一塊最值得看：客服按了「我接手」之後<strong>忘記交還</strong>的話，'
          + '這位客人就再也不會被 AI 回答——設定<strong>閒置幾分鐘自動交還機器人</strong>可以避免。'
          + '下面還能設「太久沒動靜時自動結束對話」。',
        placement: 'right',
      },
      {
        target: '[data-tour="ais-save"]',
        title: '儲存設定',
        description: '改完一定要按右上「<strong>儲存設定</strong>」才會生效',
        placement: 'bottom-end',
      },
    ],
  },
  {
    id: 'knowledge',
    category: 'ai',
    // 第一步指的「加入知識」是 `canEditKb`＝`knowledge.write` 才畫
    requires: 'knowledge.write',
    icon: Reading,
    label: '知識庫：建立與匯入',
    blurb: '把資料交給 AI 整理，三步就好。',
    route: wid => `/admin/${wid}/knowledge/sources`,
    steps: [
      {
        target: '[data-tour="kb-import"]',
        title: '從「加入知識」開始',
        description:
          'AI 只會用你放進來的資料回答客人。點「<strong>加入知識</strong>」放第一份進去。',
        placement: 'bottom',
      },
      ...KB_IMPORT_DIALOG_STEPS,
    ],
  },
  {
    id: 'knowledge-manage',
    category: 'ai',
    // 教的是改知識、採用等你看過的卡（`knowledge.write`）；「⋯」選單與同步設定的
    // `folders.write`／`sources.write` 目前同一級，各步不另標
    requires: 'knowledge.write',
    icon: FolderOpened,
    label: '知識庫：整理與更新',
    blurb: '匯入之後，怎麼分類、微調、讓知識自動保持最新。',
    route: wid => `/admin/${wid}/knowledge/sources`,
    steps: [
      {
        target: '[data-tour="kb-sources"]',
        title: '匯入的知識都在這裡管理',
        description:
          '你匯入的每一份資料，都會變成一筆「<strong>資料</strong>」列在這份清單。<strong>點一份</strong>進去，右邊就能看它的內容、改東西、或設定更新。這一頁就是你日後照顧知識庫的地方。',
        placement: 'right',
      },
      // ── 右邊工作台那三塊（2026-09-29 `D-109`）──────────────────────────
      // ⛔ 一定要排在「幫你選第一份資料」那一步**之前**：工作台只在沒選任何資料時才在畫面上，
      //    以前「體檢」那步排在選資料之後、又指著「列表上方的橫幅」，走到那一步畫面上根本沒有它。
      //    三塊都是「有東西才出現」，用 requiresPresent 擋（這支前面沒有 clickBefore，前提在導航後問得到）。
      {
        target: '[data-tour="kb-drafts"]',
        requiresPresent: '[data-tour="kb-drafts"]',
        title: '等你看過的卡',
        description:
          '開帳讀你網站整理出來的卡、或請小幫手補的卡，<strong>先放在這裡</strong>：客人還收不到，'
          + '你一張張看過、按「<strong>採用</strong>」才會拿來回答（採用時才算知識卡額度）。不要的直接刪掉。',
        placement: 'left',
      },
      {
        target: '[data-tour="kb-health"]',
        requiresPresent: '[data-tour="kb-health"]',
        title: '知識庫體檢會幫你盯',
        description:
          '同步失敗的資料、被標記「AI 答錯了」的知識會列在<strong>「要處理的事」</strong>，點分類就直接列出那幾筆，照著修完就好——'
          + '不用自己一張張翻。下面灰色那幾行（內容較短、到期自動停用）<strong>是提醒不是待辦</strong>，想看再看。',
        placement: 'left',
      },
      {
        target: '[data-tour="kb-suggest"]',
        requiresPresent: '[data-tour="kb-suggest"]',
        title: '客人問倒 AI 的題目，系統會擬好卡給你',
        description:
          '客人問了但 AI 答不出來、或被標「答錯了」的，同一類累積到兩次，系統就會在這裡<strong>擬好一張卡</strong>。'
          + '看一眼覺得對就採用，缺的資訊會標成「請填寫」要你補——<strong>這是把 AI 養好最省力的地方</strong>。',
        placement: 'left',
      },
      {
        target: '[data-tour="kb-more"]',
        title: '資料變多了，用資料夾分類',
        // ⛔ 2026-09-29（`D-109`）：原本寫「點上方新資料夾按鈕」並指著選單裡那一項——那一項收在「⋯」裡，
        //    選單沒打開時聚光燈框在一塊看不見的地方
        description:
          '資料一多就會找不到。點這顆「<strong>⋯</strong>」→「<strong>新增資料夾</strong>」（例如：商品、退換貨、活動），'
          + '再把資料<strong>拖進去</strong>歸類。這只是後台整理方便你找，不影響 AI 回答。'
          + '（手動新增一張知識、回收桶也都在這個選單裡。）',
        placement: 'bottom',
      },
      {
        target: '[data-tour="kb-chunks"]',
        clickBefore: '[data-tour="kb-source-row"]',
        title: 'AI 把資料切成一條條「知識」，你能微調',
        description:
          '我幫你選了第一份資料。每份會被拆成一條條知識，AI 就是一條一條找答案。覺得哪一條不對，按「<strong>編輯</strong>」改它——<strong>你親手改過的不會被日後的自動更新蓋掉</strong>。（每條還能設停用與有效期限，檔期活動用得到。）',
        placement: 'left',
      },
      {
        target: '[data-tour="kb-sync-settings"]',
        title: '原始資料改了，知識會自動跟上',
        description:
          // ⛔ 2026-09-29（`D-109`）：原本寫「小改動自動套用並通知你」——頁面上寫的是「不另外通知你」，
          //    等通知的人等不到。試算表那顆按鈕叫「立即同步」不是「重新同步」。
          '網址與 Google 試算表來的資料，系統會<strong>定期自動重讀</strong>：小改動自動套用'
          + '（不另外通知你，「最後同步」時間會跟著更新），改動大會先列出差異讓你確認。<strong>你親手改過的一律保留</strong>。'
          + '等不及就按右上「<strong>重新同步</strong>」（試算表叫「立即同步」）。（檔案和手打的不會自動更新，改了要重新匯入。）',
        placement: 'left',
      },
    ],
  },
  {
    id: 'ai-scripts',
    category: 'ai',
    // ⛔ 跟著頁面的 `scripts.write`，不是管理員（2026-09-18 `D-82`）：這一頁的編輯權限＝
    // **客服就能改**，教學卻曾經鎖在管理員——客服進這一頁時，頁首那顆問號整顆不畫、自動導覽也不跑，
    // 變成「能改的人看不到教學」。教學的權限一律跟著**頁面實際的權限**走，不要各訂一套。
    // 三步指的（新增、AI 生成、範本）都在 `canEditScripts`＝`can('scripts.write')` 底下。
    requires: 'scripts.write',
    icon: Operation,
    // ⛔ 名字要跟側欄同一個詞（2026-09-18 `D-82`）：這一頁側欄上叫「自動回應」，
    // 教學卻叫「建立客服流程」——在教學清單裡用側欄看到的那四個字根本找不到這一支。
    // 冒號後面才講教什麼（同「知識庫：建立與匯入」的寫法）。
    label: '自動回應：建立第一條',
    blurb: '客人說什麼、系統就自動回什麼。帶你從頭設一條，包含最容易做錯的那一格。',
    route: wid => `/admin/${wid}/ai-scripts`,
    steps: [
      {
        target: '[data-tour="scr-new"]',
        title: '新增一條自動回應',
        description:
          '客人說了某句話，系統就自動回一段——<strong>一句話回一件事</strong>（例：問營業時間）'
          + '或<strong>多步驟的接待</strong>（例：預約、報名、領優惠）都在這裡設。點「<strong>新增</strong>」開一條。',
        placement: 'right',
      },
      {
        target: '[data-tour="scr-ai-gen"]',
        title: '用一句話讓 AI 幫你搭',
        description:
          '不想從空白開始？在這裡<strong>用一句話描述流程</strong>（例：客人要退貨時，先問訂單編號和原因，再請專員處理），AI 就會幫你搭好整條流程草稿。<strong>生成後會先進編輯器讓你檢查</strong>，按「建立自動回應」才會存檔。',
        placement: 'top',
      },
      {
        target: '[data-tour="scr-templates"]',
        title: '從範本開始也行',
        description:
          // ⛔ 2026-09-29（`D-109`）：原本寫「建立後記得把狀態切成啟用才會生效」——反了：
          //    範本、AI 生成、空白新增**一建就是啟用**（只有「複製一份」是停用），照原本那句理解的人
          //    會以為還沒上線，其實客人已經收得到。
          '也可以挑一個<strong>範本</strong>，系統幫你把流程骨架建好再改。'
          + '⚠️ 範本建出來<strong>就是啟用的</strong>，存檔之後客人就會收到；還沒改好就先把狀態切成「停用」再存。',
        placement: 'top',
      },
      {
        // 2026-09-29（`D-109`）：清單最上面釘著的那一列以前沒人講，而它的後果最直接——
        // `D-23` 查到 90 天內約 667 位加好友的人一句話都沒收到。另外 LINE 後台自己的加好友歡迎
        // 要另外關，不然客人會收兩份（設定視窗裡有講，但導覽沒帶到那裡）。
        // ⛔ 不設 requiresPresent、也不排第 2 步：那一列要等清單載完才畫，實走時清單載了 3 秒以上，
        //    排太前面就指不到（引擎只等目標 2 秒）。排在這裡＝前面三步讀完清單早就在了，
        //    而且那一列現在永遠都在（空清單也在）。⛔ 要排在下一步「幫你按新增」之前。
        target: '[data-tour="scr-follow-row"]',
        title: '最上面這一列：客人加好友時',
        description:
          '另外，清單最上面這一列是客人<strong>一加好友</strong>就會收到的那一段（不用他打任何字）。還沒設的話，新朋友加進來<strong>一句話都收不到</strong>。'
          + '⚠️ 設好之後，記得到 LINE 官方帳號後台把<strong>它內建的加好友歡迎</strong>關掉，不然客人會收到兩份。',
        placement: 'right',
      },
      // ── 以下是編輯器裡面（2026-09-18 `D-82` 拍板：導覽不可以停在門口）───────────
      // ⛔ 這幾步**不可以**用 `requiresPresent` 擋：前提是在導航之後、`clickBefore` 之前
      //    問的，那時編輯器還沒開，填了等於每次都被靜默刷掉（同 `startTopic` 裡那段註解）。
      //    渲染條件細一層的那幾格改用 `targetFallback`。
      {
        target: '[data-tour="scr-trigger-mode"]',
        // 手上已經開著一條在編輯就不要按「新增」把它切掉——那顆按鈕還會跳出「未儲存」確認框
        clickBefore: '[data-tour="scr-new"]',
        clickBeforeUnless: '[data-tour="scr-trigger-mode"]',
        title: '先決定「什麼時候會啟動」',
        description:
          '三選一：<strong>關鍵字</strong>＝客人打的字裡有你設的詞才算；'
          + '<strong>看意思</strong>＝客人換句話說也算（你填幾句範例，AI 判斷像不像）；'
          + '<strong>客人加好友時</strong>＝一加好友就跑，不用他打任何字。',
        placement: 'right',
      },
      {
        target: '[data-tour="scr-match"]',
        // 「怎麼比對」只有在「關鍵字」那一邊才渲染；選了「看意思」就退去指上面那排選擇
        targetFallback: '[data-tour="scr-trigger-mode"]',
        title: '最容易做錯的就是這一格',
        description:
          '選了關鍵字的話，這裡決定<strong>怎麼算命中</strong>。'
          // ⛔ 選項的字要照下拉選單寫（「客人輸入任何內容」），`D-109` 抓到原本寫成警告框的標題
          + '⛔ 其中「<strong>客人輸入任何內容</strong>」要特別小心：選了之後客人不管打什麼都會走這一條，'
          + '<strong>AI 客服和其他自動回應全部收不到訊息</strong>，而且畫面上不會有任何錯誤——'
          + '除非你是刻意要暫停 AI，否則用「含任一關鍵字」。'
          + '（選「看意思」時這一格會換成<strong>範例句</strong>，填 3～5 種不同說法就夠。）',
        placement: 'right',
      },
      {
        target: '[data-tour="scr-test"]',
        title: '不確定會不會中？先在這裡試',
        description:
          '打一句<strong>客人可能會說的話</strong>，下面立刻告訴你這條會不會被啟動。'
          + '不用先上線、也不用拿真的客人試——<strong>設完先在這裡打兩句</strong>是最快確認自己沒設錯的方法。',
        placement: 'right',
      },
      {
        target: '[data-tour="scr-reply"]',
        title: '然後，要回客人什麼',
        description:
          '這一格就是客人會收到的話。只要一句話就結束的設定，到這裡就完成了；'
          + '要再問客人問題、收他的答案、依答案分流的話，往下有「<strong>還要多做一步…</strong>」可以加。',
        placement: 'right',
      },
      {
        target: '[data-tour="scr-save"]',
        title: '按「建立」才算數',
        description:
          '編好按右上角<strong>建立自動回應</strong>才會存檔。存之前上面那條狀態列會先幫你檢查'
          + '（有沒有接不起來的步驟、客人會不會卡在某一題出不來），<strong>看到綠色再存</strong>。'
          + '要問客人問題、依答案分流的話，教學清單裡還有一支「<strong>自動回應：多步驟接待</strong>」。',
        placement: 'bottom-end',
      },
    ],
  },
  /**
   * 自動回應：多步驟接待（2026-09-29 `D-109`）。
   *
   * 為什麼另開一支：上面那支 8 步只教到「一句話回一件事」，而這一頁最難的那一大塊——問客人問題、
   * 答不出來的退路、依答案分路、「前往…」接線、試跑整條——一步都沒教。塞進同一支會變成 13 步，
   * 只想設「營業時間」的人要一路按到底。
   * ⛔ 收集／分路那幾格**要先加那一步才畫得出來**，導覽不幫他加（會在他的草稿裡多塞一步），
   *    所以那一段用置中說明卡講，只指「一定在」的東西：積木選單、試跑、存檔。
   */
  {
    id: 'ai-scripts-flow',
    category: 'ai',
    // 「還要多做一步…」與積木選單都是 `canEditScripts`＝`scripts.write` 才畫（同上一支）
    requires: 'scripts.write',
    icon: Operation,
    label: '自動回應：多步驟接待',
    blurb: '問客人資料、答不出來的退路、依答案分流、試跑整條——預約、報名、退貨都靠這些。',
    route: wid => `/admin/${wid}/ai-scripts`,
    steps: [
      {
        target: '[data-tour="scr-grow"]',
        clickBefore: '[data-tour="scr-new"]',
        clickBeforeUnless: '[data-tour="scr-trigger-mode"]',
        // 手上開著的是已經有好幾步的流程：這顆不在，積木選單直接攤著——退去指它
        targetFallback: '[data-tour="scr-palette"]',
        title: '要多做一步，從這裡加',
        description:
          '一句話回一件事的話，前面那幾格就夠了。要<strong>問客人問題、給按鈕選、依答案分路、轉真人</strong>，按這顆「<strong>還要多做一步…</strong>」。',
        placement: 'top',
      },
      {
        target: '[data-tour="scr-palette"]',
        clickBefore: '[data-tour="scr-grow"]',
        clickBeforeUnless: '[data-tour="scr-palette"]',
        title: '每一塊就是一個步驟',
        description:
          '點一塊就在流程最後加一步。<strong>一般步驟會由上往下自動接下去</strong>；'
          + '只有「<strong>依答案分路</strong>」和「<strong>快速回覆</strong>」要自己用「<strong>前往…</strong>」下拉，指定每條路各接到哪一步——'
          + '這是整個編輯器唯一要自己接線的地方，接錯了客人會走到錯的地方。',
        placement: 'top',
      },
      {
        target: '',
        title: '問客人問題時，最容易漏的兩格',
        description:
          '「<strong>問客人資料</strong>」那一步：先在「<strong>這一題問的是</strong>」選一個（電話、Email、訂單編號…），格式和代號會自動帶好。'
          + '⚠️ 問訂單編號、序號這種<strong>客人可能根本沒有</strong>的東西，一定要加「<strong>答不出來的退路</strong>」——'
          + '沒有的話他會被一直重問、卡在那一題出不來。'
          + '「依答案分路」是<strong>由上往下第一個符合的</strong>就走那條，都不符合走「其餘情況」。',
      },
      {
        target: '[data-tour="scr-sim"]',
        clickBefore: '[data-tour="scr-sim-head"]',
        clickBeforeUnless: '[data-tour="scr-sim-panel"]',
        title: '整條試跑一次再存',
        description:
          '「<strong>試跑這條流程</strong>」讓你假裝客人一句一句打，看機器人怎麼回、會不會卡住——'
          + '<strong>純預覽，不會真的送出</strong>。上面的「測試觸發」只驗得了第一句會不會啟動，整條走不走得完要在這裡試。',
        placement: 'top',
      },
      {
        target: '[data-tour="scr-save"]',
        title: '存檔前看一眼狀態列',
        description:
          '上面那條狀態列會幫你檢查：有沒有接不起來的步驟、有沒有問了代碼卻沒給退路。<strong>看到綠色再按存檔</strong>。',
        placement: 'bottom-end',
      },
    ],
  },
  {
    id: 'ai-playground',
    category: 'ai',
    icon: Monitor,
    label: '試一下 AI 怎麼回答',
    blurb: '上線前先試答幾題，確認 AI 答得對。',
    // 這一頁的進入門檻（`ai-feature` 中介層）是 `playground.use`：觀察者進不去，
    // 教學清單就不該列給他（`G-109`：沒權限一律藏，不是點了才被踢回對話頁）
    requires: 'playground.use',
    route: wid => `/admin/${wid}/ai-playground`,
    steps: [
      {
        target: '[data-tour="pg-chat"]',
        title: '這是試答模式',
        description:
          '在這裡用「真實 LINE 對話」的方式測 AI，<strong>不會影響正式對話</strong>。遇到模糊問題它會反問、出選項，你可以點來模擬客人回答。',
        placement: 'bottom',
      },
      {
        target: '[data-tour="pg-composer"]',
        title: '輸入問題試答',
        description:
          // ⛔ 2026-09-29（`D-109`）：原本只叫人「到 AI 設定切全自動上線」——總開關沒開的話，
          //    切了全自動也不會回任何客人（這一頁的黃色提示講的正是總開關）
          '在這裡打客人可能會問的問題，按「<strong>送出</strong>」看 AI 怎麼答。多試幾題刁鑽的；確認答得穩，'
          + '再到 AI 設定把「<strong>啟用 AI 自動回覆</strong>」打開、回覆模式選「全自動」，客人才會收到。',
        placement: 'top',
      },
      {
        // 2026-09-29（`D-109`）：導覽叫人「確認答得穩」，卻沒講要看哪裡。
        // 這幾個數字要問過一題才會出現，第一次進來的人還沒問過——所以是置中說明卡，不指位置。
        target: '',
        title: '怎麼看它答得穩不穩',
        description:
          '每則回答下面有一行小字：<strong>信心</strong>要高過旁邊的<strong>門檻</strong>才會回客人，不然會轉真人；'
          + '<strong>命中 N 條</strong>＝它找到幾張知識卡，0 條就是知識庫裡沒有，要回去補。'
          + '答錯了按「<strong>展開詳情</strong>」看它用了哪幾張卡，直接點那張改。'
          + '出現「<strong>這句用的是還沒看過的卡</strong>」的話，那張卡還在等你採用——<strong>客人問不會拿到這個答案</strong>，按「去看這張卡」採用它。',
      },
    ],
  },
  {
    id: 'ai-usage',
    category: 'ai',
    // ⛔ 不設權限條件（2026-09-18 `D-82`）：這一頁 2026-08-10 特意從管理員降到 `ai.read`
    // ＝所有成員都看得到，理由是「第一線客服要看得到自己照顧的 AI 做得好不好」，
    // 但教學的條件沒跟著降，客服與觀察者在這一頁連問號都沒有。計費欄位由 API 逐欄位擋，
    // 不靠這裡。⛔ 要能寫知識庫才有意義的那一步（補知識）自己標 `requires`，不要整支鎖起來。
    icon: TrendCharts,
    label: '看 AI 用量與監控',
    blurb: '看 AI 幫你分擔多少、哪裡答不好要補知識。',
    route: wid => `/admin/${wid}/ai-usage`,
    steps: [
      {
        target: '[data-tour="usg-kpi"]',
        title: '看 AI 幫你分擔多少',
        description:
          // 2026-08-10 改場制：主指標是「場」不是「題」——導覽要跟畫面講同一種話
          // ⛔ 2026-09-29（`D-109`）：原本寫「下面那句灰框」——那一框只有普通表現時是灰的，好的時候綠、要注意時是橘的
          '最大的數字是<strong>全程搞定率</strong>：AI 接的對話裡，有幾成從頭到尾沒用到真人。彩色長條把 AI 接的場拆成<strong>全程搞定／用到真人</strong>兩段，下面那一句會直接告訴你現在算不算好、接下來做什麼。',
        placement: 'bottom',
      },
      {
        target: '[data-tour="usg-cases"]',
        // 這一步叫人去按「補知識」——觀察者沒有寫知識庫的權限，按了是死路，所以他跳過這步。
        // 那顆「補知識」與它的說明都是 `canEditKb`＝`knowledge.write` 才畫（ai-usage.vue）
        requires: 'knowledge.write',
        title: '答不出來的就地補知識',
        description:
          // ⛔ 2026-09-29（`D-109`）：「補知識」是**開新分頁**到知識庫（帶著客人原本那句話），不是跳走——這一頁會留著
          '這裡列出<strong>客人問了但 AI 答不出來</strong>的案例（預設只列答不出來的，上面可以改看別的原因）。'
          + '點某筆的「<strong>補知識</strong>」會<strong>另開一個分頁</strong>到知識庫、把客人那句話帶過去，補完回來這一頁還在——這是持續把 AI 養好的關鍵動作。',
        placement: 'top',
      },
      {
        target: '[data-tour="usg-period"]',
        title: '切換統計區間',
        description:
          // ⛔ 2026-09-29（`D-109`）：原本寫「上面所有數字會跟著重算」——下拉在最上面（數字都在它下面），
          //    而且案例清單不分月、趨勢固定近 3 個月、方案額度照續約日算，這三塊都不會跟著換
          '在這裡換<strong>統計月份</strong>（這個月／上個月…），全程搞定率與那條長條會跟著重算，方便比較不同時期。'
          + '⚠️ 下面的<strong>案例清單一律列最近的</strong>、趨勢圖固定看近 3 個月、方案額度照續約日算，這三塊不會跟著換。',
        placement: 'bottom',
      },
    ],
  },
  {
    id: 'conversations',
    category: 'daily',
    icon: ChatDotRound,
    label: '看懂對話收件匣',
    blurb: '客人對話怎麼進來、怎麼接手回覆。',
    route: wid => `/admin/${wid}/conversations`,
    steps: [
      {
        target: '[data-tour="conv-list"]',
        title: '對話都在左邊',
        description:
          '客人傳來的訊息會列在左邊這份清單，<strong>點一個</strong>就能看完整紀錄、直接回覆。',
        placement: 'right',
      },
      {
        target: '[data-tour="conv-tabs"]',
        title: '用狀態分頁分流',
        description:
          '這排分頁幫你分流：<strong>待真人</strong>是 AI 轉過來、等你接手的，最優先看這個；接手後會移到<strong>真人處理</strong>，談完按「結束會話」。<strong>待處理</strong>是完全還沒有人回過的對話。',
        placement: 'right',
      },
      // 2026-08-28 起擴到右半邊（這頁是客服每天待最久的地方，之前只教了左邊兩步）。
      // ⛔ 右半邊在「沒選對話」時整棵 DOM 都不存在（AdminSplitLayout 的 v-if/v-else），
      //    所以這一步要先幫他點開第一筆；後面幾步才有東西可以指。
      {
        target: '[data-tour="conv-header"]',
        clickBefore: '.conv-list-row .split-list-item',
        // 已經開著就不要切走使用者手上那一場（見 clickBeforeUnless 的說明）
        clickBeforeUnless: '[data-tour="conv-header"]',
        requiresPresent: '.conv-list-row .split-list-item',
        title: '點開一場對話',
        description:
          '最上面這排告訴你<strong>這場現在是誰在處理</strong>：狀態徽章、負責人，以及底下那行「新會話 → AI 客服 → 真人」的經過。',
        placement: 'bottom',
      },
      {
        // 2026-09-29（`D-109`）：以前只說「看得到負責人」，沒講可以指派——多人一起顧的時候，
        // 兩個人同時回同一位客人就是這樣發生的。⛔ 那顆是 `selectedUserId && canReply` 才畫
        // （AdminPanel.vue，`canReply`＝`can('conversations.reply')`），所以自己一步、標 requires，
        // 不要塞進上一步的說明（觀察者會被介紹一顆他沒有的按鈕）。
        target: '[data-tour="conv-assignee"]',
        targetFallback: '[data-tour="conv-header"]',
        requiresPresent: '.conv-list-row .split-list-item',
        requires: 'conversations.reply',
        title: '指派給一位同事',
        description:
          '點這裡可以把這位客人<strong>指派給某位同事</strong>（或自己）。多人一起顧的時候，大家一看就知道已經有人在跟，'
          + '<strong>不會兩個人同時回同一位客人</strong>。',
        placement: 'bottom',
      },
      {
        target: '[data-tour="conv-actions"]',
        // 這排按鈕只在「這場有進行中的會話」時才渲染，而點開的第一則可能是已結束的對話——
        // 退去指同一塊的標頭區塊（那裡一定在），說明照樣講得通
        targetFallback: '[data-tour="conv-header"]',
        requiresPresent: '.conv-list-row .split-list-item',
        title: '接手、交還、結束',
        description:
          '<strong>我接手</strong>＝這位客人先由你回，機器人與 AI 會暫停自動回覆，不會跟你搶話；'
          + '談完按<strong>交還機器人</strong>讓它繼續顧，或按<strong>結束會話</strong>把這一場結掉。',
        placement: 'bottom',
        // 這排裡的每一顆都掛在 `canReply`（`canTakeOverSession` 等）底下
        requires: 'conversations.reply',
      },
      {
        target: '[data-tour="conv-messages"]',
        requiresPresent: '.conv-list-row .split-list-item',
        title: 'AI 回的話，可以問它「為什麼」',
        description:
          'AI 回覆的泡泡下面有「<strong>為什麼這樣答</strong>」，點開看得到它根據哪幾則資料回的；'
          // ⛔ 2026-09-29（`D-109`）：原本寫「標了會收進小幫手的待辦清單」——畫面上講的是知識庫的「建議收件匣」
          + '答得不對就在那裡標「這題 AI 答錯了」——同一類被標到兩次，<strong>知識庫的建議收件匣就會擬好一張卡</strong>讓你審，補資料時就知道要補什麼。',
        placement: 'left',
        // `G-107`：那顆「為什麼這樣答」是 `canReply && msg.aiTurnId` 才渲染（AdminPanel.vue，
        // `canReply`＝`can('conversations.reply')`），觀察者畫面上沒有，這一步不標的話等於跟他介紹一顆他沒有的按鈕
        requires: 'conversations.reply',
      },
      {
        target: '[data-tour="conv-reply"]',
        requiresPresent: '.conv-list-row .split-list-item',
        title: '直接在這裡回覆',
        description:
          'Enter 送出、Shift + Enter 換行。你送出的訊息會即時進到客人的 LINE。',
        placement: 'top',
        // 回覆框是 `v-if="canReply"`
        requires: 'conversations.reply',
      },
      {
        target: '[data-tour="conv-presets"]',
        requiresPresent: '.conv-list-row .split-list-item',
        title: '常用回覆不用每次重打',
        description:
          '📦 是<strong>客服預存</strong>：挑一則就能直接送出，也可以先填進回覆框改幾個字再送。'
          + '要新增或修改預存內容，去側欄的「客服預存」。',
        placement: 'top',
        // 📦 那排在 `v-if="canReply"` 的工具列裡（送預存打的也是回覆端點）
        requires: 'conversations.reply',
      },
    ],
  },
  {
    id: 'flow',
    category: 'bot',
    // 「新增」鈕在 `<AdminOperateGate capability="marketing.write">` 裡（flow.vue）；
    // 下面幾支訊息類型的教學都在同一個編輯器裡，同一項能力
    requires: 'marketing.write',
    icon: Connection,
    label: '認識機器人模組',
    blurb: '一種一種帶你看：每介紹一個就先幫你選到它的實際畫面。',
    route: wid => `/admin/${wid}/flow`,
    steps: [
      {
        target: '[data-tour="flow-title"]',
        title: '模組是「要回什麼」的積木',
        description:
          '一個模組 = 一組要回給客人的訊息。最上面那個是<strong>系統模組</strong>（一定在、不能刪），下面是你自己加的。接下來我一個一個帶你看',
        placement: 'right',
      },
      /**
       * ⛔ 這裡原本有一步「歡迎模組」，2026-09-21 拿掉（`D-23`）。
       * 那一步說「它在客人加好友的當下自動發第一組訊息……你只要編內容」——**是假的**：
       * 那顆系統模組在 `server/` 沒有任何執行路徑，照著編完等客人加好友什麼都不會發生。
       * 加好友歡迎真正的家是「自動回應 → 客人加好友時」那一列，收尾那一步會指過去。
       */
      {
        target: '[data-tour="flow-sys-badge"]',
        clickBefore: '[data-tour="flow-sys-live_agent"]',
        title: '真人客服',
        description:
          '這是「<strong>真人客服</strong>」模組。當對話<strong>轉給真人</strong>時會發這組訊息——例如「已為您轉接專人，請稍候」。一樣系統內建，編好內容即可。',
        placement: 'bottom',
      },
      {
        // 2026-09-29（`D-109`）：「客人會從哪裡走到這個模組」藏在標題下那行灰字裡，以前沒人講。
        // 它只在「打開一個已經存在的模組」時才畫，所以排在上一步（已經幫他選了真人客服那個）後面、
        // 在下一步按「新增」之前。
        target: '[data-tour="flow-usage"]',
        title: '這個模組會從哪裡被叫出來',
        description:
          '標題下面這行「<strong>客人會從 N 個地方走到這裡</strong>」告訴你哪些地方會送出這個模組（自動回應、圖文選單、活動…），點開看得到是哪幾個。'
          + '⚠️ 寫著「<strong>客人走不到這裡</strong>」的話，這個模組<strong>建好了也永遠不會發出去</strong>——'
          + '要到「自動回應」設關鍵字，或在圖文選單、活動上指到它。刪模組之前也先看這一行，有人在用的刪了那些按鈕就會壞。',
        placement: 'bottom',
      },
      {
        target: '[data-tour="flow-name"]',
        clickBefore: '[data-tour="flow-new"]',
        title: '你自己加的模組',
        description:
          '我幫你按了「新增」進入。自己加的模組<strong>只有一種</strong>，不用選類型——先在這裡取個名字（只有你看得到，客人不會看到），接著往下加要回的訊息。',
        placement: 'bottom',
      },
      {
        target: '[data-tour="flow-messages"]',
        title: '加要回的訊息',
        description:
          // ⛔ 2026-09-29（`D-109`）：原本寫「想回幾則都行」——上限是 5 則（flow.vue 的 FLOW_MESSAGE_LIMIT，LINE 一次最多收 5 則）
          '不管哪種模組，內容都在這排按鈕加：點一下就多一則回覆，<strong>一個模組最多 5 則</strong>。<strong>每種訊息怎麼填</strong>，主選單有「基本訊息」和各種訊息類型的專屬教學可以跑。',
        placement: 'bottom',
      },
      {
        target: '',
        title: '什麼時候會回？',
        // ⛔ 側欄那一頁叫「自動回應」，不是「自動回覆」——後者 2026-08-09 已下架併進前者，
        //    側欄上找不到那四個字。第一次的人正是在這一刻要去找「那什麼時候會回」，
        //    指錯名字就直接走丟（同一個坑在 flow.vue 的 caption 也標過）。
        // ⛔ 2026-09-21（`D-23`）：舊文案寫「歡迎模組與真人客服例外，系統會自己發」——
        //    歡迎模組那半是假的（沒有任何執行路徑），而且那顆已經拿掉了。
        description:
          '模組只管「<strong>回什麼</strong>」；「<strong>什麼時候回</strong>」要另外綁，都在側欄的「<strong>自動回應</strong>」：'
          + '用<strong>關鍵字</strong>指向這個模組，或用最上面那一列「<strong>客人加好友時</strong>」讓新朋友一加好友就收到。'
          + '（「真人客服」是例外，轉真人時系統會自己發。）編好按右上「<strong>建立模組</strong>／<strong>儲存變更</strong>」就生效',
      },
    ],
  },
  {
    id: 'msg-basic',
    category: 'bot',
    requires: 'marketing.write',
    icon: ChatLineSquare,
    label: '基本訊息（文字/圖片/影片）',
    blurb: '最常用的三種訊息，一顆一顆按給你看、知識也開出來。',
    route: wid => `/admin/${wid}/flow`,
    steps: [
      {
        target: '[data-tour="fmt-text"]',
        demoType: 'text',
        title: '文字',
        description:
          '點「<strong>＋ 文字</strong>」加一則純文字（可放表情符號、自動帶入客人暱稱，文字下還能加按鈕）。下方就是它的知識。',
        placement: 'bottom',
      },
      {
        target: '[data-tour="fmt-image"]',
        demoType: 'image',
        title: '圖片',
        description:
          '點「<strong>＋ 圖片</strong>」加一張圖，上傳即可（海報、菜單、活動圖），系統自動處理預覽。',
        placement: 'bottom',
      },
      {
        target: '[data-tour="fmt-video"]',
        demoType: 'video',
        title: '影片',
        description:
          '點「<strong>＋ 影片</strong>」加一段影片，再給一張預覽縮圖，客人按了才播放。',
        placement: 'bottom',
      },
    ],
  },
  {
    id: 'msg-rich',
    category: 'bot',
    requires: 'marketing.write',
    icon: Postcard,
    label: '圖文訊息怎麼填',
    blurb: '一張大圖切成多個可點區塊。打開一條帶你填。',
    route: wid => `/admin/${wid}/flow`,
    steps: [
      {
        target: '[data-tour="fmt-rich"]',
        demoType: 'richMessage',
        title: '先加一張圖文訊息',
        description:
          '點「<strong>＋ 圖文訊息</strong>」這顆就會加一張。我幫你開好了，往下教你填每個欄位 →',
        placement: 'bottom',
      },
      {
        target: '[data-tour="rich-layout"]',
        demoType: 'richMessage',
        title: '選版型',
        description:
          '圖文訊息是一張大圖、切成多個<strong>可點區塊</strong>。先選一個<strong>版型</strong>，決定要切成幾塊。',
        placement: 'top',
      },
      {
        target: '[data-tour="rich-hero"]',
        demoType: 'richMessage',
        title: '上傳大圖 + 綁動作',
        description:
          '在這裡上傳底圖。<strong>上傳後</strong>，圖上每個區塊就能各自綁一個動作（開網址、觸發模組、傳訊息…）——這是圖文訊息最強的地方。',
        placement: 'top',
      },
    ],
  },
  {
    id: 'msg-carousel',
    category: 'bot',
    requires: 'marketing.write',
    icon: Files,
    label: '輪播訊息怎麼填',
    blurb: '多條知識左右滑。打開一張帶你填。',
    route: wid => `/admin/${wid}/flow`,
    steps: [
      {
        target: '[data-tour="fmt-carousel"]',
        demoType: 'flexImageCarousel',
        title: '先加一張輪播訊息',
        description:
          '點「<strong>＋ 輪播訊息</strong>」這顆就會加一張。我幫你開好了，往下教你填每個欄位 →',
        placement: 'bottom',
      },
      {
        target: '[data-tour="flex-enable-image"]',
        demoType: 'flexImageCarousel',
        title: '要不要放圖',
        description:
          '輪播訊息是多條知識可<strong>左右滑</strong>。先決定每條<strong>要不要放圖片</strong>（開了就能上傳圖、設比例）。',
        placement: 'top',
      },
      {
        target: '[data-tour="flex-col-title"]',
        demoType: 'flexImageCarousel',
        title: '填知識內容',
        description:
          '每條填<strong>標題、內文</strong>；若有開圖還能上傳圖片、加最多 3 顆<strong>按鈕</strong>。',
        placement: 'top',
      },
      {
        target: '[data-tour="flex-add-column"]',
        demoType: 'flexImageCarousel',
        title: '多加幾條',
        description:
          '按這顆「＋」就多一條，客人在聊天室能<strong>左右滑</strong>看更多。商品、方案並排介紹最好用。',
        placement: 'left',
      },
    ],
  },
  {
    id: 'msg-quick',
    category: 'bot',
    requires: 'marketing.write',
    icon: Pointer,
    label: '快速回覆怎麼填',
    blurb: '訊息下方一排建議按鈕。打開一張帶你填。',
    route: wid => `/admin/${wid}/flow`,
    steps: [
      {
        target: '[data-tour="fmt-quick"]',
        demoType: 'quickReply',
        title: '先加一張快速回覆',
        description:
          '點「<strong>＋ 快速回覆</strong>」這顆就會加一張。我幫你開好了，往下教你填每個欄位 →',
        placement: 'bottom',
      },
      {
        target: '[data-tour="quick-prompt"]',
        demoType: 'quickReply',
        title: '主要文字',
        description:
          '快速回覆是在訊息<strong>下方冒出一排建議按鈕</strong>。先在這裡打主要的回覆文字。',
        placement: 'top',
      },
      {
        target: '[data-tour="quick-button"]',
        demoType: 'quickReply',
        title: '每顆按鈕',
        description:
          '一顆按鈕 = 一個建議選項：設<strong>顯示文字</strong>、選客人點了要做什麼（回傳訊息／開網址／觸發模組）。',
        placement: 'top',
      },
      {
        target: '[data-tour="quick-add"]',
        demoType: 'quickReply',
        title: '加更多選項',
        description: '要更多選項就按這顆「＋」加一顆按鈕（最多 13 顆）。',
        placement: 'left',
      },
    ],
  },
  {
    id: 'msg-userinput',
    category: 'bot',
    requires: 'marketing.write',
    requiresFeature: 'userInput',
    icon: EditPen,
    label: '用戶輸入卡怎麼填',
    blurb: '問問題、收答案、還能觸發下一步。打開一張帶你填。',
    route: wid => `/admin/${wid}/flow`,
    steps: [
      {
        target: '[data-tour="fmt-userinput"]',
        demoType: 'userInput',
        title: '先加一張用戶輸入卡',
        description:
          '點「<strong>＋ 用戶輸入</strong>」這顆就會加一張。我幫你開好了，往下教你填每個欄位 →',
        placement: 'bottom',
      },
      {
        target: '[data-tour="ui-question"]',
        demoType: 'userInput',
        title: '提問',
        description:
          '用戶輸入卡能<strong>問客人問題、收答案</strong>。先在這裡打你要問的問題。',
        placement: 'top',
      },
      {
        target: '[data-tour="ui-attribute"]',
        demoType: 'userInput',
        requiresFeature: 'userInputAttribute',
        title: '存成屬性（特殊）',
        description:
          '把客人的回答<strong>存成一個屬性</strong>（例：phone、email）。存了之後，其他地方就能帶入這個值重複使用。',
        placement: 'top',
      },
      {
        target: '[data-tour="ui-next-module"]',
        demoType: 'userInput',
        title: '觸發下一步（特殊）',
        description:
          '客人回答後，<strong>自動接著跑哪個模組</strong>——這就是把多步驟串成流程的關鍵，做表單、預約都靠它。看完囉，按「結束」我會幫你把示範草稿清掉。',
        placement: 'top',
      },
    ],
  },
  {
    id: 'richmenu',
    category: 'growth',
    // 「新增」鈕是 `canEditMenus`＝`can('marketing.write')`（richmenu.vue）
    requires: 'marketing.write',
    icon: Grid,
    label: '建立圖文選單',
    blurb: '聊天室下方的圖片選單。直接進新增畫面、一個欄位一個欄位教你填。',
    route: wid => `/admin/${wid}/richmenu`,
    steps: [
      {
        target: '[data-tour="rm-title"]',
        title: '圖文選單是什麼',
        description:
          '圖文選單是 LINE 聊天室<strong>下方的圖片選單</strong>，客人點一個區塊就觸發動作（開網址、送訊息…），是很常用的固定入口。我直接帶你進新增畫面示範 →',
        placement: 'right',
      },
      {
        target: '[data-tour="rm-chatbar"]',
        clickBefore: '[data-tour="rm-new"]',
        title: '選單標籤文字',
        description:
          '聊天室左下角會顯示的<strong>小標籤文字</strong>（例如「選單」「menu」，LINE 稱為 Chat Bar），客人點它才會展開選單。',
        placement: 'right',
      },
      {
        target: '[data-tour="rm-default"]',
        title: '設為預設選單',
        // ⛔ 2026-09-29（`D-109`）：原本寫「新加好友會自動顯示」——把後果講小了：
        //    設為預設是**所有好友**的選單立刻換成它（跟建立前那個確認框同一句）
        description:
          '打開的話，存檔當下<strong>所有好友</strong>聊天室下方的選單都會<strong>立刻換成這張</strong>。'
          + '一個帳號同時只會有一個預設選單。還沒做好就先關著存起來，客人看不到。',
        placement: 'right',
      },
      {
        target: '[data-tour="rm-image"]',
        title: '上傳背景圖（必要）',
        description:
          '上傳<strong>整張選單的底圖</strong>（建議 2500×1686 或 2500×843）。客人看到的就是這張圖。',
        placement: 'right',
      },
      {
        target: '[data-tour="rm-layout"]',
        title: '選版型',
        description:
          '選一個<strong>版型</strong>，決定整張圖要切成幾個可點區塊（例如 2×3 六格）。要完全自訂就選「自訂」。',
        placement: 'right',
      },
      {
        target: '',
        title: '幫每個區塊綁動作',
        description:
          '上傳背景圖後，下方會出現「<strong>區塊設定</strong>」：幫每一個區塊綁一個動作——<strong>開網址、傳訊息、觸發模組、切換到另一個選單</strong>都行。'
          // 2026-09-29（`D-109`）：「客人看到的樣子」是唯一驗得到「客人按下去會怎樣」的地方，以前沒人講。
          // 它要上傳圖之後才出現，所以寫在這張置中卡裡、不另開一步去指一個還不存在的東西。
          + '右邊還會出現「<strong>客人看到的樣子</strong>」：<strong>點任何一格試按</strong>，就看得到客人按下去會收到什麼（試按不會真的送出、也不會貼標籤）。',
      },
      {
        target: '[data-tour="rm-save"]',
        title: '建立',
        // ⛔ 2026-09-29（`D-109`）：原本寫「按建立就生效」——沒打開「設為預設」的話建好客人看不到
        description:
          '都填好後按右上「<strong>建立圖文選單</strong>」。有打開「設為預設」才會<strong>馬上出現在客人的聊天室</strong>；'
          + '沒打開的話會先存起來，之後打開這張、按上面的「<strong>設為預設（上線）</strong>」就上線。',
        placement: 'bottom-end',
      },
    ],
  },
  {
    id: 'tags',
    category: 'growth',
    // 「新增」「從範本建立」都是 `canEditTags`＝`can('tags.write')`（tags.vue）
    requires: 'tags.write',
    icon: PriceTag,
    label: '建立好友標籤',
    blurb: '標籤把好友分群，之後推播、活動都能鎖定分眾。帶你建第一個。',
    route: wid => `/admin/${wid}/tags`,
    steps: [
      {
        target: '[data-tour="tag-new"]',
        title: '標籤用來分眾',
        description:
          // ⛔ 按鈕上只寫「新增」（`D-109`），照畫面上的字寫
          '標籤是把好友<strong>分群</strong>的基礎——貼了標籤，之後<strong>推播</strong>就能只發給某群人、<strong>活動</strong>也能自動貼標歸類。點右上「<strong>新增</strong>」建第一個。',
        placement: 'bottom-end',
      },
      {
        // 這個錨點 08 月就標好了，卻沒有任何一步用到（`D-82` 盤點掃出來的三個孤兒錨點之一）
        target: '[data-tour="tag-templates"]',
        title: '想不到要分哪些群？從範本挑',
        description:
          '不知道第一批該建哪些標籤的話，點「<strong>從範本建立</strong>」——'
          // ⛔ 2026-09-29（`D-109`）：原本舉「買過／有興趣沒買」——範本裡沒有這兩個，而且系統沒有購買資料
          //    （`C-60` 撤過同一種說法）。例子只能挑範本裡真的有的（shared/tag-templates.ts）。
          + '裡面是客服最常用的分法（例如問過出貨進度、問過價格優惠、在等開賣），<strong>勾了就一次幫你建好</strong>，'
          + '而且一開始是<strong>讓 AI 先建議、你確認才貼</strong>，之後照樣能改名字和顏色。',
        placement: 'bottom-end',
      },
      {
        target: '[data-tour="tag-filter"]',
        title: '搜尋與篩選',
        description:
          '標籤變多時，用這排<strong>搜尋、分類、狀態</strong>快速找到要的那個。停用的標籤不會出現在貼標選單，但仍可在這裡編輯。',
        placement: 'bottom',
      },
      {
        target: '[data-tour="tag-code"]',
        clickBefore: '[data-tour="tag-new"]',
        title: '英文代號（建立後不能改）',
        description:
          '這是<strong>給系統認的代號</strong>（客人看不到）：英文小寫開頭，可含數字、底線，例如 <code>vip</code>、<code>interest_food</code>。建立後就固定，先想好再填。',
        placement: 'bottom',
      },
      {
        target: '[data-tour="tag-name"]',
        title: '顯示名稱、分類與顏色',
        description:
          '這裡填<strong>給人看的名字</strong>（例：VIP），再選分類、挑個顏色方便一眼認出。都填好按「<strong>建立標籤</strong>」就完成',
        placement: 'bottom',
      },
    ],
  },
  {
    id: 'campaigns',
    category: 'growth',
    // 「新增」鈕是 `v-if="can('marketing.write')"`（campaigns.vue）
    requires: 'marketing.write',
    icon: Tickets,
    // ⛔ 名字跟側欄同一個詞（`D-109`；同 `ai-scripts` 那支的理由）：側欄叫「活動標籤」
    label: '活動標籤：用一條連結收名單',
    blurb: '用一條連結收名單、加好友自動貼標。帶你開一個活動。',
    route: wid => `/admin/${wid}/campaigns`,
    steps: [
      {
        target: '[data-tour="cmp-new"]',
        title: '活動貼標是什麼',
        description:
          '活動貼標給你一條<strong>活動進入網址</strong>：客人點入先綁 LINE，之後<strong>加官方帳號好友時，系統自動幫他貼上這個活動的標籤</strong>。很適合問卷、廣告、線下活動的<strong>名單分眾</strong>。點「<strong>新增</strong>」開一個。',
        placement: 'right',
      },
      {
        target: '[data-tour="cmp-tagsection"]',
        clickBefore: '[data-tour="cmp-new"]',
        title: '選要貼的標籤（必填）',
        description:
          // ⛔ 2026-09-29（`D-109`）：原本叫人「先去標籤管理建再回來」——這一格已經可以當場建（AdminTagPicker）
          '設定這波活動的名單，加好友時要<strong>自動貼上哪些標籤</strong>——至少選一個。還沒有合適的標籤，在這一格按「<strong>＋ 新標籤</strong>」就能當場建。',
        placement: 'top',
      },
      {
        target: '[data-tour="cmp-action"]',
        title: '貼標後要不要多做一件事（選填）',
        description:
          '除了貼標，還能順手<strong>觸發一個機器人模組、回一段文字或開網址</strong>——例如發一則歡迎訊息。不需要就留「<strong>不觸發動作</strong>」。',
        placement: 'top',
      },
      {
        target: '',
        title: '儲存後拿到活動網址',
        description:
          '按「<strong>建立活動</strong>」後，系統會給一條<strong>活動進入網址</strong>——把它貼到問卷完成頁、廣告按鈕或簡訊就能開始收名單。下方「<strong>行銷成效</strong>」還能看多少人綁定、貼標完成率',
      },
    ],
  },
  /**
   * ⛔ **順序有意義**（`C-210`，2026-09-21）：這一區以前是
   * 圖文選單 → **推播** → 標籤 → 活動 → 好友，
   * 等於**先教怎麼發推播，而推播第三步就叫你用「還沒教過」的標籤**。
   * 改成跟側欄同一個故事線：**名單（好友）→ 分群（標籤、活動）→ 只發給其中一群（推播）**。
   * ⛔ 分類內的顯示順序就是這個陣列的順序（`useTutorial.ts` 的 `groupedTopics` 只做 filter），
   *    別另外加 `order` 欄位——那會變成兩份順序，遲早對不起來。
   */
  {
    id: 'broadcasts',
    category: 'growth',
    // 「新增」鈕是 `v-if="can('broadcast.write')"`（broadcasts.vue）；正式發送那一步另標 `broadcast.send`
    requires: 'broadcast.write',
    icon: Promotion,
    label: '發一則推播',
    blurb: '主動群發訊息給好友。帶你認識怎麼發。',
    route: wid => `/admin/${wid}/broadcasts`,
    steps: [
      {
        target: '[data-tour="bc-title"]',
        title: '推播是主動群發',
        description:
          '推播是<strong>主動群發</strong>訊息給好友——活動、公告都靠它。注意推播會耗用 LINE 的月推播額度。',
        placement: 'right',
      },
      {
        target: '[data-tour="bc-new"]',
        title: '建一則推播',
        description:
          '點「<strong>新增</strong>」開一則。接下來我帶你看<strong>發給誰、發什麼、什麼時候發</strong>這三件事。',
        placement: 'right',
      },
      // ── 以下是編輯器裡面（2026-09-18 `D-82` 拍板：導覽不可以停在門口）───────────
      // ⛔ 同 `ai-scripts`：這幾步不能用 `requiresPresent`（那是在 clickBefore 之前問的，
      //    那時編輯器還沒開，填了每次都被靜默刷掉）。
      {
        target: '[data-tour="bc-audience"]',
        // 手上已經開著一則在編輯就不要按「新增」把它切掉
        clickBefore: '[data-tour="bc-new"]',
        clickBeforeUnless: '[data-tour="bc-audience"]',
        title: '先決定發給誰',
        description:
          '<strong>全部好友</strong>最花額度；多數時候用<strong>依標籤篩選</strong>只發給其中一群人'
          + '（例如只發給貼過「VIP」的）。⚠️ 選兩顆以上標籤是「<strong>或</strong>」——'
          + '有其中任一顆的人都會收到，不是兩顆都要有。',
        placement: 'right',
      },
      {
        target: '[data-tour="bc-content"]',
        title: '再寫要發什麼',
        /**
         * ⛔ 這一步以前寫「可以發**圖片、圖文訊息**……這一區跟你在機器人模組看到的是
         * **同一套編輯器**」——**兩句都不是真的**（`C-210` 修）：推播內容只有
         * 文字／開網址／觸發模組三選一，而且用的是 `AdminAreaActionEditor`，
         * 不是模組頁那套。照著找圖片按鈕的人會在畫面上找不到。
         * 要發圖片的正解就是下面那句：把圖片放進模組，再讓推播觸發那個模組。
         */
        description:
          '推播本身只能發<strong>一段文字</strong>、<strong>一個開網址的按鈕</strong>，'
          + '或是<strong>觸發一個機器人模組</strong>。'
          + '想發圖片、圖文訊息或多則訊息，就先到「機器人模組」做好，這裡選那個模組——'
          + '客人收到的會是模組裡的完整內容。',
        placement: 'left',
      },
      {
        // 2026-09-29（`D-109`）：「試發一則給自己看」是發出去收不回之前**唯一的安全網**，7 步導覽以前一句都沒提
        target: '[data-tour="bc-testsend"]',
        title: '先發一則給自己看',
        description:
          // `D-119` ⑥：收件人改成名單打勾（自己、綁好手機的同事、常找來看稿的人），不再在全部好友裡搜名字
          '寫好之後按「<strong>試發一則給自己看</strong>」，勾你自己、同事或常找來看稿的人，會真的送到他們的手機——在手機上看過字、圖、按鈕都對了再發。'
          + '試發<strong>不會</strong>算進成效、<strong>不會</strong>貼記號、也<strong>不會</strong>改變這則推播的狀態。',
        placement: 'left',
      },
      {
        target: '[data-tour="bc-schedule"]',
        title: '現在發，還是約時間發',
        description:
          '選「<strong>排程發送</strong>」就約一個時間，到點自動送出。'
          + '⚠️ <strong>發送對象是到那個時間點才計算</strong>——這段期間新加的好友、新貼的標籤都會算進去。',
        placement: 'left',
      },
      {
        target: '[data-tour="bc-send"]',
        // 這顆是 `v-if="can('broadcast.send')"`，跟上面建草稿的 `broadcast.write` 是兩項能力（`G-109`）
        requires: 'broadcast.send',
        title: '送出前會先讓你看人數',
        description:
          '按這顆不會立刻送出：系統會先算好<strong>預估發送人數</strong>、列幾筆名單給你看，'
          + '<strong>你再按一次確認才真的發</strong>。⚠️ 發出去收不回來，人數跟你想的差太多就先取消。',
        placement: 'bottom-end',
      },
      {
        target: '',
        title: '發完之後，回來看成效',
        description:
          '送出後回到這則推播，下面會多一段「<strong>成效報表</strong>」：送出去幾筆、幾筆失敗、'
          + '<strong>哪些人沒收到</strong>（多半是對方封鎖了官方帳號，可以個別跟進），以及 LINE 提供的開封數。',
      },
    ],
  },
  {
    id: 'users',
    category: 'growth',
    // 「從 LINE 同步好友」與批次貼標是 `canTagCustomers`＝`can('customers.write')`（users.vue）
    requires: 'customers.write',
    icon: User,
    label: '管理好友與貼標',
    blurb: '看好友名單、依標籤篩選、批次貼標。',
    route: wid => `/admin/${wid}/users`,
    steps: [
      {
        target: '[data-tour="usr-sync"]',
        title: '好友名單從哪來',
        description:
          '這頁列出所有 LINE 好友。清單來自資料庫——若少了只加好友、還沒互動過的人，按「<strong>從 LINE 同步好友</strong>」拉官方好友名單（好友多時會分批，可連按數次直到完成）。',
        placement: 'bottom-end',
      },
      {
        target: '[data-tour="usr-filter"]',
        title: '搜尋與依標籤分眾',
        description:
          '用<strong>顯示名稱搜尋</strong>，或<strong>依標籤篩選</strong>看某一群人（例如只看「VIP」）。這就是把標籤變成可用名單的地方。',
        placement: 'bottom',
      },
      {
        target: '[data-tour="usr-list"]',
        title: '查看與批次貼標',
        description:
          '<strong>點一位好友</strong>看他的資料與標籤；<strong>勾選多位</strong>後，上方會出現「<strong>批次加標／移標</strong>」，一次幫一群人貼上或拿掉標籤，整理名單很快。',
        placement: 'top',
      },
    ],
  },
  /**
   * 好友統計（2026-09-29 `D-109`）。
   *
   * 為什麼補：這一頁 09-23 才開，晚於 09-18 的逐頁盤點（`D-82`），頁首沒填 `help-topics`
   * ＝連「這頁怎麼用」的問號都沒有、第一次進來也不會自動跑導覽。
   * 頁面自己的說明寫得很清楚，只補第一次看會卡的三件：報告要按了才有（而且不會自己更新）、
   * 「做過什麼」不等於「想買」、一顆標籤都沒有的人按標籤發推播會漏掉。
   * ⛔ 每一步都是「有東西才出現」：還沒產生過報告只會看到第一步，有報告的看不到第一步。
   */
  {
    id: 'friend-stats',
    category: 'growth',
    icon: PieChart,
    label: '看懂好友統計',
    blurb: '從標籤看客人在乎什麼、誰還沒被貼到——產生一次報告就看得到。',
    route: wid => `/admin/${wid}/friend-stats`,
    steps: [
      {
        target: '[data-tour="fs-empty"]',
        requiresPresent: '[data-tour="fs-empty"]',
        title: '先產生一份報告',
        description:
          '這一頁要先按「<strong>產生報告</strong>」：系統會把你所有的標籤整理一次（要等一下子），告訴你客人在乎什麼、誰還沒被貼到、AI 貼得準不準。'
          + '報告<strong>不會自己更新</strong>，之後想看最新的再按一次。（觀察者要請客服或管理員來按。）',
        placement: 'bottom',
      },
      {
        target: '[data-tour="fs-regenerate"]',
        requiresPresent: '[data-tour="fs-regenerate"]',
        title: '報告是哪時候的',
        description:
          '這裡寫著這份報告<strong>是什麼時候產生的</strong>——它不會自己更新。想看最新的按「<strong>重新產生</strong>」（一小時最多一次）。',
        placement: 'bottom-end',
      },
      {
        target: '[data-tour="fs-expressed"]',
        requiresPresent: '[data-tour="fs-expressed"]',
        title: '最容易看錯的一張',
        description:
          '標「<strong>做過什麼</strong>」的是<strong>事件紀錄</strong>（填過那份問卷、報名過那檔活動），<strong>不代表他想買</strong>；'
          + '只有標「<strong>想要什麼</strong>」的才是 AI 從對話判出來的意圖。「<strong>發推播給這群</strong>」會直接帶這群人去推播頁。',
        placement: 'top',
      },
      {
        target: '[data-tour="fs-coverage"]',
        requiresPresent: '[data-tour="fs-coverage"]',
        title: '一顆標籤都沒有的人',
        description:
          '這些人<strong>任何按標籤發的推播都會漏掉</strong>。分母是「有互動的客人」，不是 LINE 的好友總數——從來沒講過話的好友不在名單裡。',
        placement: 'top',
      },
    ],
  },
  {
    id: 'support-presets',
    category: 'growth',
    // 「新增」鈕是 `canEditPresets`＝`can('presets.write')`（support-presets.vue）
    requires: 'presets.write',
    icon: Box,
    label: '建立客服預存',
    blurb: '常用回覆存起來，對話時一選即送。',
    route: wid => `/admin/${wid}/support-presets`,
    steps: [
      {
        target: '[data-tour="sp-title"]',
        title: '什麼是客服預存',
        description:
          '客服預存是把<strong>常用回覆</strong>（或模組捷徑）先存好，客服在「對話」頁<strong>一選即送</strong>，不用每次重打。',
        placement: 'right',
      },
      {
        target: '[data-tour="sp-new"]',
        title: '新增一筆',
        description: '點「<strong>新增</strong>」開一筆，我帶你看裡面要填什麼。',
        placement: 'right',
      },
      // ── 以下是編輯器裡面（2026-09-18 `D-82` 第二批）─────────────────────────
      // ⛔ 同前：不能用 `requiresPresent`（在 clickBefore 之前問，那時編輯器還沒開）
      {
        target: '[data-tour="sp-action"]',
        clickBefore: '[data-tour="sp-new"]',
        clickBeforeUnless: '[data-tour="sp-action"]',
        title: '這則預存要送出什麼',
        description:
          '客服在對話頁挑到這一則時會送出的東西：可以是<strong>一段文字</strong>、'
          + '<strong>一個網址</strong>，也可以<strong>觸發一個機器人模組</strong>（整組訊息一次送出）。',
        placement: 'left',
      },
      {
        target: '[data-tour="sp-tagging"]',
        title: '順手貼標籤（這個開關會動到客人資料）',
        description:
          '開了之後，客服<strong>每送出一次這則回覆，就自動幫那位客人貼上你指定的標籤</strong>。'
          + '例如「已寄出退貨單」這則預存貼上「退貨中」，之後就能把這批人整批撈出來追蹤。'
          + '⚠️ 這件事發生在<strong>客人資料那邊</strong>、對話頁上看不出來，所以設之前先想好要貼哪一顆。',
        placement: 'left',
      },
      {
        target: '[data-tour="sp-save"]',
        title: '建立，並記得「啟用」',
        description:
          '按右上角<strong>建立預存</strong>存檔。⚠️ 只有狀態切成「<strong>啟用中</strong>」的預存'
          + '才會出現在對話頁那個 📦 選單裡——停用的留在這裡可以繼續編輯，但客服挑不到。',
        placement: 'bottom-end',
      },
    ],
  },
  {
    id: 'conversation-stats',
    category: 'growth',
    icon: DataLine,
    label: '看對話統計',
    blurb: '看 AI 幫你擋掉多少、哪裡要優化。',
    route: wid => `/admin/${wid}/conversation-stats`,
    steps: [
      {
        target: '[data-tour="cs-filter"]',
        title: '選日期範圍',
        // ⛔ 2026-09-29（`D-109`）：原本說日／週／月也在這裡、匯出是 Excel——
        //    日／週／月在下面的「趨勢」卡，按鈕上寫的是「匯出 CSV」
        description:
          '選<strong>日期範圍</strong>（或按近 7／30／90 天），下面的數字會跟著變；右邊「<strong>匯出 CSV</strong>」可以存成表格檔（Excel 打得開）。'
          + '要改成按日／週／月看，在下面「趨勢」那張卡切。',
        placement: 'bottom',
      },
      {
        target: '[data-tour="cs-kpi"]',
        title: '看關鍵數字',
        // ⛔ 2026-09-29（`D-109`）：原本講「總對話數、機器人先接住的比例、結案比例」——
        //    跟畫面上那四張卡對不上；「先接住」在下面那張「第一句話是誰回的」，而且機器人跟 AI 是分開算的
        description:
          '這排四張：<strong>新增對話</strong>、<strong>新加好友</strong>、<strong>轉真人</strong>、<strong>已結束</strong>。'
          + '「轉真人」和「已結束」<strong>點下去會直接列出那幾場對話</strong>。'
          + '想知道客人第一句是誰先接的（機器人、AI 還是真人），看下面「<strong>第一句話是誰回的</strong>」那一條。',
        placement: 'bottom',
      },
    ],
  },
  {
    id: 'members',
    category: 'setup',
    icon: UserFilled,
    label: '邀請團隊成員',
    blurb: '把同事加進來、分配角色權限。',
    // 教的是「邀請成員」那顆＝`v-if="can('members.manage')"`（進這一頁本身是 `members.read`，同為管理員）
    requires: 'members.manage',
    route: wid => `/admin/${wid}/settings/members`,
    steps: [
      {
        target: '[data-tour="mem-list"]',
        title: '誰能進這個後台',
        description:
          '這裡管理成員與權限。每個人有角色：<strong>管理員</strong>（可改設定）、<strong>客服</strong>（能處理對話）、<strong>觀察者</strong>（只能看）。',
        placement: 'bottom',
      },
      {
        target: '[data-tour="mem-invite"]',
        title: '用 Email 邀請',
        description:
          '點「<strong>邀請成員</strong>」輸入他的 Google 信箱——對方<strong>不用先註冊</strong>，用那個信箱第一次登入就自動生效。'
          // `D-117`：系統不會寄邀請信（`G-3`），不講的話管理員會以為對方收到通知了
          + '⚠️ 系統<strong>不會寄信</strong>給他：邀請完在他那一列按「<strong>複製登入連結</strong>」傳給他。',
        placement: 'bottom-end',
      },
      {
        // 2026-09-18 `D-82` 第二批：邀請完還有一件事沒人講，而漏了它的後果是「客人在等、沒人知道」。
        // 2026-09-27 `C-270`：綁 LINE 搬到「設定 → LINE 通知」，同事第一次登入也會被問一次
        target: '[data-tour="mem-line"]',
        title: '邀請完還有一件事：讓他的手機收得到通知',
        description:
          '客人要找真人、每天早上的摘要，是<strong>用 LINE 傳到同事自己的手機</strong>。'
          + '同事第一次登入後台時會被問一次要不要收，<strong>用手機掃一下就好</strong>；'
          + '他不會登入的話，到「<strong>設定 → LINE 通知</strong>」在他那一列按「傳連結給他」。',
        placement: 'bottom',
      },
    ],
  },
  /**
   * LINE 通知（2026-09-27 `C-270`／`D-103`）。
   * 客服也進得來（第 3 題拍板：客服可以加／退自己），所以第一步不限角色；
   * 「什麼時候通知」那一塊只有管理員看得到，第二步跟著限管理員。
   */
  {
    id: 'line-notify',
    category: 'setup',
    icon: Bell,
    label: '讓手機收到 LINE 通知',
    blurb: '把自己的手機加進來，客人要找真人、每天早上的摘要都會傳到手機。',
    // 這一頁的進入門檻（`workspace-notify` 中介層）是 `notify.self`：觀察者進不去，也不收通知（`G-109`）
    requires: 'notify.self',
    route: wid => `/admin/${wid}/settings/line-notify`,
    steps: [
      {
        target: '[data-tour="ln-who"]',
        title: '誰會收到',
        description:
          '客人要找真人、每天早上的摘要，會用 LINE 傳到這裡每一列的手機。'
          + '還沒加進來的，按「<strong>把我的手機加進來</strong>」<strong>用手機掃一下</strong>就好；'
          // `D-117`：「狀態」那一欄併進「LINE 手機」，收不到的原因寫在名字下面那一行
          + '收不到的人，LINE 名字下面那一行會變黃、寫原因。',
        placement: 'bottom',
      },
      {
        // 2026-09-29（`D-109`）：同事不常登入後台時，管理員只能靠這一顆幫他加——以前只有成員管理那支導覽順口提過。
        // 那顆只在「有同事還沒加」而且看的人是管理員時才畫，沒有就整步跳過（這支沒有 clickBefore，前提在導航後問得到）。
        // 「是管理員」那半＝`data.canManage`，後端照 `can(role, 'notify.manage')` 算的（line-notify/index.get.ts）
        target: '[data-tour="ln-send-link"]',
        requiresPresent: '[data-tour="ln-send-link"]',
        requires: 'notify.manage',
        title: '同事不登入後台？傳連結給他',
        description:
          '還沒加進來的同事那一列有「<strong>傳連結給他</strong>」：按了會給你一條連結，用 LINE 或任何方式傳給他，'
          + '<strong>他用手機點開、按送出</strong>就加進來了，不用登入後台，這一列會自己出現他的 LINE 名字。連結有期限，過期再按一次就好。',
        placement: 'left',
      },
      {
        target: '[data-tour="ln-when"]',
        // 這一塊是 `v-if="data.canManage"`＝`notify.manage`（同上一步）
        requires: 'notify.manage',
        title: '什麼時候通知',
        description:
          '決定客人找真人時要<strong>馬上傳</strong>、還是<strong>等沒人接手才傳</strong>，以及每天幾點傳摘要。'
          + '右邊那支手機就是實際會收到的樣子，改了就存。',
        placement: 'top',
      },
    ],
  },
  /**
   * 操作紀錄（2026-09-18 `D-82` 第三批）。
   *
   * 為什麼這頁也要有：它是全站第二個「連問號都沒有」的頁（另一個是訂閱與付款，那頁拍板不做）。
   * 頁面自己的說明其實寫得好，缺的是**第一次進來時有人講一句它是幹什麼的**——
   * 而現在每一頁第一次進去都會自動跑導覽，沒有導覽的頁就是唯一不說話的那幾頁。
   * ⛔ 只給兩步：這頁是回頭查帳的地方，不是日常動線，教多了是噪音。
   */
  {
    id: 'activity',
    category: 'setup',
    // 這一頁的進入門檻（`workspace-settings` 中介層）＝`audit.read`
    requires: 'audit.read',
    icon: Document,
    label: '查「誰把什麼改成什麼」',
    blurb: '設定被改壞了、或想確認小幫手做了什麼，來這裡看。',
    route: wid => `/admin/${wid}/settings/activity`,
    steps: [
      {
        target: '[data-tour="act-list"]',
        title: '出事時先來這裡看最近動過什麼',
        description:
          '每一列是一次<strong>設定類的改動</strong>：誰、什麼時候、把什麼改成什麼。'
          + '改錯了，右邊有「<strong>還原</strong>」可以直接改回去（還原不了的會告訴你原因）。'
          + '⚠️ 這裡<strong>只記會改變系統行為的設定</strong>——日常回訊息、貼標籤不會記在這裡。',
        placement: 'top',
      },
      {
        target: '[data-tour="act-filter"]',
        title: '分得出是人改的還是小幫手做的',
        description:
          '切「<strong>小幫手代辦</strong>」只看 AI 小幫手代你執行的那些'
          + '（它做任何事之前都會先跳確認卡，按了確定才算數）。'
          + '上面還會告訴你這個月它提議了幾次、你實際按確定幾次。',
        placement: 'bottom-end',
      },
    ],
  },
]
