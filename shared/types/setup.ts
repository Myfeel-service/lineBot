/**
 * 工作區「設定就緒度」共用型別。
 *
 * 後端 GET /api/admin/setup-status 依「真實資料訊號」判定每個能力是否完成，
 * 前端據此渲染健康摘要與「你哪裡沒做完」。能力的白話文文案、頁面路由、對應導覽
 * 放在前端的能力註冊表（app/composables/useSetupStatus.ts），這裡只共用 id 與狀態。
 */

export type SetupCapabilityId =
  // 已接上 LINE 官方帳號。2026-08-21 拍板（`D-15`(b)）改口徑：不再是「憑證欄位有值」，
  // 而是真的問過 LINE——網址有設、開關有開才算。憑證貼了但 LINE 後台沒設收訊網址的帳號，
  // 以前會被判成完成、引導入口就此消失。（LIFF 另拆 liffReady）
  | 'lineConnected'
  | 'liffReady' // 已設定預設 LIFF（活動頁 / 綁定頁入口）。2026-08-07 拍板自 lineConnected 拆出：多數新客戶第一天用不到，不該擋「可以上線」
  | 'aiEnabled' // 已開啟 AI 自動回覆
  | 'knowledgeReady' // 知識庫已有內容
  | 'scriptReady' // 已啟用至少一支客服腳本
  | 'firstMessageReceived' // 曾收到任一則客人傳來的訊息（開通引導的「見證時刻」；只做訊號，不進健康卡註冊表——它沒有側欄入口可指）

/**
 * 各能力的白話標題（單一事實來源）：
 * 前端能力註冊表與後台查詢助理的 get_setup_status 工具共用，兩邊講同一句話。
 */
export const SETUP_LABELS: Record<SetupCapabilityId, string> = {
  lineConnected: '接上 LINE 官方帳號',
  liffReady: '設定 LIFF（活動頁入口）',
  aiEnabled: '開啟 AI 自動回覆',
  knowledgeReady: '建立知識庫',
  scriptReady: '啟用一支客服腳本',
  firstMessageReceived: '收到第一則客人訊息',
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
