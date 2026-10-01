/**
 * 小幫手的「出場時機」（`D-112`，2026-10-01 老闆拍板照建議做）：
 * 在哪一頁就列那一頁它能直接做的事、改完要回到哪一頁亮哪一塊——單一事實來源。
 *
 * 為什麼要有：小幫手能代辦 15 件事，但以前開場的四個建議全是查詢、每頁一樣，
 * 「做」只寫在一行灰色括號裡，大家想不起來用它（報告 `docs/AGENT-DISCOVERABILITY-EVAL-20261001.md`）。
 *
 * ⛔ 三條紀律：
 * 1. **建議只從 15 件代辦裡挑**（`op` 一定要對得上 `ADMIN_OP_LABELS`，測試釘住）——
 *    讓模型自己想「下一步建議」會建議出它做不到的事（Cisco 踩過；AI 生成腳本那輪也定過同一條）。
 * 2. **「做」的建議按了只放進輸入框，不直接送出**：裡面的「運費」「80 元」是範例不是他的規則，
 *    直接送出等於替他講了一句他沒講過的話。「查」的建議沒有副作用，按了就送。
 * 3. **權限照代辦本身的門檻篩**（`ADMIN_OP_CAPABILITY`，與 `server/utils/admin-ops.ts` 每一筆的
 *    `capability` 由測試釘成同一份）：觀察者看到一排他按了只會被拒絕的建議，比沒有更糟。
 */
import type { Capability } from './permissions'
import { ADMIN_OP_LABELS, type AdminOpId } from './types/admin-ops'

/** 代辦改完的結果住在哪一頁（側欄上的那一頁） */
export type AgentOpPage = 'ai-scripts' | 'broadcasts' | 'tags' | 'knowledge' | 'ai-settings' | 'line-notify'

/** 頁名照側欄的字（⛔ 不自己另取一個名字，他在側欄上找不到） */
export const AGENT_OP_PAGE_LABEL: Record<AgentOpPage, string> = {
  'ai-scripts': '自動回應',
  'broadcasts': '推播',
  'tags': '標籤管理',
  'knowledge': '知識庫',
  'ai-settings': 'AI 設定',
  'line-notify': 'LINE 通知',
}

/**
 * 每件代辦改完要去哪裡看。
 * - `section`：那一頁上的哪一塊（頁面用 `data-agent-target="<section>"` 標出來）。
 * - 沒有 `section` 的：改的是清單裡的某一筆，那一筆的 id 由執行結果的 `targetId` 帶回來。
 */
export const ADMIN_OP_TARGET: Record<AdminOpId, { page: AgentOpPage, section?: string }> = {
  'ai-settings-service-hours': { page: 'ai-settings', section: 'service-hours' },
  'script-set-enabled': { page: 'ai-scripts' },
  // 2026-09-27 `C-270` 起這一格住在「設定 → LINE 通知」，不在 AI 設定頁
  'ai-settings-handoff-sla': { page: 'line-notify', section: 'handoff-sla' },
  'ai-settings-sensitive-topic': { page: 'ai-settings', section: 'sensitive-topics' },
  // 總開關與回覆模式在同一張卡上
  'ai-settings-reply-mode': { page: 'ai-settings', section: 'ai-toggle' },
  'script-create-from-description': { page: 'ai-scripts' },
  'broadcast-draft-create': { page: 'broadcasts' },
  'ai-settings-enabled': { page: 'ai-settings', section: 'ai-toggle' },
  // 這兩格收在「進階調校」裡（頁面要先展開才看得到）
  'ai-settings-handback-idle': { page: 'ai-settings', section: 'handback' },
  'ai-settings-auto-close': { page: 'ai-settings', section: 'handback' },
  'ai-settings-tone-template': { page: 'ai-settings', section: 'tone' },
  'tag-create': { page: 'tags' },
  'knowledge-draft-create': { page: 'knowledge' },
  'script-update-keyword': { page: 'ai-scripts' },
  'script-update-reply': { page: 'ai-scripts' },
}

/**
 * 每件代辦的執行門檻（畫面篩建議用）。⛔ 權威在後端每一筆 op 的 `capability`；
 * 這份是給前端讀的影本，`server/utils/admin-ops.test.ts` 釘住兩邊一字不差。
 */
export const ADMIN_OP_CAPABILITY: Record<AdminOpId, Capability> = {
  'ai-settings-service-hours': 'ai.settings.write',
  'script-set-enabled': 'scripts.write',
  'ai-settings-handoff-sla': 'ai.settings.write',
  'ai-settings-sensitive-topic': 'ai.settings.write',
  'ai-settings-reply-mode': 'ai.settings.write',
  'script-create-from-description': 'scripts.write',
  'broadcast-draft-create': 'broadcast.write',
  'ai-settings-enabled': 'ai.settings.write',
  'ai-settings-handback-idle': 'ai.settings.write',
  'ai-settings-auto-close': 'ai.settings.write',
  'ai-settings-tone-template': 'ai.settings.write',
  'tag-create': 'tags.write',
  'knowledge-draft-create': 'knowledge.write',
  'script-update-keyword': 'scripts.write',
  'script-update-reply': 'scripts.write',
}

