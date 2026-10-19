/**
 * 超管「全站異常總覽」的回傳合約（C-91）。
 * 端點 server/api/admin/super/alerts-overview.get.ts 與前端 useSuperAlerts 共用——
 * ⛔別在前端重新宣告一份 shape（C-87 code review 抓過同款）。
 */
import type { WorkspaceAlertItem } from './alerts'
import type { UsageRatioVerdict } from '../billing/usage-ratio'

export interface SuperAlertsWorkspace {
  id: string
  name: string
  /** 只含非 clear 的（active/unknown）——健康項不佔 payload */
  items: WorkspaceAlertItem[]
  /** 這個租戶總共檢查了幾項（clear 數＝probedCount − items.length） */
  probedCount: number
  usage: UsageRatioVerdict
}

export interface SuperAlertsOverviewPayload {
  checkedAt: number
  /** 排程心跳：unknown＝心跳文件不存在（本機／還沒部署過排程），不下結論 */
  heartbeat: {
    state: 'ok' | 'stalled' | 'unknown'
    lastRunAt: number | null
    ageMinutes: number | null
  }
  workspaces: SuperAlertsWorkspace[]
  /** 租戶數撞掃描上限＝有帳號沒被檢查到（誠實回報，不做靜默截斷） */
  truncated: boolean
  /**
   * 還沒有人回覆的潛在客戶數（demoLeads status='new'；D-43②，2026-08-31）。
   * 官網留了資料的真實客戶原本零提醒——側欄「潛在客戶名單」連一顆點都沒有，
   * 超管要自己想到才會開那一頁。null＝這次查不到（⛔不等於 0，前端不畫點也不畫綠）。
   */
  newLeads: number | null
  /**
   * 同事在對話上標「資料沒錯，是 AI 弄錯了」、還沒處理的（`D-136`，2026-10-19）：知識庫改不了，要我們修系統。
   * 以前畫面說「記下來了」，卻沒有任何地方會再出現。null＝這次查不到（⛔不等於沒有）
   */
  aiMistakes: SuperAiMistake[] | null
  /**
   * 客人傳的圖讀不出來（`C-164`，2026-10-19）：AI 讀了圖、交回來的格式壞掉（訊息上 `mediaReadState='malformed'`）。
   * 這是我們系統壞掉、店家修不了（`D-44`），所以只列在這裡、不進店家的小幫手。
   * `C-163` 那次從 8/17 壞到 9/6、45 張圖中鏢，全程沒有人知道。null＝這次查不到（⛔不等於沒有）
   */
  imageReadFailures: SuperImageReadFailures | null
}

export interface SuperImageReadFailures {
  /** 看最近幾天 */
  windowDays: number
  /** 這段期間讀不出來的總張數（truncated 時是下限） */
  total: number
  /** 撞到讀取上限：更早的沒算進來（誠實回報，不靜默截斷） */
  truncated: boolean
  /**
   * 近 24 小時內最密的那一小時有 3 張以上＝不像偶發、是真的壞了（側欄點變紅）。
   * 全站一起算不分帳號：讀圖壞掉是系統的事，三個帳號各一張跟同一個帳號三張是同一件事。null＝沒有
   */
  burst: { count: number, startMs: number, endMs: number } | null
  /** 每個帳號一列，最近出事的在前 */
  workspaces: SuperImageReadFailureRow[]
}

export interface SuperImageReadFailureRow {
  /** 空字串＝訊息上沒記帳號（舊資料），列出來但點不進對話 */
  workspaceId: string
  workspaceName: string
  count: number
  lastAtMs: number
  /** 最近那一張所在的對話文件 id：`/admin/<工作區>/conversations?userId=` 直接開那段 */
  lastConversationId: string
}

export interface SuperAiMistake {
  /** 回饋事件 id（標「處理好了」用） */
  id: string
  workspaceId: string
  workspaceName: string
  /** 對話文件 id：`/admin/<工作區>/conversations?userId=` 直接開那段 */
  userId: string
  query: string
  createdAtMs: number
}
