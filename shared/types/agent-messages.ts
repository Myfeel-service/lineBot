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

export type AgentMsg =
  /** 一般泡泡。html 僅限劇本文案 + 已跳脫的使用者輸入 */
  | { kind: 'text'; html: string }
  /** 「怎麼拿？」展開式小教學；href 給可直接點開的入口（別讓使用者自己打網址） */
  | { kind: 'help'; summary: string; steps: string[]; href?: string; hrefLabel?: string }
  /** 外部連結卡（另開分頁） */
  | { kind: 'link'; label: string; href: string }
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
    /** 顯示「先跳過」 */
    skippable?: boolean
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