/** 改完「前往查看」要去的網址。有 id 的兩頁沿用 `?id=` 深連結（`C-237`，會自己翻頁找、打開、捲到那一列） */
export function agentOpViewPath(page: AgentOpPage, workspaceId: string, targetId?: string): string {
  const base = `/admin/${workspaceId}`
  const id = targetId ? `?id=${encodeURIComponent(targetId)}` : ''
  switch (page) {
    case 'ai-scripts': return `${base}/ai-scripts${id}`
    case 'broadcasts': return `${base}/broadcasts${id}`
    case 'tags': return `${base}/tags`
    // 「等你看過」那一區只在沒選任何資料時出現；`?drafts=1` 會清掉選取並捲過去（`C-250`③）
    case 'knowledge': return `${base}/knowledge/sources?drafts=1`
    case 'ai-settings': return `${base}/ai-settings`
    case 'line-notify': return `${base}/settings/line-notify`
  }
}

// ── 每一頁的建議 ────────────────────────────────────────────────

export interface AgentPromptDo {
  /** 對應哪一件代辦（權限照它篩；⛔ 一定要是 15 件之一） */
  op: AdminOpId
  /** 按了會放進輸入框的那句話（範例，他要改成自己的） */
  say: string
}

export interface AgentPagePrompts {
  /** 標題「在「X」可以叫我」的 X；`null`＝沒有專屬建議的頁 */
  label: string | null
  /**
   * 輸入框的範例字。⛔ 不可以跟上面任何一個建議一樣（測試釘住）——兩個地方寫同一句是同一件事講兩遍；
   * 挑這一頁**建議裡沒列到**的另一件它做得到的事，等於多教一件。
   */
  placeholder: string
  /** 「直接幫你做」：最多 3 個 */
  dos: AgentPromptDo[]
  /**
   * 「幫你查」：按了直接送出。
   * ⛔ 要挑**每個帳號都問得通**的句子（不提他不一定有的標籤名、流程名）——按下去答「找不到」比沒有更糟。
   */
  asks: string[]
}

export type AgentPromptPage = AgentOpPage

export const AGENT_PAGE_PROMPTS: Record<AgentPromptPage, AgentPagePrompts> = {
  'ai-scripts': {
    label: '自動回應',
    placeholder: '例：把「退換貨」回覆改成「先填表單」',
    dos: [
      { op: 'script-create-from-description', say: '有人問「運費」，就回「滿千免運」' },
      { op: 'script-set-enabled', say: '把「查詢訂單」先下架' },
      { op: 'script-update-keyword', say: '「營業時間」多加一個關鍵字「今天有開嗎」' },
    ],
    asks: ['哪幾條自動回應還沒上架？'],
  },
  'broadcasts': {
    label: '推播',
    placeholder: '例：擬一則母親節草稿，發給全部好友',
    dos: [
      { op: 'broadcast-draft-create', say: '擬一則週年慶推播草稿，只發給「VIP」標籤的人' },
    ],
    asks: ['最近幾則推播的成效如何？'],
  },
  'tags': {
    label: '標籤管理',
    placeholder: '例：建一個標籤「回購客」',
    dos: [
      { op: 'tag-create', say: '建一個標籤「想買禮盒」' },
    ],
    asks: ['總共有幾個好友？'],
  },
  'knowledge': {
    label: '知識庫',
    placeholder: '例：客人問「有停車位嗎」就回「有」',
    dos: [
      { op: 'knowledge-draft-create', say: '補一張知識卡：客人問「可以刷卡嗎」，就回「可以，Visa、Master 都收」' },
    ],
    asks: ['知識庫有沒有匯入失敗的？'],
  },
  'ai-settings': {
    label: 'AI 設定',
    placeholder: '例：AI 的語氣換成親切一點的範本',
    dos: [
      { op: 'ai-settings-service-hours', say: '服務時間改成平日 9 點到 6 點，週末休息' },
      { op: 'ai-settings-sensitive-topic', say: '客人提到「退款」就轉真人' },
      { op: 'ai-settings-reply-mode', say: 'AI 先只給草稿，不要直接回客人' },
    ],
    asks: ['AI 現在是直接回客人，還是只給草稿？'],
  },
  'line-notify': {
    label: 'LINE 通知',
    placeholder: '例：改成等 30 分鐘還沒人回才提醒',
    dos: [
      { op: 'ai-settings-handoff-sla', say: '客人等超過 15 分鐘沒人回就提醒' },
    ],
    asks: ['現在有幾個人會收到 LINE 通知？'],
  },
}

