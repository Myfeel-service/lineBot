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
import {
  Box, ChatDotRound, ChatLineSquare, Connection, DataLine, EditPen, Files,
  FolderOpened, Grid, Lightning, MagicStick, Monitor, OfficeBuilding, Operation,
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
   * 這一步要指的東西只有「能操作的人」（agent 以上）畫面上才有——觀察者根本沒有那顆按鈕，
   * 不跳過的話他會看到一句「這一步要指的位置目前不在畫面上」。
   */
  requiresOperate?: boolean
  /** 同上，但限 owner/admin（例：側欄的「設定」那一段） */
  requiresSettings?: boolean
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
  /** 需要 owner/admin（設定類：組織、成員、AI 設定、腳本）才顯示 */
  requiresSettings?: boolean
  /** 需要操作權限（agent 以上，排除觀察者）的建立/編輯類教學才顯示 */
  requiresOperate?: boolean
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
        // 這一段沒有小標（它是第一段），太高就退去指第一列
        targetTooTallFallback: '.nav-group[data-tour="nav-group-daily"] .nav-item',
        title: '每天的工作都在這一段',
        description:
          '客人傳來的訊息在<strong>客服對話</strong>；要主動發訊息給一群人用<strong>推播</strong>；'
          + '客人在 LINE 看到的選單、以及自動回覆，也都在這一段設定。',
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
        requiresSettings: true,
      },
      {
        target: '[data-tour="ta-fab"]',
        title: '有問題，先看右下角的小幫手',
        description:
          '哪裡壞了、下一步要做什麼，它會<strong>主動說</strong>。點開還能找到所有教學，也可以直接問它問題。',
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
          + '之後想再看，從這裡或右下角小幫手的「教學」分頁都找得到。',
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
    requiresSettings: true,
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
        title: '填預設 LIFF（選填，活動頁用）',
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
        target: '[data-tour="org-verify"]',
        title: '測試有沒有通',
        description:
          '按「<strong>測試連線</strong>」用現在的 Token 問 LINE，確認網站連得到、驗簽過。測試有額度，別狂按。',
        placement: 'top',
      },
      {
        target: '[data-tour="org-save"]',
        title: '儲存',
        description:
          '最後按右上角「<strong>儲存</strong>」。系統會順手再驗一次 Webhook。看到成功提示就完成囉',
        placement: 'bottom-end',
      },
    ],
  },
  {
    id: 'ai-settings',
    category: 'ai',
    requiresSettings: true,
    icon: MagicStick,
    label: '開啟 AI 自動回覆',
    blurb: '把 AI 客服打開、選好回覆模式與語氣、設好轉真人通知。',
    route: wid => `/admin/${wid}/ai-settings`,
    steps: [
      {
        target: '[data-tour="ais-toggle"]',
        title: '打開總開關',
        description:
          '先把「<strong>啟用 AI 自動回覆</strong>」打開——關著的話，知識庫和客服流程都不會生效。下面的「回覆模式」<strong>新導入建議先選「草稿」</strong>跑一兩週：AI 只給客服建議、不直接回客人，穩了再切「全自動」。',
        placement: 'right',
      },
      {
        target: '[data-tour="ais-style"]',
        title: '調回答風格',
        description:
          '在這裡設定 AI 的<strong>語氣與人設</strong>，讓它講話像你們品牌。可以直接套用預設風格，或自己微調。',
        placement: 'right',
      },
      {
        target: '[data-tour="ais-handoff"]',
        title: '設定轉真人通知',
        description:
          'AI 答不上來、或客人指名要找真人時，對話會<strong>轉給真人</strong>。這裡設定要<strong>用 LINE 通知哪些客服</strong>——不設的話沒有人會知道有客人在等，很容易漏接。收通知的人要先加你的官方帳號好友。',
        placement: 'top',
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
    requiresOperate: true,
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
      {
        target: '[data-tour="kb-drop"]',
        clickBefore: '[data-tour="kb-import"]',
        title: '丟進來就好，不用先選種類',
        description:
          '把檔案拖進框裡，或貼上<strong>網址、試算表連結、一段文字</strong>——系統會自己認出是什麼。<strong>手邊還沒有現成資料的話，框下面有三條路可以照著做</strong>；貼上之後視窗也會就地講該注意什麼。',
        placement: 'bottom',
      },
      {
        target: '[data-tour="kb-preview"]',
        title: '先看 AI 整理的結果再匯入',
        description:
          '按這裡，AI 會先<strong>切好知識給你預覽</strong>：可以逐條改、取消不要的，確認才匯入——<strong>不會直接上線亂答</strong>。',
        placement: 'top',
      },
    ],
  },
  {
    id: 'knowledge-manage',
    category: 'ai',
    requiresOperate: true,
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
      {
        target: '[data-tour="kb-folder-new"]',
        title: '資料變多了，用資料夾分類',
        description:
          '資料一多就會找不到。點上方<strong>新資料夾</strong>按鈕開資料夾（例如：商品、退換貨、活動），再把資料<strong>拖進去</strong>歸類。這只是後台整理方便你找，不影響 AI 回答。',
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
          '網址與 Google 試算表來的資料，系統會<strong>定期自動重讀</strong>：小改動自動套用並通知你，改動大會先列出差異讓你確認。<strong>你親手改過的一律保留</strong>。等不及就按右上「<strong>重新同步</strong>」。（檔案和手打的不會自動更新，改了要重新匯入。）',
        placement: 'left',
      },
      {
        target: '',
        title: '知識庫體檢會幫你盯',
        description:
          '知識庫有狀況時，資料列表<strong>上方會出現「知識庫體檢」橫幅</strong>：同步失敗的資料、內容太短的卡、到期被自動停用的卡，都會列在那裡。<strong>點分類就直接列出要處理的那幾筆</strong>，照著修完就好——不用自己一張張翻。',
      },
    ],
  },
  {
    id: 'ai-scripts',
    category: 'ai',
    requiresSettings: true,
    icon: Operation,
    label: '建立客服流程',
    blurb: '客服流程把多步驟的問答自動化（預約、報名…）。帶你開第一條。',
    route: wid => `/admin/${wid}/ai-scripts`,
    steps: [
      {
        target: '[data-tour="scr-new"]',
        title: '新增一條客服流程',
        description:
          '客服流程能把固定的接待步驟自動化，例如<strong>預約、報名、領優惠</strong>。點「<strong>新增</strong>」開一條新的。',
        placement: 'right',
      },
      {
        target: '[data-tour="scr-ai-gen"]',
        title: '用一句話讓 AI 幫你搭',
        description:
          '不想從空白開始？在這裡<strong>用一句話描述流程</strong>（例：客人要退貨時，先問訂單編號和原因，再請專員處理），AI 就會幫你搭好整條流程草稿。<strong>生成後會先進編輯器讓你檢查</strong>，按「建立客服流程」才會存檔。',
        placement: 'top',
      },
      {
        target: '[data-tour="scr-templates"]',
        title: '從範本開始也行',
        description:
          '也可以挑一個<strong>範本</strong>，系統幫你把流程骨架建好再改。建立後記得把狀態切成「<strong>啟用</strong>」才會對客人生效。',
        placement: 'top',
      },
    ],
  },
  {
    id: 'ai-playground',
    category: 'ai',
    icon: Monitor,
    label: '試一下 AI 怎麼回答',
    blurb: '上線前先試答幾題，確認 AI 答得對。',
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
          '在這裡打客人可能會問的問題，按「<strong>送出</strong>」看 AI 怎麼答。多試幾題刁鑽的；確認答得穩，再到 AI 設定切「全自動」上線。',
        placement: 'top',
      },
    ],
  },
  {
    id: 'ai-usage',
    category: 'ai',
    requiresSettings: true,
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
          '最大的數字是<strong>全程搞定率</strong>：AI 接的對話裡，有幾成從頭到尾沒用到真人。彩色長條把 AI 接的場拆成<strong>全程搞定／用到真人</strong>兩段，下面那句灰框會直接告訴你現在算不算好、接下來做什麼。',
        placement: 'bottom',
      },
      {
        target: '[data-tour="usg-cases"]',
        title: '答不出來的就地補知識',
        description:
          '這裡列出<strong>客人問了但 AI 答不出來</strong>的案例。點某筆的「<strong>補知識</strong>」會直接跳到知識庫、幫你補一張對應的卡——這是持續把 AI 養好的關鍵動作。',
        placement: 'top',
      },
      {
        target: '[data-tour="usg-period"]',
        title: '切換統計區間',
        description:
          '在這裡換<strong>統計區間</strong>（本月／上月…），上面所有數字會跟著重算，方便你比較不同時期的表現。',
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
        requiresOperate: true,
      },
      {
        target: '[data-tour="conv-messages"]',
        requiresPresent: '.conv-list-row .split-list-item',
        title: 'AI 回的話，可以問它「為什麼」',
        description:
          'AI 回覆的泡泡下面有「<strong>為什麼這樣答</strong>」，點開看得到它根據哪幾則資料回的；'
          + '答得不對就在那裡標「這題 AI 答錯了」——<strong>標了會收進小幫手的待辦清單</strong>，之後補資料時就知道要補什麼。',
        placement: 'left',
      },
      {
        target: '[data-tour="conv-reply"]',
        requiresPresent: '.conv-list-row .split-list-item',
        title: '直接在這裡回覆',
        description:
          'Enter 送出、Shift + Enter 換行。你送出的訊息會即時進到客人的 LINE。',
        placement: 'top',
        requiresOperate: true,
      },
      {
        target: '[data-tour="conv-presets"]',
        requiresPresent: '.conv-list-row .split-list-item',
        title: '常用回覆不用每次重打',
        description:
          '📦 是<strong>客服預存</strong>：挑一則就能直接送出，也可以先填進回覆框改幾個字再送。'
          + '要新增或修改預存內容，去側欄的「客服預存」。',
        placement: 'top',
        requiresOperate: true,
      },
    ],
  },
  {
    id: 'flow',
    category: 'bot',
    requiresOperate: true,
    icon: Connection,
    label: '認識機器人模組',
    blurb: '一種一種帶你看：每介紹一個就先幫你選到它的實際畫面。',
    route: wid => `/admin/${wid}/flow`,
    steps: [
      {
        target: '[data-tour="flow-title"]',
        title: '模組是「要回什麼」的積木',
        description:
          '一個模組 = 一組要回給客人的訊息。上面兩個是<strong>系統模組</strong>（一定在、不能刪），下面是你自己加的。接下來我一個一個帶你看',
        placement: 'right',
      },
      {
        target: '[data-tour="flow-type"]',
        clickBefore: '[data-tour="flow-sys-welcome"]',
        title: '歡迎模組',
        description:
          '我幫你選到「<strong>歡迎模組</strong>」了。它在客人<strong>加好友的當下</strong>自動發第一組訊息——通常放品牌介紹、優惠或常見問答入口。系統內建，你只要編內容。',
        placement: 'bottom',
      },
      {
        target: '[data-tour="flow-type"]',
        clickBefore: '[data-tour="flow-sys-live_agent"]',
        title: '真人客服',
        description:
          '這是「<strong>真人客服</strong>」模組。當對話<strong>轉給真人</strong>時會發這組訊息——例如「已為您轉接專人，請稍候」。一樣系統內建，編好內容即可。',
        placement: 'bottom',
      },
      {
        target: '[data-tour="flow-type"]',
        clickBefore: '[data-tour="flow-new"]',
        title: '你自己加的兩種',
        description:
          '我幫你按了「新增」進入。你能建的有兩種，在這裡選：<strong>機器人流程</strong>（一般自動回覆，最常用）、<strong>系統通知</strong>（公告型訊息）。先取個名再選類型。',
        placement: 'bottom',
      },
      {
        target: '[data-tour="flow-messages"]',
        title: '加要回的訊息',
        description:
          '不管哪種模組，內容都在這排按鈕加：點一下就多一則回覆，想回幾則都行。<strong>每種訊息怎麼填</strong>，主選單有「基本訊息」和各種訊息類型的專屬教學可以跑。',
        placement: 'bottom',
      },
      {
        target: '',
        title: '什麼時候會回？',
        description:
          '模組只管「<strong>回什麼</strong>」；「<strong>什麼時候回</strong>」要另外綁：到「<strong>自動回覆</strong>」用關鍵字指向這個模組（歡迎模組例外，加好友時自動發）。編好按右上「<strong>建立／儲存</strong>」就生效',
      },
    ],
  },
  {
    id: 'msg-basic',
    category: 'bot',
    requiresOperate: true,
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
    requiresOperate: true,
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
    requiresOperate: true,
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
    requiresOperate: true,
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
    requiresOperate: true,
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
    requiresOperate: true,
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
        description:
          '打開的話，<strong>新加好友會自動顯示</strong>這個選單。一個帳號同時只會有一個預設選單。',
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
          '上傳背景圖後，下方會出現「<strong>區塊設定</strong>」：幫每一個區塊綁一個動作——<strong>開網址、傳訊息、觸發模組、切換到另一個選單</strong>都行。',
      },
      {
        target: '[data-tour="rm-save"]',
        title: '建立',
        description: '都填好後按右上「<strong>建立圖文選單</strong>」就生效',
        placement: 'bottom-end',
      },
    ],
  },
  {
    id: 'broadcasts',
    category: 'growth',
    requiresOperate: true,
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
          '點「<strong>新增</strong>」：寫內容、選對象（可用標籤篩選名單），還能<strong>排程</strong>定時發送。',
        placement: 'right',
      },
    ],
  },
  {
    id: 'tags',
    category: 'growth',
    requiresOperate: true,
    icon: PriceTag,
    label: '建立好友標籤',
    blurb: '標籤把好友分群，之後推播、活動都能鎖定分眾。帶你建第一個。',
    route: wid => `/admin/${wid}/tags`,
    steps: [
      {
        target: '[data-tour="tag-new"]',
        title: '標籤用來分眾',
        description:
          '標籤是把好友<strong>分群</strong>的基礎——貼了標籤，之後<strong>推播</strong>就能只發給某群人、<strong>活動</strong>也能自動貼標歸類。點右上「<strong>新增標籤</strong>」建第一個。',
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
    requiresOperate: true,
    icon: Tickets,
    label: '活動貼標（名單分眾）',
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
          '設定這波活動的名單，加好友時要<strong>自動貼上哪些標籤</strong>——至少選一個。（還沒有標籤的話，先去「<strong>標籤管理</strong>」建，再回來這裡。）',
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
  {
    id: 'users',
    category: 'growth',
    requiresOperate: true,
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
  {
    id: 'support-presets',
    category: 'growth',
    requiresOperate: true,
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
        description:
          '點「<strong>新增</strong>」設好內容。只有切「<strong>啟用</strong>」的預存，才會出現在對話頁的選單。',
        placement: 'right',
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
        title: '選日期範圍與統計單位',
        description:
          '選<strong>日期範圍</strong>和統計單位（<strong>日／週／月</strong>），下面的數字會跟著變；右邊可「<strong>匯出報表</strong>」存成 Excel 檔。',
        placement: 'bottom',
      },
      {
        target: '[data-tour="cs-kpi"]',
        title: '看關鍵數字',
        description:
          '這排是重點：總對話數、<strong>機器人先接住的比例</strong>（客人第一句就由 AI 回答）、轉真人和結案的比例——看 AI 幫你分擔了多少、哪裡還要再補知識或客服流程。',
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
    requiresSettings: true,
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
          '點「<strong>邀請成員</strong>」輸入 Email——對方<strong>不用先註冊</strong>，等他建帳號首次登入就自動生效。',
        placement: 'bottom-end',
      },
    ],
  },
]
