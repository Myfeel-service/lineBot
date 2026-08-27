/**
 * 腳本（情境）執行引擎。
 *
 * 流程：
 *   1. 找到匹配的腳本（依 trigger 關鍵字、priority 最高的勝出）
 *   2. 在 user doc 上寫入 activeScript 狀態，並執行第一步
 *   3. 後續訊息進來：把使用者輸入存到 collected[currentField]，跳下一個節點
 *   4. 遇到 reply 節點：渲染 {{變數}} 後回傳訊息給 webhook 層送出
 *   5. 結束：清 activeScript；若 thenHandoff=true 由 webhook 層觸發 live_agent
 *
 * 與 [shared/auto-reply-rule.ts](../../shared/auto-reply-rule.ts) 的差別：
 *   - 自動回覆是「一問一答」單步驟；腳本是多步驟有狀態
 *   - activeScript 是 user-level 的；同個使用者同時間只能在一條腳本中
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import { getDb } from './firebase'
import type {
  ActiveScriptState,
  ScriptCollectNode,
  ScriptDoc,
  ScriptNode,
  ScriptReplyNode,
  ScriptStats,
  ScriptTriggerNode,
} from '~~/shared/types/ai-script'
import {
  DEFAULT_COLLECT_REASK,
  DEFAULT_REPLY_LINK_LABEL,
  collectSkipLabel,
  extractCollectValue,
  isHumanRequestText,
  renderScriptTemplate,
  resolveBranchNext,
  scriptTriggerEvent,
} from '~~/shared/types/ai-script'
import { addTagsToUser } from './tagging'

export const SCRIPTS_COLLECTION = 'scripts'

// ── In-memory cache（60 秒），減少每則訊息打 Firestore ────────────────────
const CACHE_TTL_MS = 60_000
interface ScriptCache { data: Array<ScriptDoc & { id: string }>; expires: number }
const cache = new Map<string, ScriptCache>()

export function invalidateScriptsCache(workspaceId: string) {
  cache.delete(workspaceId)
}

export async function loadActiveScripts(workspaceId: string, db: Firestore = getDb()): Promise<Array<ScriptDoc & { id: string }>> {
  const cached = cache.get(workspaceId)
  if (cached && cached.expires > Date.now()) return cached.data

  const snap = await db.collection(SCRIPTS_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .where('enabled', '==', true)
    .orderBy('priority', 'desc')
    .get()
  const rows: Array<ScriptDoc & { id: string }> = snap.docs.map(d => ({
    id: d.id,
    ...(d.data() as ScriptDoc),
  }))
  cache.set(workspaceId, { data: rows, expires: Date.now() + CACHE_TTL_MS })
  return rows
}

/**
 * 找出這個工作區「另一條」啟用中的加好友腳本（存檔防呆用）。
 *
 * 一個工作區只能有一條啟用中的 follow 腳本：訊息型腳本靠關鍵字分流，兩條並存各接各的；
 * follow 事件沒有內容可分流，兩條並存＝客人一加好友就被兩條腳本各接一次。
 * ⛔ 刻意直接查 Firestore、不走 loadActiveScripts 的 60 秒快取——防呆吃到過期快取
 * 等於沒防（存了 A 再存 B，快取還沒看到 A）。這查詢只在「存檔且是 follow 腳本」時才跑，
 * 不在熱路徑上。等值查詢走自動索引，免新索引。
 */
