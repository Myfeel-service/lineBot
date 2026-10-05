/**
 * 小幫手可以「帶你走一遍」的教材白名單（`D-109`，2026-09-29）。
 *
 * 為什麼要有：問助理「圖文選單怎麼設」，以前只拿得到一段文字加一個頁面連結——
 * 教材明明就在隔壁「教學」分頁（25 支導覽、8 支劇本），聊天這條路卻叫不出來；
 * 那一頁的自動導覽看過一次就不會再跑，連結點過去也沒有人教。
 * 現在回答可以附一張「帶我走一遍」卡，按下去直接開那支導覽或劇本。
 *
 * 規矩同 `agent-destinations.ts`（模型不生網址）：**模型只准從這張表挑 id**，
 * 不認得的一律丟掉；`ref` 由這裡決定，模型碰不到。
 * ⛔ `ref` 必須是 `app/utils/tutorial-topics.ts`（tour）或 `app/utils/agent-guides.ts`（guide）
 *    裡真的有的 id——由 `agent-teachings.test.ts` 讀那兩支檔案比對，改名／拿掉沒同步會紅。
 * ⛔ 卡片上的字**不寫在這裡**：導覽名稱由前端照 tutorial-topics 的 label 顯示，
 *    這裡只放給模型挑用的 `hint`——教材名只有一份，改名不用改兩處。
 */
import type { AgentMsg } from './types/agent-messages'
import type { WorkspaceMemberRole } from './types/organization'
import type { Capability } from './permissions'
import { can } from './permissions'

export type AgentTeachKind = 'tour' | 'guide' | 'status'

interface AgentTeaching {
  kind: AgentTeachKind
  /** tour＝tutorial-topics 的 id；guide＝agent-guides 的 id；status＝固定 'setup'（展開小幫手最上面那一條「目前狀況」，`D-114` 前是分頁） */
  ref: string
  /** 給模型看的一句話：什麼問題該給這一支 */
  hint: string
  /**
   * 要有這項能力才給卡：跑不動的人不給（按了才說沒權限＝死路）。
   * `G-109`：填那支導覽主題的 `requires`（同一項能力）；主題沒填的，填**那一頁**的進入門檻——
   *    例如測試對話的導覽沒有條件，但觀察者根本進不去那一頁（`playground.use`＝客服）。
   *    劇本填它要人做的那件事打的端點用的能力。不填＝誰都拿得到。
   */
  requires?: Capability
}

