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
}