export async function findEnabledFollowScriptConflict(
  workspaceId: string,
  excludeScriptId?: string,
  db: Firestore = getDb(),
): Promise<{ id: string; name: string } | null> {
  const snap = await db.collection(SCRIPTS_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .where('enabled', '==', true)
    .get()
  for (const d of snap.docs) {
    if (d.id === excludeScriptId) continue
    const s = d.data() as ScriptDoc
    if (scriptTriggerEvent(s) === 'follow') return { id: d.id, name: String(s.name || '(未命名流程)') }
  }
  return null
}

// ── Active script lifecycle ──────────────────────────────────────────────

export interface ScriptStepResult {
  /** 要送給使用者的訊息（reply 節點才有；collect 節點是「問問題」） */
  replyText: string
  /** 流程結束後是否要 handoff 到 live_agent */
  thenHandoff: boolean
  /** 流程結束（reply 節點被執行 / 流程錯誤）→ 呼叫方應清 activeScript */
  finished: boolean
  /** 真正跑到 reply 節點、正常完成（過期 / 狀態壞掉的結束不算）→ 計入完成統計 */
  completed?: boolean
  /** quickReply 節點的按鈕文字；caller 用來組 LINE Quick Reply（label = 送出文字） */
  quickReplies?: string[]
  /** reply 節點附的連結按鈕（＝自動回覆的「開啟網址」）；caller 組成 buttons template 一起送 */
  link?: { url: string; label: string }
  /**
   * module 節點：要送出的機器人模組 id。
   * 訊息由 caller 送（要抓 flow、判斷真人客服模組、接會話狀態），引擎只負責走到這裡並收工。
   */
  moduleId?: string
  /**
   * module 節點：這一輪收集到的答案。
   * ⛔ 模組訊息的變數是用「客人資料」渲染的，看不到腳本剛收到的答案——不把這份帶出去，
   * 「收訂單編號 → 送模組」的模組內容就會把 {{order_id}} 原樣印給客人。
   */
  collected?: Record<string, string>
  /**
   * 逃生門:客人在腳本進行中喊「找真人」→ 流程已放棄(activeScript 已清)。
   * caller 應走標準轉真人流程(deliverHandoffReply),不要把 replyText 當一般回覆送。
   */
  escapeToHuman?: boolean
}

const EMPTY_RESULT: ScriptStepResult = { replyText: '', thenHandoff: false, finished: true }

/**
 * 執行流程走訪累積的副作用（貼標 / 寫名單）。逐一 await、各自 try/catch，
 * 單一動作失敗不影響其他動作或對話本身。
 */
async function executeScriptActions(
  db: Firestore,
  userDocId: string,
  workspaceId: string,
  scriptId: string,
  actions: ScriptSideEffect[],
): Promise<void> {
  for (const a of actions) {
    if (a.type === 'tag') {
      await addTagsToUser(userDocId, a.tagIds, 'system', `script:${scriptId}`, workspaceId)
        .catch(e => console.error('[ai-scripts] tag action failed:', e))
    }
    else if (a.type === 'saveAttributes') {
      // 寫進 user attributes（持久化、後台可見、可用 {{屬性名}} 取用）
      await db.collection('users').doc(userDocId)
        .set({ attributes: a.attributes }, { merge: true })
        .catch(e => console.error('[ai-scripts] saveAttributes action failed:', e))
    }
  }
}

/** 累計腳本成效統計（fire-and-forget，失敗不影響對話） */
function recordScriptStat(db: Firestore, scriptId: string, field: keyof ScriptStats): void {
  db.collection(SCRIPTS_COLLECTION).doc(scriptId).update({
    [`stats.${field}`]: FieldValue.increment(1),
  }).catch(e => console.error('[ai-scripts] recordScriptStat failed:', e))
}

function findNode(script: ScriptDoc, id: string): ScriptNode | undefined {
  return script.nodes.find(n => n.id === id)
}

/**
 * 流程走訪過程中累積的「待執行副作用」。走訪本身保持純函式、不碰 db；
 * 由 async 的 startScript/advanceScript 在走訪「結束後」一次執行。
 *
 * 注意：這是「fire-after-walk」的純寫入副作用（貼標、寫屬性），結果不會回流影響走訪中的分支判斷。
 * ⑨ API 連接器若需要「打 API → 拿結果 → 據此分支」，需要 mid-walk await + 把結果寫回 collected，
 * 那是另一種「互動式 await 節點」（像 collect 一樣停下、非同步取值後再續走），無法只靠這個累積器表達——
 * 屆時走訪要改成 async/可重入，不是在這裡多加一個 type 就好。
 */
export type ScriptSideEffect =
  | { type: 'tag'; tagIds: string[] }
  | { type: 'saveAttributes'; attributes: Record<string, string> }

interface WalkResult {
  nextState: ActiveScriptState | null
  result: ScriptStepResult
  actions: ScriptSideEffect[]
}

function runNonInteractiveSteps(
  script: ScriptDoc,
  startNodeId: string,
  state: ActiveScriptState,
  attributes: Record<string, string>,
): WalkResult {
  // 從 startNodeId 開始，盡量往前推到「需要使用者輸入」（collect/quickReply 的問句）或「結束」；
  // 途中經過的動作節點（tag/saveLead）累積到 actions，由呼叫端在持久化後執行。
  let cursor: string = startNodeId
  let nextState: ActiveScriptState | null = { ...state, currentNodeId: cursor }
  const actions: ScriptSideEffect[] = []

  for (let i = 0; i < 50; i++) { // 防無限迴圈
    const node = findNode(script, cursor)
    if (!node) return { nextState: null, result: EMPTY_RESULT, actions }

    if (node.type === 'trigger') {
      cursor = node.next
      nextState = { ...nextState!, currentNodeId: cursor }
      continue
    }

    if (node.type === 'branch') {
      // 非互動：依已收集欄位求值，直接跳對應出口，繼續往前推
      cursor = resolveBranchNext(node, nextState!.collected)
      nextState = { ...nextState!, currentNodeId: cursor }
      continue
    }

    if (node.type === 'tag') {
      // 非互動動作：累積貼標意圖，繼續往前推
      if (node.addTagIds.length) actions.push({ type: 'tag', tagIds: node.addTagIds })
      cursor = node.next
      nextState = { ...nextState!, currentNodeId: cursor }
      continue
    }

    if (node.type === 'saveLead') {
      // 非互動動作：把 collected 映射成要寫入的屬性，繼續往前推
      const attrs: Record<string, string> = {}
      for (const m of node.fieldMap) {
        const v = nextState!.collected[m.fromField]
        if (v != null && v !== '') attrs[m.attrKey] = v
      }
      if (Object.keys(attrs).length) actions.push({ type: 'saveAttributes', attributes: attrs })
      cursor = node.next
      nextState = { ...nextState!, currentNodeId: cursor }
      continue
    }

    if (node.type === 'collect') {
      // 問問題給使用者；停在這裡等下一則訊息。
      // 有設跳過出口（skipLabel+skipNext）→ 問句附一顆跳過按鈕，客人「沒有這個資料」也有路可走
      const skipLabel = collectSkipLabel(node)
      return {
        nextState: { ...nextState!, currentNodeId: node.id, expiresAt: Date.now() + (node.expireMs || 600_000) },
        result: {
          replyText: renderScriptTemplate(node.question, {
            collected: nextState!.collected,
            attributes,
          }),
          ...(skipLabel ? { quickReplies: [skipLabel] } : {}),
          thenHandoff: false,
          finished: false,
        },
        actions,
      }
    }

    if (node.type === 'quickReply') {
      // 互動：送出問句 + 選項按鈕，停在這裡等客人點/回（advanceScript 比對 label 決定走哪條）
      return {
        nextState: { ...nextState!, currentNodeId: node.id, expiresAt: Date.now() + (node.expireMs || 600_000) },
        result: {
          replyText: renderScriptTemplate(node.question, {
            collected: nextState!.collected,
            attributes,
          }),
          quickReplies: node.options.map(o => o.label),
          thenHandoff: false,
          finished: false,
        },
        actions,
      }
    }

    if (node.type === 'reply') {
      // 立刻回覆並結束流程。連結按鈕的網址也吃變數——才能把剛收到的訂單編號帶進查詢頁。
      const linkUrl = renderScriptTemplate(String(node.linkUrl ?? '').trim(), {
        collected: nextState!.collected,
        attributes,
      })
      return {
        nextState: null,
        result: {
          replyText: renderScriptTemplate(node.text, {
            collected: nextState!.collected,
            attributes,
          }),
          ...(linkUrl ? { link: { url: linkUrl, label: String(node.linkLabel ?? '').trim() || DEFAULT_REPLY_LINK_LABEL } } : {}),
          thenHandoff: node.thenHandoff,
          finished: true,
          completed: true,
        },
        actions,
      }
    }

    if (node.type === 'module') {
      // 送出某個機器人模組的訊息並結束。引擎不組訊息——那需要抓 flow、判斷是不是真人客服模組、
      // 接會話狀態，全部在 handler 的 replyWithFlowModule 裡（與自動回覆的模組動作共用同一支）。
      return {
        nextState: null,
        result: { replyText: '', moduleId: node.moduleId, collected: { ...nextState!.collected }, thenHandoff: false, finished: true, completed: true },
        actions,
      }
    }

    // 未知節點型別 → 結束
    return { nextState: null, result: EMPTY_RESULT, actions }
  }
  return { nextState: null, result: EMPTY_RESULT, actions }
}

/**
 * 啟動腳本：寫入 activeScript 並執行第一步。
 */
export async function startScript(
  script: ScriptDoc & { id: string },
  userDocId: string,
  attributes: Record<string, string>,
  db: Firestore = getDb(),
): Promise<ScriptStepResult> {
  const trigger = script.nodes.find(n => n.id === script.rootNodeId) as ScriptTriggerNode | undefined
  if (!trigger) return EMPTY_RESULT

  const state: ActiveScriptState = {
    scriptId: script.id,
    currentNodeId: script.rootNodeId,
    collected: {},
    startedAt: Date.now(),
    expiresAt: Date.now() + 60 * 60 * 1000, // 預設一小時 TTL
  }
  const { nextState, result, actions } = runNonInteractiveSteps(script, trigger.next, state, attributes)
  await persistActiveScript(db, userDocId, nextState)
  await executeScriptActions(db, userDocId, script.workspaceId, script.id, actions)
  // 成效統計：命中觸發即記一次啟動；若一步就跑到 reply（trigger→reply）也記完成
  recordScriptStat(db, script.id, 'starts')
  if (result.completed) recordScriptStat(db, script.id, 'completions')
  return result
}

/**
 * 接收使用者輸入：填到 currentNode（必為 collect）的 fieldName，然後跳下一個。
 */
export async function advanceScript(
  state: ActiveScriptState,
  userMessage: string,
  attributes: Record<string, string>,
  userDocId: string,
  db: Firestore = getDb(),
): Promise<ScriptStepResult> {
  // 逃生門(最優先,先於「當答案處理」):腳本進行中喊「找真人」→ 放棄流程、交給 caller 走標準轉真人。
  // 沒有這道門,求救會被 collect 存成欄位值(「已收到您的訂單 找真人」)或被格式驗證打回重問。
  if (isHumanRequestText(userMessage)) {
    await persistActiveScript(db, userDocId, null)
    return { replyText: '', thenHandoff: false, finished: true, escapeToHuman: true }
  }

  // 過期 → 直接清掉、丟回讓主流程走 rule / AI fallback
  if (state.expiresAt && state.expiresAt < Date.now()) {
    await persistActiveScript(db, userDocId, null)
    return EMPTY_RESULT
  }

  const script = await loadScript(db, state.scriptId)
  if (!script) {
    await persistActiveScript(db, userDocId, null)
    return EMPTY_RESULT
  }

  const current = findNode(script, state.currentNodeId)
  if (!current || (current.type !== 'collect' && current.type !== 'quickReply')) {
    // 狀態壞了（停在非互動節點），清掉
    await persistActiveScript(db, userDocId, null)
    return EMPTY_RESULT
  }

  // 推進到下一個節點的共用收尾
  const advanceFrom = async (collected: Record<string, string>, fromNodeId: string): Promise<ScriptStepResult> => {
    const newState: ActiveScriptState = { ...state, collected, currentNodeId: current.id }
    const { nextState, result, actions } = runNonInteractiveSteps(script, fromNodeId, newState, attributes)
    await persistActiveScript(db, userDocId, nextState)
    await executeScriptActions(db, userDocId, script.workspaceId, state.scriptId, actions)
    if (result.completed) recordScriptStat(db, state.scriptId, 'completions')
    return result
  }

  // ── quickReply：比對客人送出的文字 = 哪個選項 label，照該選項的 next 走 ──
  if (current.type === 'quickReply') {
    // 客人多半是「點按鈕」（送出完整 label），但也可能手打；用 trim + 不分大小寫比對，容錯一點
    const normalized = String(userMessage || '').trim().toLowerCase()
    const picked = current.options.find(o => o.label.trim().toLowerCase() === normalized)
    if (!picked) {
      // 沒對到任何選項 → 重新出題、停在同一節點（刷新逾時）。
      // 客人已經卡住一次,重問時補一顆「找真人」逃生按鈕(選項裡已有同義按鈕就不重複)。
      const reaskState: ActiveScriptState = {
        ...state,
        currentNodeId: current.id,
        expiresAt: Date.now() + (current.expireMs || 600_000),
      }
      await persistActiveScript(db, userDocId, reaskState)
      const labels = current.options.map(o => o.label)
      if (!labels.some(l => isHumanRequestText(l))) labels.push('找真人')
      return {
        replyText: renderScriptTemplate(current.question, { collected: state.collected, attributes }),
        quickReplies: labels,
        thenHandoff: false,
        finished: false,
      }
    }
    return advanceFrom(state.collected, picked.next)
  }

  // ── collect：格式抽取 + 驗證 ──
  const collectNode = current

  // 跳過出口（先於格式驗證）:客人點了「我沒有這個資料」按鈕（或手打整句）→ 不收值、直接走 skipNext。
  // 順序很重要:format 'any' 會照單全收,不先攔的話跳過語會被存成髒值
  const skipLabel = collectSkipLabel(collectNode)
  if (skipLabel && String(userMessage || '').trim().toLowerCase() === skipLabel.toLowerCase()) {
    return advanceFrom(state.collected, collectNode.skipNext!)
  }

  // 抽不到合格值 → 重問、停在同一節點（刷新逾時），不寫入髒值也不前進
  const extracted = extractCollectValue(collectNode, userMessage)
  if (!extracted.ok) {
    const reaskState: ActiveScriptState = {
      ...state,
      currentNodeId: collectNode.id,
      expiresAt: Date.now() + (collectNode.expireMs || 600_000),
    }
    await persistActiveScript(db, userDocId, reaskState)
    return {
      replyText: renderScriptTemplate(collectNode.reaskText?.trim() || DEFAULT_COLLECT_REASK, {
        collected: state.collected,
        attributes,
      }),
      // 答錯格式=挫折點:重問時亮出退路——跳過按鈕(有設的話)+找真人逃生鈕
      quickReplies: [...(skipLabel ? [skipLabel] : []), '找真人'],
      thenHandoff: false,
      finished: false,
    }
  }

  const collected = {
    ...state.collected,
    [collectNode.fieldName]: extracted.value,
  }
  return advanceFrom(collected, collectNode.next)
}

async function loadScript(db: Firestore, scriptId: string): Promise<ScriptDoc | null> {
  const snap = await db.collection(SCRIPTS_COLLECTION).doc(scriptId).get()
  return snap.exists ? (snap.data() as ScriptDoc) : null
}

async function persistActiveScript(db: Firestore, userDocId: string, state: ActiveScriptState | null): Promise<void> {
  await db.collection('users').doc(userDocId).update({
    activeScript: state ?? FieldValue.delete(),
  }).catch((e) => {
    console.error('[ai-scripts] persistActiveScript failed:', e)
  })
}

// 注意：ScriptNode 等型別請從 ~~/shared/types/ai-script 取（Nuxt auto-import）
