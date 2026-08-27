/**
 * 小幫手「問助理」工具 id 與 UI 顯示名——單一事實來源。
 *
 * server 的工具註冊表(ai-admin-agent.ts TOOLS)與前端「查了:○○」標籤
 * (AdminAgentChat.vue)都用 AdminAgentToolId 索引:加工具時漏了任何一邊,
 * typecheck 直接紅。之前是前端手寫第二份對照表,08-06 加 get_conversation_stats
 * 就漏了標籤(UI 會直接顯示英文工具名)——這正是兩份表遲早漂移的實證。
 */
export const ADMIN_AGENT_TOOL_LABELS = {
  list_scripts: '客服流程清單',
  get_ai_settings: 'AI 設定',
  get_ai_usage: 'AI 用量',
  get_conversation_stats: '對話統計',
  get_knowledge_status: '知識庫',
  list_auto_responses: '自動回應設定',
  get_current_alerts: '目前異常',
  get_setup_status: '設定進度',
} as const satisfies Record<string, string>

export type AdminAgentToolId = keyof typeof ADMIN_AGENT_TOOL_LABELS