export const AGENT_TEACHINGS = {
  // ── 導覽：在真實畫面上一步步高亮 ──────────────────────────────
  'tour-overview': { kind: 'tour', ref: 'overview', hint: '第一次用、不知道東西放在哪：整個後台的地圖' },
  'tour-conversations': { kind: 'tour', ref: 'conversations', hint: '怎麼看客人訊息、接手、交還、結束對話、直接回覆' },
  'tour-conversation-stats': { kind: 'tour', ref: 'conversation-stats', hint: '對話統計那些數字怎麼看、怎麼選日期與匯出' },
  'tour-flow': { kind: 'tour', ref: 'flow', hint: '機器人模組是什麼、怎麼新增一組要回給客人的訊息', requires: 'marketing.write' },
  'tour-msg-basic': { kind: 'tour', ref: 'msg-basic', hint: '模組裡怎麼加文字、圖片、影片', requires: 'marketing.write' },
  'tour-msg-rich': { kind: 'tour', ref: 'msg-rich', hint: '圖文訊息（一張大圖切成多個可點區塊）怎麼填', requires: 'marketing.write' },
  'tour-msg-carousel': { kind: 'tour', ref: 'msg-carousel', hint: '輪播訊息（多張卡左右滑）怎麼填', requires: 'marketing.write' },
  'tour-msg-quick': { kind: 'tour', ref: 'msg-quick', hint: '快速回覆（訊息下面一排建議按鈕）怎麼填', requires: 'marketing.write' },
  'tour-msg-userinput': { kind: 'tour', ref: 'msg-userinput', hint: '用戶輸入卡：問客人問題、收他的答案', requires: 'marketing.write' },
  'tour-richmenu': { kind: 'tour', ref: 'richmenu', hint: '建立或修改 LINE 聊天室下方的圖文選單、設為預設', requires: 'marketing.write' },
  'tour-support-presets': { kind: 'tour', ref: 'support-presets', hint: '客服預存（常用回覆）怎麼建、順手貼標籤', requires: 'presets.write' },
  'tour-ai-scripts': { kind: 'tour', ref: 'ai-scripts', hint: '建第一條自動回應：客人說什麼就自動回什麼、關鍵字怎麼比對、客人加好友時要回什麼', requires: 'scripts.write' },
  'tour-ai-scripts-flow': { kind: 'tour', ref: 'ai-scripts-flow', hint: '多步驟的自動回應：問客人資料、答不出來的退路、依答案分流、試跑整條（預約、報名、退貨）', requires: 'scripts.write' },
  'tour-users': { kind: 'tour', ref: 'users', hint: '好友名單、依標籤篩選、批次貼標', requires: 'customers.write' },
  'tour-friend-stats': { kind: 'tour', ref: 'friend-stats', hint: '好友統計怎麼看：產生報告、「做過什麼」跟「想要什麼」差在哪、誰還沒被貼到' },
  'tour-tags': { kind: 'tour', ref: 'tags', hint: '建好友標籤、從範本建、英文代號怎麼取', requires: 'tags.write' },
  'tour-campaigns': { kind: 'tour', ref: 'campaigns', hint: '活動標籤：用一條連結收名單、加好友自動貼標', requires: 'marketing.write' },
  'tour-broadcasts': { kind: 'tour', ref: 'broadcasts', hint: '發推播：選對象、寫內容、排程、發送前確認、看成效', requires: 'broadcast.write' },
  'tour-ai-usage': { kind: 'tour', ref: 'ai-usage', hint: 'AI 表現頁怎麼看：全程搞定率、答不出來的案例、補知識' },
  'tour-knowledge': { kind: 'tour', ref: 'knowledge', hint: '把資料放進知識庫：上傳檔案、貼網址或試算表、先預覽再匯入', requires: 'knowledge.write' },
  'tour-knowledge-manage': { kind: 'tour', ref: 'knowledge-manage', hint: '匯入之後怎麼整理知識：資料夾、改某一條、自動同步', requires: 'knowledge.write' },
  // 主題沒設條件，照頁面：測試對話頁的進入門檻（`ai-feature` 中介層）
  'tour-ai-playground': { kind: 'tour', ref: 'ai-playground', hint: '上線前先試問 AI 會怎麼回答（不會送給客人）', requires: 'playground.use' },
  'tour-ai-settings': { kind: 'tour', ref: 'ai-settings', hint: '打開 AI 自動回覆、選回覆模式、服務時間、自動交還', requires: 'ai.settings.write' },
  'tour-members': { kind: 'tour', ref: 'members', hint: '邀請同事、角色權限差在哪', requires: 'members.manage' },
  // 主題沒設條件，照頁面：LINE 通知頁的進入門檻（客服可以加／退自己，`D-103`）
  'tour-line-notify': { kind: 'tour', ref: 'line-notify', hint: '把手機加進 LINE 通知、什麼時候通知', requires: 'notify.self' },
  'tour-organization': { kind: 'tour', ref: 'organization', hint: '把 LINE 官方帳號接上系統：Token、Secret、Webhook、測試連線', requires: 'line.manage' },
  'tour-activity': { kind: 'tour', ref: 'activity', hint: '查誰改了什麼設定、還原、看小幫手代辦過什麼', requires: 'audit.read' },
  // ── 劇本：跑在小幫手面板裡，做完會真的檢查有沒有生效 ─────────────
  // （填劇本要人做的那件事打的端點：匯入知識、重抓來源、自己的通知狀態、修壞掉的模組、LINE／LIFF 設定）
  'guide-knowledge-first': { kind: 'guide', ref: 'knowledge-first', hint: '陪你放進第一份知識，並確認 AI 真的答得出來', requires: 'knowledge.write' },
  'guide-knowledge-sync': { kind: 'guide', ref: 'knowledge-sync', hint: '知識庫資料同步失敗、網址或試算表抓不到', requires: 'sources.write' },
  'guide-handoff-notify': { kind: 'guide', ref: 'handoff-notify', hint: '手機收不到客人找真人或每天早上摘要的通知', requires: 'notify.self' },
  'guide-broken-module': { kind: 'guide', ref: 'broken-module', hint: '客人按了選單或按鈕沒反應', requires: 'marketing.write' },
  'guide-line-webhook': { kind: 'guide', ref: 'line-webhook', hint: 'LINE 收不到客人訊息、機器人完全沒反應（Webhook 沒接好）', requires: 'line.manage' },
  'guide-line-channel': { kind: 'guide', ref: 'line-channel', hint: '同一個官方帳號同時接在別的系統上', requires: 'line.manage' },
  'guide-liff-setup': { kind: 'guide', ref: 'liff-setup', hint: '第一次設定活動頁（LIFF），要辦活動收名單時', requires: 'line.manage' },
  'guide-liff-endpoint': { kind: 'guide', ref: 'liff-endpoint', hint: '活動連結打不開、客人綁定失敗', requires: 'line.manage' },
  // ── 目前狀況：異常清單＋一鍵修好的按鈕都在這裡（小幫手最上面那一條，展開就看得到）──
  'panel-status': { kind: 'status', ref: 'setup', hint: '現在有什麼要處理、哪裡壞了——那裡每一件都附「帶我修好」或一鍵修的按鈕' },
} as const satisfies Record<string, AgentTeaching>

export type AgentTeachingId = keyof typeof AGENT_TEACHINGS

/** 給 prompt 用的清單：只列這個角色跑得動的（⛔ 列了跑不動的，模型就會推一張按了是死路的卡） */
export function agentTeachingCatalogueForPrompt(role: WorkspaceMemberRole): string {
  return (Object.entries(AGENT_TEACHINGS) as [AgentTeachingId, AgentTeaching][])
    .filter(([, t]) => !t.requires || can(role, t.requires))
    .map(([id, t]) => `- ${id}：${t.hint}`)
    .join('\n')
}

/**
 * 把模型挑的 id 換成一張「帶我走一遍」卡：白名單過濾＋角色過濾，最多 1 張。
 * ⛔ 只給一張：同時給兩支導覽，他只能跑一支，另一張是雜訊。
 */
export function resolveAgentTeaching(raw: unknown, role: WorkspaceMemberRole): AgentMsg[] {
  const id = String(raw ?? '').trim()
  if (!id || !Object.prototype.hasOwnProperty.call(AGENT_TEACHINGS, id))
    return []
  const t: AgentTeaching = AGENT_TEACHINGS[id as AgentTeachingId]
  if (t.requires && !can(role, t.requires))
    return []
  return [{ kind: 'teach', teach: t.kind, ref: t.ref }]
}
