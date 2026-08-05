/**
 * 工作區「設定就緒度」共用型別。
 *
 * 後端 GET /api/admin/setup-status 依「真實資料訊號」判定每個能力是否完成，
 * 前端據此渲染健康摘要與「你哪裡沒做完」。能力的白話文文案、頁面路由、對應導覽
 * 放在前端的能力註冊表（app/composables/useSetupStatus.ts），這裡只共用 id 與狀態。
 */

export type SetupCapabilityId =
  | 'lineConnected' // 已接上 LINE 官方帳號（Token / Secret / 預設 LIFF 都有）
  | 'aiEnabled' // 已開啟 AI 自動回覆
  | 'knowledgeReady' // 知識庫已有內容
  | 'scriptReady' // 已啟用至少一支客服腳本

/**
 * 各能力的白話標題（單一事實來源）：
 * 前端能力註冊表與後台查詢助理的 get_setup_status 工具共用，兩邊講同一句話。
 */
export const SETUP_LABELS: Record<SetupCapabilityId, string> = {
  lineConnected: '接上 LINE 官方帳號',
  aiEnabled: '開啟 AI 自動回覆',
  knowledgeReady: '建立知識庫',
  scriptReady: '啟用一支客服腳本',
}

/** done=已完成；incomplete=還沒做；unknown=這次查詢失敗，狀態未知（不要當成沒做） */
export type SetupItemStatus = 'done' | 'incomplete' | 'unknown'

export interface SetupStatusItem {
  id: SetupCapabilityId
  status: SetupItemStatus
}

export interface SetupStatusResponse {
  workspaceId: string
  items: SetupStatusItem[]
}
