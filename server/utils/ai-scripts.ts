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
import { randomUUID } from 'node:crypto'
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore'
import { getDb } from './firebase'
import type {
  ActiveScriptState,
  ScriptCollectNode,
  ScriptDoc,
  ScriptNode,
  ScriptReplyNode,
  ScriptRun,
  ScriptStats,
  ScriptTriggerNode,
} from '~~/shared/types/ai-script'
import {
  DEFAULT_COLLECT_REASK,
  DEFAULT_REPLY_LINK_LABEL,
  SCRIPT_IMAGE_ANSWER,
  collectSkipLabel,
  consumePrefilledCollect,
  extractCollectValue,
  isHumanRequestText,
  isStepButtonText,
  prefillCollectFields,
  renderScriptTemplate,
  resolveBranchNext,
  scriptTriggerEvent,
} from '~~/shared/types/ai-script'
import { addTagsToUser } from './tagging'
import { sortByPriority } from './script-match'
import { summarizeScriptRuns, type ScriptRunSummary } from '~~/shared/script-runs'

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
  // Firestore 已照優先度排好；再過一次共用排序，同分時的順序寫明在程式裡、跟試試看同一支（`C-379`）
  const rows: Array<ScriptDoc & { id: string }> = sortByPriority(snap.docs.map(d => ({
    id: d.id,
    ...(d.data() as ScriptDoc),
  })))
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
 * 下班時間（勿擾時段）才有的兩句話（`D-138`③，由 handler 依 AI 設定組好傳進來）。
 * 以前流程照問「請問您的訂單編號是？」，另一條路又補一則「目前非客服服務時間…」，
 * 客人同一刻收到兩三則不同來源的訊息、不知道該回哪則；最後那則還被整句換成勿擾文字，流程自己的回覆消失。
 */
export interface ScriptOffHours {
  /** 店家設定的「非客服服務時間」那句（含幾點起回覆）：流程第一次開口時併在問題前面 */
  notice: string
  /** 講過一次之後，最後那則只補這一句「幾點起回覆」 */
  nextLine: string
}

export interface ScriptStepOptions {
  offHours?: ScriptOffHours | null
  /**
   * 客人用圖片回答這一題（`D-138`②）。只在停在「問一題」（collect）時才算數——
   * 呼叫端要先確認，停在「給按鈕選」時圖片不是任何一個選項。
   */
  image?: boolean
}

/** 這條流程最後會交給真人嗎（下班時間要不要先講「非客服服務時間」的判斷：不會轉真人的流程沒有人要等） */
function endsWithHandoff(script: ScriptDoc): boolean {
  return script.nodes.some(n => n.type === 'reply' && n.thenHandoff)
}

/**
 * 下班時間把「非客服服務時間」併進流程自己的那一則（`D-138`③）：
 * - 第一次開口問問題：那句放在問題前面，記下「講過了」
 * - 走到最後要交給真人：保留流程自己的回覆，後面補——講過就只補「幾點起回覆」，沒講過補整句
 * 不會轉真人的流程（預約報名、加好友打招呼）不加：沒有人要等。
 */
function mergeOffHours(
  script: ScriptDoc,
  result: ScriptStepResult,
  alreadyNoticed: boolean,
  offHours: ScriptOffHours | null | undefined,
): { result: ScriptStepResult; noticedNow: boolean } {
  if (!offHours || result.escapeToHuman || !endsWithHandoff(script)) return { result, noticedNow: false }
  if (result.finished) {
    if (!result.thenHandoff) return { result, noticedNow: false }
    const body = result.replyText.trim()
    const tail = alreadyNoticed ? offHours.nextLine : offHours.notice
    const replyText = body ? `${body}${alreadyNoticed ? '\n' : '\n\n'}${tail}` : tail
    return { result: { ...result, replyText }, noticedNow: false }
  }
  if (alreadyNoticed || !result.replyText) return { result, noticedNow: false }
  return { result: { ...result, replyText: `${offHours.notice}\n\n${result.replyText}` }, noticedNow: true }
}

// ── 每一次走進來的紀錄（`D-138`）：停在哪一題、為什麼 ─────────────────────
const RUNS_SUBCOLLECTION = 'runs'
/**
 * 紀錄保留天數：帶客人名字，不能永遠留著（`C-379`）。寫入時帶 `expireAt`，靠 TTL policy 自動清
 * （欄位名沿用站內慣例；跟紀錄裡的 `expiresAtMs`＝「這一題等到幾點」是兩回事）。
 * 成效卡只看最近 500 次，半年綽綽有餘。
 */
const RUN_TTL_DAYS = 180

function runRef(db: Firestore, scriptId: string, runId: string) {
  return db.collection(SCRIPTS_COLLECTION).doc(scriptId).collection(RUNS_SUBCOLLECTION).doc(runId)
}

