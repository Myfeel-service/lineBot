/**
 * 「客人加好友時」這一列（`D-23` 2026-09-21 拍板）。
 *
 * **問題的形狀**：加好友歡迎**沒有家**。它藏在「自動回應 → 新增 → 觸發方式的第三顆」，
 * 商家腦中的詞（歡迎訊息）跟我們的詞（客服流程／觸發方式）對不上。
 * 結果是 MYFEEL 7 條自動回應裡**一條加好友的都沒有**，而歡迎模組是**空的**——
 * 最近 90 天約 667 位掃 QR／搜 ID 加好友的人，**一句話都沒收到**，
 * 而後台沒有任何地方會講這件事（就緒度的「啟用一條客服流程」有 7 條、是綠的）。
 *
 * **做法＝一種東西、兩種深度**（沿用 08-09「自動回應合一」的哲學）：
 * 清單最上面永遠釘一列「客人加好友時」，沒設定也在；
 * 簡單的人選一個機器人模組或打一段文字就好，要收資料的人照舊用完整流程編輯器。
 *
 * ⛔ **不新增側欄項目**（08-22 拍板：側欄多一項違反一致性）——它就住在自動回應裡，
 *    因為它本來就是一條自動回應，只是觸發的是「加好友」這個事件。
 */
import { DEFAULT_SCRIPT_PRIORITY, type ScriptNode } from './types/ai-script'

/** 這一列固定的名字。⛔ 跟畫面上的觸發方式選項同一個詞，不要另取 */
export const FOLLOW_WELCOME_LABEL = '客人加好友時'

/** 沒設定時，這一列要講的話 */
export const FOLLOW_WELCOME_UNSET_TEXT = '還沒設定——現在加好友的人不會收到任何訊息'

export type FollowWelcomeState = 'unset' | 'active' | 'disabled'

export interface FollowWelcomeRow {
  state: FollowWelcomeState
  /** 這一列的副標（清單上那行小字） */
  meta: string
  /** 右邊那顆小章的字；`unset` 時不給章 */
  chipText: string
  chipTone: 'success' | 'neutral' | 'warning'
}

/**
 * 算出「客人加好友時」那一列現在該長什麼樣。
 *
 * ⛔ **三態要分得開**：沒設定／設了但停用／設了在跑，三者的下一步完全不同。
 *    把「停用」講成「沒設定」會害人再建一條（而後端只准有一條啟用的，他會撞 409）。
 */
export function followWelcomeRow(
  scripts: Array<{ enabled?: boolean; name?: string; triggerEvent?: string }>,
): FollowWelcomeRow {
  const follows = scripts.filter(s => s.triggerEvent === 'follow')
  const active = follows.find(s => s.enabled !== false)
  if (active) {
    return {
      state: 'active',
      meta: `正在用：${active.name || '(未命名流程)'}`,
      chipText: '啟用',
      chipTone: 'success',
    }
  }
  if (follows.length) {
    return {
      state: 'disabled',
      // ⛔ 停用中不可以說成「沒設定」：內容還在，他只要打開就好
      meta: `已經設好但停用中：${follows[0]!.name || '(未命名流程)'}——打開它，新朋友才收得到`,
      chipText: '停用',
      chipTone: 'warning',
    }
  }
  return {
    state: 'unset',
    meta: FOLLOW_WELCOME_UNSET_TEXT,
    chipText: '',
    chipTone: 'neutral',
  }
}

export type FollowWelcomeReply
  = | { kind: 'module'; moduleId: string }
    | { kind: 'text'; text: string }

/** 建立前的檢查；回 null＝可以建 */
export function validateFollowWelcome(reply: FollowWelcomeReply): string | null {
  if (reply.kind === 'module') {
    return String(reply.moduleId ?? '').trim() ? null : '請選一個機器人模組'
  }
  return String(reply.text ?? '').trim() ? null : '請填客人加好友後會看到的那段文字'
}

/**
 * 組出最小的那條加好友流程：觸發（加好友）→ 送模組／回一段文字。
 *
 * ⛔ **觸發節點的 keywords／examples 要留空**：`triggerEvent='follow'` 時它們沒有意義，
 *    後端存檔本來就會清空（`ai-script.ts` 的註解），這裡先留空免得看起來像設了關鍵字。
 * ⛔ **module／reply 都是終點、沒有 next**，不要給它 next。
 */
export function buildFollowWelcomeScript(
  reply: FollowWelcomeReply,
  ids: { triggerId: string; replyId: string },
): { nodes: ScriptNode[]; rootNodeId: string } {
  const tail: ScriptNode = reply.kind === 'module'
    ? { id: ids.replyId, type: 'module', moduleId: String(reply.moduleId).trim() }
    : { id: ids.replyId, type: 'reply', text: String(reply.text).trim(), thenHandoff: false }

  const trigger: ScriptNode = {
    id: ids.triggerId,
    type: 'trigger',
    triggerEvent: 'follow',
    matchMode: 'keyword',
    keywords: [],
    examples: [],
    priority: DEFAULT_SCRIPT_PRIORITY,
    next: ids.replyId,
  }

  return { nodes: [trigger, tail], rootNodeId: ids.triggerId }
}

/**
 * ⚠️ **LINE 官方帳號自己也有一個歡迎訊息**，沒關掉的話客人會收到兩則。
 * 而且 LINE 沒有開放介面讓我們讀那個開關（08-22 查證），
 * 所以**我們偵測不到你關了沒**，只能講出來。⛔ 不要寫成「系統已為你關閉」。
 */
export const LINE_BUILTIN_WELCOME_NOTE
  = 'LINE 官方帳號後台自己也有一個「加入好友的歡迎訊息」。兩邊都開著的話，客人會連收兩則——'
    + '請到 LINE 官方帳號管理後台把內建那則關掉。⚠️ 我們讀不到那個開關，沒辦法幫你確認關了沒。'
