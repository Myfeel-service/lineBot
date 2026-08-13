/**
 * 小幫手可以「帶你去」的後台目的地白名單——單一事實來源（C-31 Phase 1）。
 *
 * 問助理回答時可附上帶路連結，但**模型永遠不生網址**：它只准從這張表挑 id
 * （鐵律「模型不生 ID，挑清單」的網址版），不在表上的 id 一律丟棄。
 * label／hint 同時餵給模型（挑目的地用）與 UI（卡片文字），一筆資料兩處用。
 *
 * 加目的地＝在這裡加一筆；path 一定要對應真實存在的頁面路由。
 */
import type { AgentMsg } from './types/agent-messages'

interface AgentDestination {
  /** 給人看的頁面名（卡片文字） */
  label: string
  /** 給模型看的一句話：這頁能做什麼、什麼問題該指過來 */
  hint: string
  path: (workspaceId: string) => string
}

export const AGENT_DESTINATIONS = {
  'conversations': {
    label: '對話',
    hint: '看客人訊息、真人回覆、送出 AI 草稿、接手／結案',
    path: wid => `/admin/${wid}/conversations`,
  },
  'ai-settings': {
    label: 'AI 設定',
    hint: 'AI 開關與回覆模式、信心門檻、轉真人通知對象、勿擾時段、商店網址',
    path: wid => `/admin/${wid}/ai-settings`,
  },
  'ai-scripts': {
    label: '自動回應與腳本',
    hint: '關鍵字自動回應、多步驟收資料的腳本、範本',
    path: wid => `/admin/${wid}/ai-scripts`,
  },
  'knowledge-sources': {
    label: '知識庫',
    hint: '匯入與管理 AI 回答用的資料、修同步失敗的來源',
    path: wid => `/admin/${wid}/knowledge/sources`,
  },
  'ai-usage': {
    label: 'AI 表現',
    hint: 'AI 回答成效、轉真人原因、答錯案例',
    path: wid => `/admin/${wid}/ai-usage`,
  },
  'conversation-stats': {
    label: '對話統計',
    hint: '每天幾場對話、AI／真人首接、沒人回的場數',
    path: wid => `/admin/${wid}/conversation-stats`,
  },
  'broadcasts': {
    label: '推播',
    hint: '群發訊息、排程、發送報表與失敗單',
    path: wid => `/admin/${wid}/broadcasts`,
  },
  'richmenu': {
    label: '圖文選單',
    hint: 'LINE 聊天室下方的選單設計與部署',
    path: wid => `/admin/${wid}/richmenu`,
  },
  'flow': {
    label: '對話模組',
    hint: '按鈕選單、圖卡等客人會點到的模組',
    path: wid => `/admin/${wid}/flow`,
  },
  'campaigns': {
    label: '活動',
    hint: '掃碼／連結活動、自動貼標、活動統計',
    path: wid => `/admin/${wid}/campaigns`,
  },
  'users': {
    label: '好友名單',
    hint: '官方帳號好友、客人標籤',
    path: wid => `/admin/${wid}/users`,
  },
  'support-presets': {
    label: '客服預存回覆',
    hint: '真人客服的罐頭回覆管理',
    path: wid => `/admin/${wid}/support-presets`,
  },
  'settings-organization': {
    label: '組織與 LINE 設定',
    hint: 'LINE 憑證（Token／Secret／LIFF）、Webhook 與 LIFF 連線檢查',
    path: wid => `/admin/${wid}/settings/organization`,
  },
  'settings-billing': {
    label: '方案與帳單',
    hint: '目前方案、AI 回覆額度、升級、發票',
    path: wid => `/admin/${wid}/settings/billing`,
  },
} as const satisfies Record<string, AgentDestination>

export type AgentDestinationId = keyof typeof AGENT_DESTINATIONS

/**
 * 把模型吐的 goto 陣列換成可渲染的站內連結卡：
 * 白名單過濾（不認得的 id 丟棄）、去重、最多 2 張——模型編不出網址，最多挑錯頁。
 */
export function resolveAgentDestinations(ids: unknown, workspaceId: string): AgentMsg[] {
  if (!Array.isArray(ids))
    return []
  const seen = new Set<string>()
  const out: AgentMsg[] = []
  for (const raw of ids) {
    const id = String(raw ?? '').trim()
    if (!Object.prototype.hasOwnProperty.call(AGENT_DESTINATIONS, id) || seen.has(id))
      continue
    seen.add(id)
    const d = AGENT_DESTINATIONS[id as AgentDestinationId]
    out.push({ kind: 'link', internal: true, label: `前往「${d.label}」`, href: d.path(workspaceId) })
    if (out.length >= 2)
      break
  }
  return out
}