/**
 * 刪掉一條自動回應時，它的每次紀錄一起刪（`C-379`）：裡面有客人名字，主文件刪了它們就成了後台看不到、也刪不掉的孤兒。
 * 分批刪（單一 batch 上限 500 writes，400 一批留餘裕）。呼叫端先刪這裡再刪主文件：中途失敗主文件還在、可以再按一次刪除。
 * 還在走的那幾位之後的 updateRun 是 update，文件不在就失敗、不會長回來；
 * 別台主機 60 秒快取裡還看得到這條、剛好有人走進來的那幾筆，靠 expireAt（TTL）收。
 */
export async function deleteScriptRuns(db: Firestore, scriptId: string): Promise<number> {
  const runs = db.collection(SCRIPTS_COLLECTION).doc(scriptId).collection(RUNS_SUBCOLLECTION)
  let deleted = 0
  for (;;) {
    const snap = await runs.limit(400).get()
    if (snap.empty) return deleted
    const batch = db.batch()
    for (const d of snap.docs) batch.delete(d.ref)
    await batch.commit()
    deleted += snap.docs.length
  }
}

/**
 * 更新這次的紀錄。⛔ 呼叫端一律 await（跟 persistActiveScript 一起 Promise.all）：
 * Lambda 回應後容器會凍結，沒 await 的寫入會被砍掉（推播卡「發送中」那次學到的）。
 * 失敗只印 log——紀錄寫不進去不能讓客人收不到回覆。
 */
async function updateRun(db: Firestore, state: Pick<ActiveScriptState, 'scriptId' | 'runId'>, patch: Record<string, unknown>): Promise<void> {
  if (!state.runId) return // 舊狀態（這版之前開始的）沒有紀錄可更新
  await runRef(db, state.scriptId, state.runId)
    .update({ ...patch, updatedAtMs: Date.now() })
    .catch(e => console.error('[ai-scripts] updateRun failed:', e))
}

/** 成效卡最多讀最近幾次（超過就講「只算最近 N 次」） */
const RUNS_READ_LIMIT = 500

/**
 * 一條自動回應的成效：最近 500 次走進來的紀錄算成「走完幾位、停在哪一題、為什麼」（`D-138`）。
 * 別的帳號的一律當成找不到（不講「有這條但不是你的」）。
 */
export async function loadScriptRunSummary(db: Firestore, workspaceId: string, scriptId: string): Promise<ScriptRunSummary> {
  const ref = db.collection(SCRIPTS_COLLECTION).doc(scriptId)
  const snap = await ref.get()
  if (!snap.exists || snap.get('workspaceId') !== workspaceId)
    throw createError({ statusCode: 404, statusMessage: '找不到這條自動回應' })
  const runsSnap = await ref.collection(RUNS_SUBCOLLECTION).orderBy('startedAtMs', 'desc').limit(RUNS_READ_LIMIT + 1).get()
  const truncated = runsSnap.docs.length > RUNS_READ_LIMIT
  return summarizeScriptRuns(runsSnap.docs.slice(0, RUNS_READ_LIMIT).map(d => d.data() as ScriptRun), Date.now(), truncated)
}

/** 推進之後，紀錄要寫什麼：還在等答案＝停在哪一題；結束＝走完或中斷 */
function runPatchAfterStep(nextState: ActiveScriptState | null, result: ScriptStepResult, image = false): Record<string, unknown> {
  const extra = image ? { imageAnswers: FieldValue.increment(1) } : {}
  if (nextState) return { ...extra, nodeId: nextState.currentNodeId, expiresAtMs: nextState.expiresAt, status: 'active' }
  return { ...extra, nodeId: '', status: result.completed ? 'completed' : 'stopped' }
}

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
 * 換掉 prefilled 名單；名單空了就整格拿掉——寫進 Firestore 的狀態不能帶 undefined
 * （firebase-admin 沒開 ignoreUndefinedProperties，整筆會寫失敗）。
 */
function withPrefilled(state: ActiveScriptState, list: string[]): ActiveScriptState {
  const { prefilled: _drop, ...rest } = state
  return list.length ? { ...rest, prefilled: list } : rest
}

/**
 * 把客人這句話裡、流程後面要問的資料先撿起來（見 prefillCollectFields）。
 * 撿到的值進 collected、欄位名進 prefilled，走到那一題時跳過。
 */
