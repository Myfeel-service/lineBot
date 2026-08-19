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
  /** 一般泡泡。html 僅限劇本文案 + 已跳脫的使用者輸入 */
  | { kind: 'text'; html: string }
  /** 圖解步驟卡（「怎麼拿？」）：一步一格、可配示意圖；href 給可直接點開的入口（別讓使用者自己打網址） */
  | { kind: 'help'; summary: string; steps: AgentHelpStep[]; href?: string; hrefLabel?: string }
  /** 連結卡。internal＝站內頁（走 NuxtLink 同分頁導航）；否則視為外部連結另開分頁 */
  | { kind: 'link'; label: string; href: string; internal?: boolean }
  /**
   * 單張示意圖卡（節點式教學「一步一張圖」用；也吃循環動畫 webp）。
   * 檔案載不到就整張不顯示——不破圖，所以劇本可以先接圖、截圖之後補檔。
   */
  | { kind: 'image'; src: string; alt: string }
  /** 一鍵複製卡（例：Webhook 網址） */
  | { kind: 'copy'; label: string; value: string }
  /** 進行中/成功/失敗/略過 狀態卡。skipped 是使用者的正當選擇，語意中性——別用 fail 的警告色裝它 */
  | { kind: 'status'; state: 'pending' | 'ok' | 'fail' | 'skipped'; text: string }
  /** 強調卡：回顯收到的第一則訊息（見證時刻） */
  | { kind: 'highlight'; label: string; title: string; meta?: string }
  /** 完成摘要卡 */
  | { kind: 'summary'; items: { label: string; done: boolean; note?: string }[] }

export interface AgentChatEntry {
  /** 遞增流水號，當 v-for key */
  id: number
  role: 'agent' | 'user'
  msg: AgentMsg
}

export interface AgentChoice {
  label: string
  value: string
  /** 主要動作（填色按鈕），一組選項最多一顆 */
  primary?: boolean
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