/** 沒有專屬建議的頁（客服對話、好友、統計…） */
export const AGENT_FALLBACK_PROMPTS: AgentPagePrompts = {
  label: null,
  placeholder: '例：哪些客服流程還沒啟用？',
  dos: [
    { op: 'ai-settings-service-hours', say: '服務時間改成平日 9 點到 6 點，週末休息' },
  ],
  asks: ['現在有什麼要處理的？', '這個月 AI 用量如何？'],
}

/** 網址 → 這是哪一頁（`/admin/{wid}/…`）；不是有專屬建議的頁回 null */
export function agentPromptPageFromPath(path: string): AgentPromptPage | null {
  const parts = String(path ?? '').split('?')[0]!.split('/').filter(Boolean)
  if (parts[0] !== 'admin' || parts.length < 3) return null
  const seg = parts[2]
  if (seg === 'ai-scripts' || seg === 'broadcasts' || seg === 'tags' || seg === 'ai-settings') return seg
  if (seg === 'knowledge') return 'knowledge'
  if (seg === 'settings' && parts[3] === 'line-notify') return 'line-notify'
  return null
}

/** 這一頁要列的建議（已照權限篩過；「做」最多 3 個） */
export function agentPromptsFor(page: AgentPromptPage | null, can: (cap: Capability) => boolean): AgentPagePrompts {
  const base = page ? AGENT_PAGE_PROMPTS[page] : AGENT_FALLBACK_PROMPTS
  return { ...base, dos: base.dos.filter(d => can(ADMIN_OP_CAPABILITY[d.op])).slice(0, 3) }
}

/** 「全部 N 件」：照頁分組、照權限篩（頁的順序＝側欄由上到下） */
export function agentOpCatalogue(can: (cap: Capability) => boolean): { page: AgentOpPage, label: string, ops: string[] }[] {
  const order: AgentOpPage[] = ['ai-scripts', 'tags', 'broadcasts', 'knowledge', 'ai-settings', 'line-notify']
  return order
    .map(page => ({
      page,
      label: AGENT_OP_PAGE_LABEL[page],
      ops: (Object.keys(ADMIN_OP_TARGET) as AdminOpId[])
        .filter(id => ADMIN_OP_TARGET[id].page === page && can(ADMIN_OP_CAPABILITY[id]))
        .map(id => ADMIN_OP_LABELS[id]),
    }))
    .filter(g => g.ops.length > 0)
}

// ── 「目前狀況」卡片上的「交給小幫手」（`D-112` 第 1 件）──────────────

/**
 * 待辦卡（照 `useSetupStatus` 的項目 id）：那件事小幫手做得到才有這顆。
 * 按了**直接送出**這句話——內容不含他的規則（它會接著問要怎麼做），所以不必先放進輸入框讓他改。
 * ⚠️ 「啟用一條客服流程」講「啟用」不講「建」：他可能已經有停用的，它查過清單會先問要開哪一條。
 */
export const AGENT_SETUP_ASKS: Partial<Record<string, { op: AdminOpId, text: string }>> = {
  aiEnabled: { op: 'ai-settings-enabled', text: '幫我打開 AI 自動回覆' },
  scriptReady: { op: 'script-create-from-description', text: '幫我啟用一條自動回應' },
}

/** 節慶卡：它會接著問要發什麼（⛔ 推播草稿的內容要照他講的寫，不自己編促銷詞） */
export const AGENT_FESTIVAL_ASK = {
  op: 'broadcast-draft-create' as AdminOpId,
  text: (festivalName: string) => `幫我擬一則「${festivalName}」的推播草稿`,
}

// ── 從哪裡叫出小幫手（量哪個入口真的有人按） ──────────────────────

/**
 * - `typed`：自己打字
 * - `suggestion`：按了輸入框上方的建議
 * - `page-button`：頁面上的「用一句話建立」
 * - `status-card`：「目前狀況」卡片上的「交給小幫手」
 *
 * 別家都沒有公開入口別的使用數字（`D-112` 報告第七節），只能自己量——記在 `adminAgentLogs`。
 */
export const AGENT_ASK_SOURCES = ['typed', 'suggestion', 'page-button', 'status-card'] as const
export type AgentAskSource = typeof AGENT_ASK_SOURCES[number]

/** 端點收到的值不在表上就當成自己打字（⛔ 不原樣存外面送來的任意字串） */
export function normalizeAgentAskSource(raw: unknown): AgentAskSource {
  return (AGENT_ASK_SOURCES as readonly string[]).includes(String(raw)) ? (raw as AgentAskSource) : 'typed'
}

/** 同上，頁面代號 */
export function normalizeAgentPromptPage(raw: unknown): AgentPromptPage | null {
  return Object.prototype.hasOwnProperty.call(AGENT_PAGE_PROMPTS, String(raw)) ? (raw as AgentPromptPage) : null
}