function prefillFromText(script: ScriptDoc, state: ActiveScriptState, text: string): ActiveScriptState {
  const found = prefillCollectFields(script.nodes, text, state.collected)
  const fields = Object.keys(found)
  if (!fields.length) return state
  return withPrefilled(
    { ...state, collected: { ...state.collected, ...found } },
    [...new Set([...(state.prefilled ?? []), ...fields])],
  )
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
        // 用截圖回答的那題不寫進客人資料：「（圖片）」不是訂單編號，圖在對話裡給真人看（`D-138`②）
        if (v != null && v !== '' && v !== SCRIPT_IMAGE_ANSWER) attrs[m.attrKey] = v
      }
      if (Object.keys(attrs).length) actions.push({ type: 'saveAttributes', attributes: attrs })
      cursor = node.next
      nextState = { ...nextState!, currentNodeId: cursor }
      continue
    }

    if (node.type === 'collect') {
      // 客人前面已經講過這一項（例：觸發流程那句就寫了訂單編號）→ 不再問，直接往下走（`C-343`）
      const remaining = consumePrefilledCollect(node.fieldName, nextState!)
      if (remaining) {
        cursor = node.next
        nextState = withPrefilled({ ...nextState!, currentNodeId: cursor }, remaining)
        continue
      }
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
 *
 * @param triggerText 觸發流程的那句話（加好友觸發的沒有）。裡面已經有的訂單編號／電話／Email
 *   先撿起來，走到那一題就不再問（`C-343`）。
 */
export async function startScript(
  script: ScriptDoc & { id: string },
  userDocId: string,
  attributes: Record<string, string>,
  db: Firestore = getDb(),
  triggerText = '',
  opts: ScriptStepOptions = {},
): Promise<ScriptStepResult> {
  const trigger = script.nodes.find(n => n.id === script.rootNodeId) as ScriptTriggerNode | undefined
  if (!trigger) return EMPTY_RESULT

  const now = Date.now()
  const runId = randomUUID()
  const state: ActiveScriptState = prefillFromText(script, {
    scriptId: script.id,
    currentNodeId: script.rootNodeId,
    collected: {},
    startedAt: now,
    expiresAt: now + 60 * 60 * 1000, // 預設一小時 TTL
    runId,
  }, triggerText)
  const walked = runNonInteractiveSteps(script, trigger.next, state, attributes)
  const { actions } = walked
  const merged = mergeOffHours(script, walked.result, false, opts.offHours)
  const result = merged.result
  const nextState = walked.nextState && merged.noticedNow ? { ...walked.nextState, offHoursNoticed: true as const } : walked.nextState

  // 一步就回完的（「客人打特定的字就回一句」那種）不記紀錄：沒有「停在哪一題」可講，記了只是多一筆寫入
  const run: ScriptRun | null = nextState
    ? {
        userDocId,
        displayName: String(attributes.displayName || ''),
        startedAtMs: now,
        updatedAtMs: now,
        nodeId: nextState.currentNodeId,
        status: 'active',
        reasks: 0,
        imageAnswers: 0,
        expiresAtMs: nextState.expiresAt,
      }
    : null
  await Promise.all([
    persistActiveScript(db, userDocId, nextState ? nextState : null),
    run
      ? runRef(db, script.id, runId)
          .set({ ...run, expireAt: Timestamp.fromMillis(now + RUN_TTL_DAYS * 86_400_000) })
          .catch(e => console.error('[ai-scripts] create run failed:', e))
      : Promise.resolve(),
  ])
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
  opts: ScriptStepOptions = {},
): Promise<ScriptStepResult> {
  // 逃生門(最優先,先於「當答案處理」):腳本進行中喊「找真人」→ 放棄流程、交給 caller 走標準轉真人。
  // 沒有這道門,求救會被 collect 存成欄位值(「已收到您的訂單 找真人」)或被格式驗證打回重問。
  // 例外:這句剛好就是這一步的按鈕(店家的按鈕叫「找客服」)→ 客人點的是按鈕,照按鈕的路走(`C-379`)。
  // 只有喊找真人時才多讀一次流程,讀到的留給下面用
  let preloaded: ScriptDoc | null | undefined
  if (!opts.image && isHumanRequestText(userMessage)) {
    preloaded = await loadScript(db, state.scriptId)
    const at = preloaded ? findNode(preloaded, state.currentNodeId) : undefined
    if (!at || !isStepButtonText(at, userMessage)) {
      await Promise.all([persistActiveScript(db, userDocId, null), updateRun(db, state, { status: 'escaped' })])
      return { replyText: '', thenHandoff: false, finished: true, escapeToHuman: true }
    }
  }

  // 過期 → 直接清掉、丟回讓主流程走 rule / AI fallback
  if (state.expiresAt && state.expiresAt < Date.now()) {
    await Promise.all([persistActiveScript(db, userDocId, null), updateRun(db, state, { status: 'expired' })])
    return EMPTY_RESULT
  }

  const script = preloaded ?? await loadScript(db, state.scriptId)
  if (!script) {
    await persistActiveScript(db, userDocId, null)
    return EMPTY_RESULT
  }
  // 停用了就停：畫面寫「關掉後這條就不會再接客人」，走到一半的也一樣（`D-138`，`C-363`⑥）。
  // 這句話交回主流程（AI 或別條），不會沒人回。
  if (script.enabled === false) {
    await Promise.all([persistActiveScript(db, userDocId, null), updateRun(db, state, { status: 'stopped' })])
    return EMPTY_RESULT
  }

  const current = findNode(script, state.currentNodeId)
  if (!current || (current.type !== 'collect' && current.type !== 'quickReply')) {
    // 狀態壞了（停在非互動節點），清掉
    await Promise.all([persistActiveScript(db, userDocId, null), updateRun(db, state, { status: 'stopped' })])
    return EMPTY_RESULT
  }

  const alreadyNoticed = state.offHoursNoticed === true

  // 推進到下一個節點的共用收尾
  const advanceFrom = async (
    collected: Record<string, string>,
    fromNodeId: string,
    /** 客人這次回答的整句：裡面若順便帶了後面要問的資料（「M2026…／電話 09…」），先撿起來（`C-343`） */
    answerText = '',
  ): Promise<ScriptStepResult> => {
    const newState = prefillFromText(script, { ...state, collected, currentNodeId: current.id }, answerText)
    const walked = runNonInteractiveSteps(script, fromNodeId, newState, attributes)
    const merged = mergeOffHours(script, walked.result, alreadyNoticed, opts.offHours)
    const nextState = walked.nextState && merged.noticedNow ? { ...walked.nextState, offHoursNoticed: true as const } : walked.nextState
    await Promise.all([
      persistActiveScript(db, userDocId, nextState),
      updateRun(db, state, runPatchAfterStep(nextState, merged.result, opts.image === true)),
    ])
    await executeScriptActions(db, userDocId, script.workspaceId, state.scriptId, walked.actions)
    if (merged.result.completed) recordScriptStat(db, state.scriptId, 'completions')
    return merged.result
  }

  /** 同一題重問（答錯格式／沒點到選項）：停在原地、刷新逾時、記一次重問 */
  const reask = async (result: ScriptStepResult, expireMs: number): Promise<ScriptStepResult> => {
    const merged = mergeOffHours(script, result, alreadyNoticed, opts.offHours)
    const reaskState: ActiveScriptState = {
      ...state,
      currentNodeId: current.id,
      expiresAt: Date.now() + (expireMs || 600_000),
      ...(merged.noticedNow ? { offHoursNoticed: true as const } : {}),
    }
    await Promise.all([
      persistActiveScript(db, userDocId, reaskState),
      updateRun(db, state, { reasks: FieldValue.increment(1), nodeId: current.id, expiresAtMs: reaskState.expiresAt }),
    ])
    return merged.result
  }

  // ── 客人傳圖片回答這一題（`D-138`②）：收下、往下走。圖片本身在對話裡給真人看 ──
  if (opts.image) {
    if (current.type !== 'collect') return { replyText: '', thenHandoff: false, finished: false }
    return advanceFrom({ ...state.collected, [current.fieldName]: SCRIPT_IMAGE_ANSWER }, current.next)
  }

  // ── quickReply：比對客人送出的文字 = 哪個選項 label，照該選項的 next 走 ──
  if (current.type === 'quickReply') {
    // 客人多半是「點按鈕」（送出完整 label），但也可能手打；用 trim + 不分大小寫比對，容錯一點
    const normalized = String(userMessage || '').trim().toLowerCase()
    const picked = current.options.find(o => o.label.trim().toLowerCase() === normalized)
    if (!picked) {
      // 沒對到任何選項 → 重新出題、停在同一節點（刷新逾時）。
      // 客人已經卡住一次,重問時補一顆「找真人」逃生按鈕(選項裡已經叫「找真人」就不重複)。
      // ⛔ 不看其他求助講法:選項叫「找客服」是店家的按鈕、點了照它的路走(`C-379`),不能當成已經有逃生鈕
      const labels = current.options.map(o => o.label)
      if (!labels.some(l => l.trim() === '找真人')) labels.push('找真人')
      return reask({
        replyText: renderScriptTemplate(current.question, { collected: state.collected, attributes }),
        quickReplies: labels,
        thenHandoff: false,
        finished: false,
      }, current.expireMs)
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
    return reask({
      replyText: renderScriptTemplate(collectNode.reaskText?.trim() || DEFAULT_COLLECT_REASK, {
        collected: state.collected,
        attributes,
      }),
      // 答錯格式=挫折點:重問時亮出退路——跳過按鈕(有設的話)+找真人逃生鈕
      quickReplies: [...(skipLabel ? [skipLabel] : []), '找真人'],
      thenHandoff: false,
      finished: false,
    }, collectNode.expireMs)
  }

  const collected = {
    ...state.collected,
    [collectNode.fieldName]: extracted.value,
  }
  return advanceFrom(collected, collectNode.next, userMessage)
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
