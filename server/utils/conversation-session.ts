import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from './firebase'
import { lineUserFirestoreDocId, lineUserIdFromFirestoreDocId } from '~~/shared/line-workspace'
import type {
  ConversationEventType,
  ConversationStatus,
  InitialHandler,
  ModuleType,
} from '~~/shared/types/conversation-stats'
import { SESSION_24H_MS } from '~~/shared/types/conversation-stats'

// ── Session In-Memory Cache ───────────────────────────────────────
// Avoids running a Firestore transaction on every single webhook event.
// Common path: active session within 24h → return cached ID, update lastActivityAt in background.
//
// ⚠️ 「這場 session 是哪一個」與「這場現在誰在處理」是兩種鮮度需求，**必須分開計時**：
//   · sessionId  客人一直講話就一直有效（24h 內同一場），續命沒問題 → cachedAt
//   · status     隨時可能被**別的行程**改掉（客服按「我接手」、cron 自動交還、
//                另一台 Lambda 處理到同一位客人的另一則訊息而轉了真人）→ statusCachedAt
//
// 先前兩者共用一個 cachedAt，而 fast path 每次來訊都把它refresh 成 now，於是
// 「連續講話的客人」的舊狀態被無限續命：已經轉真人了，這台實例還以為機器人在處理，
// AI 就繼續插話（也讓「我接手（暫停自動回覆）」按了不一定馬上生效）。

interface SessionCacheEntry {
  sessionId: string
  status: ConversationStatus
  lastActivityAt: number  // JS ms timestamp
  /** sessionId 這筆對應關係的快取時間（可隨活動續命） */
  cachedAt: number
  /** status 這個值的取得時間（**不隨活動續命**，過期就回頭讀 Firestore） */
  statusCachedAt: number
  /** 已收過客人來訊(follow/活動出生的 session 在此之前不進首接統計) */
  hasInbound?: boolean
}
const SESSION_CACHE_TTL_MS = 30 * 1000
/**
 * status 的鮮度上限。抑制自動回覆（轉真人後機器人閉嘴）看的就是它，賭錯的代價是
 * 「AI 跟真人客服搶著回話」，所以刻意設得比 sessionId 短很多；代價是每則客人訊息
 * 最多多一次 session doc 讀取（同一次 webhook 內的多個 caller 仍共用這份快取）。
 */
const SESSION_STATUS_TTL_MS = 5 * 1000
const sessionByUser = new Map<string, SessionCacheEntry>()   // lineUserId → entry
const sessionStatusById = new Map<string, { status: ConversationStatus; cachedAt: number }>() // sessionId → status

function requireWorkspaceId(workspaceId: string | undefined, context: string): string {
  const wid = String(workspaceId || '').trim()
  if (!wid) throw new Error(`workspaceId is required in ${context}`)
  return wid
}

/**
 * 本行程剛剛親手把狀態寫進 Firestore → 快取這份新值（status 鮮度也一併更新）。
 * 注意這只救得了「自己這台」；別的行程改的狀態靠 SESSION_STATUS_TTL_MS 過期回讀。
 */
export function _updateSessionStatusCache(sessionId: string, status: ConversationStatus) {
  const now = Date.now()
  sessionStatusById.set(sessionId, { status, cachedAt: now })
  // Also update per-user cache if it references this session
  for (const [uid, entry] of sessionByUser) {
    if (entry.sessionId === sessionId) {
      sessionByUser.set(uid, { ...entry, status, cachedAt: now, statusCachedAt: now })
      break
    }
  }
}

export function _invalidateUserSessionCache(lineUserId: string) {
  const entry = sessionByUser.get(lineUserId)
  if (entry) sessionStatusById.delete(entry.sessionId)
  sessionByUser.delete(lineUserId)
}

/**
 * 從 Firestore 重讀一次 status 並同步兩份快取。回 null = doc 不存在或讀取失敗
 * （呼叫端當「這份快取不可信」處理，不要拿舊值硬撐）。
 */
async function refreshSessionStatusFromDb(sessionId: string): Promise<ConversationStatus | null> {
  try {
    const snap = await getDb().collection('conversationSessions').doc(sessionId).get()
    const status = snap.exists ? (snap.data()?.status as ConversationStatus | undefined) : undefined
    if (!status) return null
    const now = Date.now()
    sessionStatusById.set(sessionId, { status, cachedAt: now })
    for (const [uid, entry] of sessionByUser) {
      if (entry.sessionId === sessionId) {
        sessionByUser.set(uid, { ...entry, status, statusCachedAt: now })
        break
      }
    }
    return status
  }
  catch (e) {
    console.warn('[session] status refresh failed:', sessionId, e)
    return null
  }
}

// ── Event Recording ───────────────────────────────────────────────

export async function recordConversationEvent(
  sessionId: string,
  userId: string,
  eventType: ConversationEventType,
  extras?: { moduleType?: ModuleType; moduleId?: string },
): Promise<void> {
  const db = getDb()
  const eventRef = db.collection('conversationEvents').doc()
  await eventRef.set({
    sessionId,
    userId,
    eventType,
    ...(extras?.moduleType ? { moduleType: extras.moduleType } : {}),
    ...(extras?.moduleId ? { moduleId: extras.moduleId } : {}),
    timestamp: FieldValue.serverTimestamp(),
  })
}

// ── Session Lifecycle ─────────────────────────────────────────────

/**
 * Close any non-closed sessions for a user that are not the current active session.
 * Handles orphaned sessions left by race conditions.
 */
async function closeOrphanedSessions(
  lineUserId: string,
  currentSessionId: string,
  workspaceId: string,
): Promise<void> {
  const db = getDb()
  const snap = await db
    .collection('conversationSessions')
    .where('userId', '==', lineUserId)
    .where('workspaceId', '==', workspaceId)
    .get()

  const orphans = snap.docs.filter(d => d.id !== currentSessionId && d.data().status !== 'closed')
  if (orphans.length === 0) return

  const batch = db.batch()
  for (const doc of orphans) {
    batch.update(doc.ref, {
      status: 'closed' as ConversationStatus,
      closedAt: FieldValue.serverTimestamp(),
      lastActivityAt: FieldValue.serverTimestamp(),
    })
  }
  await batch.commit()

  await Promise.all(
    orphans.map(doc =>
      recordConversationEvent(doc.id, lineUserId, 'conversation_closed')
        .catch(e => console.warn('[session] orphan close event failed:', doc.id, e)),
    ),
  )
}

/**
 * Get or create the active conversation session for a user.
 * Creates a new session if:
 * - No current session exists
 * - Current session is closed
 * - >= 24h since last activity (the previous open session is closed first so stats stay correct)
 *
 * Uses a Firestore transaction to prevent duplicate sessions from concurrent webhook calls.
 * After creating a new session, any orphaned non-closed sessions for the same user are also closed.
 */
export async function ensureConversationSession(
  userId: string,
  workspaceId: string,
  /**
   * origin='follow':加好友/活動入口觸發(客人還沒開口)。這種 session 在收到第一句
   * 客人訊息(hasInbound)前,不進首接統計——不算「未首接」(沒有東西被接),也不算首接。
   * 不帶 opts = 客人來訊(訊息/postback),會把 hasInbound 補記為 true(冪等)。
   *
   * inboundAtMs = 觸發這次的客人訊息時間(LINE webhook event.timestamp)。**開新會話時當作
   * openedAt**。為什麼不能用伺服器時間:客人訊息存的是 LINE 的時間,一定比我們處理到的時間早
   * 幾百毫秒(網路+冷啟動),而時間軸是用「openedAt 之後的訊息」取窗口——於是每一場新會話的
   * 客人第一句都會被切掉,客服點進去看不到客人最初說了什麼。
   */
  opts: { origin?: 'follow'; inboundAtMs?: number } = {},
): Promise<string> {
  const db = getDb()
  const lineUserId = lineUserIdFromFirestoreDocId(userId, workspaceId)
  const convDocId = lineUserFirestoreDocId(lineUserId, workspaceId)
  const convRef = db.collection('conversations').doc(convDocId)
  const now = Date.now()

  // ── Fast path: active cached session ─────────────────────────────
  // For the common case (user messaging within 24h), skip the Firestore transaction entirely.
  // lastActivityAt is updated in the background so it doesn't block the reply.
  const cached = sessionByUser.get(lineUserId)
  if (
    cached &&
    now - cached.cachedAt < SESSION_CACHE_TTL_MS &&
    now - cached.lastActivityAt < SESSION_24H_MS
  ) {
    // status 過期就回頭讀一次（見 SESSION_STATUS_TTL_MS）：這場可能已經被客服接手、
    // 被 cron 交還、或被按了「結束會話」——那些都發生在別的行程，本行程的快取不會知道。
    let status: ConversationStatus | null = cached.status
    let statusCachedAt = cached.statusCachedAt
    if (now - statusCachedAt >= SESSION_STATUS_TTL_MS) {
      // doc 讀不到（被刪 / 讀取失敗）→ status=null，不用快取，落到 slow path 重新對帳
      status = await refreshSessionStatusFromDb(cached.sessionId)
      statusCachedAt = Date.now()
      if (!status) _invalidateUserSessionCache(lineUserId)
    }
    // 已結束的會話不能再收訊息（要開新的一場）→ 落到 slow path
    if (status && status !== 'closed') {
      const bgUpdate: Record<string, unknown> = { lastActivityAt: FieldValue.serverTimestamp() }
      // 客人來訊 → 補記 hasInbound(布林、重寫冪等;快取記住後同 instance 只寫一次)
      if (!opts.origin && !cached.hasInbound) bgUpdate.hasInbound = true
      db.collection('conversationSessions').doc(cached.sessionId)
        .update(bgUpdate)
        .catch(e => console.warn('[session] bg lastActivityAt update failed:', e))
      sessionByUser.set(lineUserId, {
        ...cached,
        status,
        lastActivityAt: now,
        cachedAt: now,
        // 刻意沿用原本的鮮度（不是 now）：sessionId 可以續命，status 不行
        statusCachedAt,
        hasInbound: cached.hasInbound || !opts.origin,
      })
      // Sync sessionStatusById so shouldSuppressInboundBotAutomationForSession gets a cache hit
      sessionStatusById.set(cached.sessionId, { status, cachedAt: statusCachedAt })
      return cached.sessionId
    }
  }

  // ── Slow path: Firestore transaction ─────────────────────────────
  // Pre-generate the new session ID outside the transaction so tx.set() can reference it.
  const newSessionId = uuidv4()
  const newSessionRef = db.collection('conversationSessions').doc(newSessionId)

  /**
   * 新會話的開始時間：用觸發它的那句客人訊息時間（見 opts.inboundAtMs）。
   * 只接受「現在往前 5 分鐘內、且不在未來」的值——LINE redelivery 或髒 payload 帶進一個
   * 幾小時前的時間戳，會讓這場會話的窗口往前吃到上一場的訊息。超出範圍就退回伺服器時間。
   */
  const inboundAtMs = Number(opts.inboundAtMs ?? 0)
  const useInboundAt = Number.isFinite(inboundAtMs)
    && inboundAtMs > now - 5 * 60_000
    && inboundAtMs <= now
  const openedAt = useInboundAt ? Timestamp.fromMillis(inboundAtMs) : FieldValue.serverTimestamp()
  /** 舊會話（24h 到期）的結束時間：收在新會話開始的前一毫秒，讓兩場的窗口不重疊 */
  const prevCloseAt = useInboundAt ? Timestamp.fromMillis(inboundAtMs - 1) : FieldValue.serverTimestamp()

  let createdNew = false
  let closedOldSessionId: string | null = null
  let resultStatus: ConversationStatus = 'open'

  const resultId = await db.runTransaction(async (tx) => {
    const convSnap = await tx.get(convRef)
    const convData = convSnap.data()

    // Read existing session inside the transaction (prevents concurrent creates).
    let existingRef: FirebaseFirestore.DocumentReference | null = null
    let existingData: FirebaseFirestore.DocumentData | null = null
    if (convData?.currentSessionId) {
      existingRef = db.collection('conversationSessions').doc(convData.currentSessionId as string)
      const existingSnap = await tx.get(existingRef)
      existingData = existingSnap.data() ?? null
    }

    if (existingData && existingData.status !== 'closed' && existingRef) {
      const lastActivity: number = existingData.lastActivityAt?.toMillis?.() ?? 0
      if (now - lastActivity < SESSION_24H_MS) {
        tx.update(existingRef, {
          lastActivityAt: FieldValue.serverTimestamp(),
          ...(!opts.origin && !existingData.hasInbound ? { hasInbound: true } : {}),
        })
        resultStatus = existingData.status as ConversationStatus
        return convData!.currentSessionId as string
      }
      // 24h expired — close inline (event recorded outside the tx)
      // closedAt 收在「開啟新會話那句話的前一毫秒」：兩場的邊界要對齊，
      // 否則那句話會同時落在舊會話的窗口（<= closedAt）與新會話的窗口（>= openedAt）裡，
      // 客服在兩個分頁都看到同一句話。
      tx.update(existingRef, {
        status: 'closed' as ConversationStatus,
        closedAt: prevCloseAt,
        lastActivityAt: FieldValue.serverTimestamp(),
      })
      closedOldSessionId = convData!.currentSessionId as string
    }

    tx.set(newSessionRef, {
      workspaceId,
      userId: lineUserId,
      openedAt,
      closedAt: null,
      lastActivityAt: FieldValue.serverTimestamp(),
      status: 'open' as ConversationStatus,
      initialHandler: 'unhandled' as InitialHandler,
      currentHandler: 'unhandled' as InitialHandler,
      initialModuleType: null,
      currentModuleType: null,
      hasHandoff: false,
      handoffRequestedAt: null,
      humanFirstRepliedAt: null,
      // 出生方式:follow=加好友/活動入口(客人還沒開口);message=客人來訊。
      // origin='follow' 且尚無 hasInbound 的 session 不進首接統計(見 isPreInboundFollowSession)
      origin: opts.origin ?? 'message',
      hasInbound: !opts.origin,
    })
    tx.set(convRef, {
      workspaceId,
      userId: lineUserId,
      currentSessionId: newSessionId,
    }, { merge: true })

    createdNew = true
    return newSessionId
  })

  // Populate both caches with the result of the transaction
  // （status 來自剛才交易裡的讀取 → 這一刻是新鮮的，statusCachedAt 記 now）
  const txAt = Date.now()
  sessionByUser.set(lineUserId, {
    sessionId: resultId,
    status: resultStatus,
    lastActivityAt: now,
    cachedAt: now,
    statusCachedAt: txAt,
    // 這次呼叫是客人來訊就一定有 inbound;follow 呼叫先設 false,下次來訊會補記
    hasInbound: !opts.origin,
  })
  sessionStatusById.set(resultId, { status: resultStatus, cachedAt: txAt })

  // Record events and clean up orphans outside the transaction (non-blocking for stats only).
  if (closedOldSessionId) {
    recordConversationEvent(closedOldSessionId, lineUserId, 'conversation_closed')
      .catch(e => console.warn('[session] close event record failed:', e))
  }
  if (createdNew) {
    // Event recording and orphan cleanup are independent — run in parallel, non-blocking
    Promise.all([
      recordConversationEvent(newSessionId, lineUserId, 'conversation_opened'),
      closeOrphanedSessions(lineUserId, newSessionId, workspaceId),
    ]).catch(e => console.warn('[session] post-create cleanup failed:', e))
  }

  return resultId
}

/**
 * 記帳用的 session 取得：sessionId 為空時（建立會話那一步失敗了）再從 conversations 撈一次。
 *
 * 為什麼需要這層：webhook 各處都是 `ensureConversationSession(...).catch(() => null)`，
 * 失敗回傳 null，後面每個記帳動作就被 `if (sessionId)` 一併跳過——但訊息已經送給客人了。
 * 結果是「客人收到回覆、系統完全沒紀錄」。這裡多一次讀取把洞補起來，
 * 只有在 sessionId 真的缺失時才會付這個成本。
 */
async function resolveSessionIdForAccounting(
  sessionId: string | null | undefined,
  userId: string,
  workspaceId: string,
): Promise<string | null> {
  if (sessionId) return sessionId
  try {
    const db = getDb()
    const lineUserId = lineUserIdFromFirestoreDocId(userId, workspaceId)
    const convDocId = lineUserFirestoreDocId(lineUserId, workspaceId)
    const convSnap = await db.collection('conversations').doc(convDocId).get()
    const recovered = convSnap.data()?.currentSessionId as string | undefined
    if (recovered) {
      console.warn('[session] sessionId missing at accounting time, recovered from conversations:', recovered)
      return recovered
    }
  }
  catch (e) {
    console.error('[session] sessionId recovery failed:', e)
  }
  return null
}

/**
 * Record that a module was entered in the current session.
 * Updates initial/current handler and status accordingly.
 * system_notice entries do NOT count toward initialHandler.
 *
 * 讀寫在同一個交易裡：先前是「先讀舊狀態、再寫新狀態」，同一秒兩則訊息會互相蓋掉
 * （後寫的贏），可能少記一次首接或漏掉 hasHandoff。交易也讓 Firestore 自動重試競爭，
 * 順帶降低「寫入失敗 → 靜默停在未首接」的機率。
 *
 * sessionId 允許為 null：缺失時自己補撈（見 resolveSessionIdForAccounting），
 * 呼叫端不需要再用 `if (sessionId)` 把記帳整段跳過。
 */
export async function enterModule(
  sessionId: string | null | undefined,
  userId: string,
  moduleType: ModuleType,
  moduleId?: string,
  workspaceId?: string,
): Promise<void> {
  const wid = requireWorkspaceId(workspaceId, 'enterModule')
  const db = getDb()
  const sid = await resolveSessionIdForAccounting(sessionId, userId, wid)
  if (!sid) {
    console.error('[session] enterModule skipped, no session to record:', moduleType, moduleId ?? '')
    return
  }
  const sessionRef = db.collection('conversationSessions').doc(sid)

  const outcome = await db.runTransaction(async (tx) => {
    const sessionSnap = await tx.get(sessionRef)
    if (!sessionSnap.exists) return null
    const session = sessionSnap.data() as any
    const updates = buildEnterModuleUpdates(session, moduleType)
    tx.update(sessionRef, updates)
    return {
      status: updates.status as ConversationStatus | undefined,
      isNewHandoff: Boolean(updates.hasHandoff),
    }
  })
  if (!outcome) return

  // Keep status cache in sync after module entry changes session status
  if (outcome.status) {
    _updateSessionStatusCache(sid, outcome.status)
  }

  if (moduleType === 'live_agent') {
    const uid = lineUserFirestoreDocId(lineUserIdFromFirestoreDocId(userId, wid), wid)
    await db
      .collection('users')
      .doc(uid)
      .update({ activeInput: FieldValue.delete() })
      .catch((e) => console.warn('[session] clear activeInput on live_agent:', e))
  }
  await recordConversationEvent(sid, lineUserIdFromFirestoreDocId(userId), 'entered_module', { moduleType, moduleId })
  if (outcome.isNewHandoff) {
    await recordConversationEvent(sid, lineUserIdFromFirestoreDocId(userId), 'handoff_request')
  }
}

/** enterModule 的狀態計算（純函式，方便在交易裡重跑：Firestore 競爭時會重試整個 callback） */
function buildEnterModuleUpdates(session: any, moduleType: ModuleType): Record<string, any> {
  const updates: Record<string, any> = {
    currentModuleType: moduleType,
    lastActivityAt: FieldValue.serverTimestamp(),
  }

  const hasInitial = session.initialModuleType !== null && session.initialModuleType !== undefined

  // system_notice never counts as initial handler
  if (!hasInitial && moduleType !== 'system_notice') {
    updates.initialModuleType = moduleType
    const handler: InitialHandler =
      moduleType === 'live_agent' ? 'human'
        : moduleType === 'ai' ? 'ai'
          : 'bot'
    updates.initialHandler = handler
    updates.currentHandler = handler
  }

  // Status transitions
  if (moduleType === 'live_agent') {
    updates.currentHandler = 'human'
    if (session.status !== 'human_handling') {
      updates.status = 'pending_human'
    }
  } else if (moduleType === 'welcome' || moduleType === 'bot_flow' || moduleType === 'ai') {
    // AI 與罐頭流程一樣屬「自動處理」，狀態歸 bot_handling（沒有獨立的 ai_handling 狀態）
    updates.currentHandler = moduleType === 'ai' ? 'ai' : 'bot'
    if (session.status === 'open') {
      updates.status = 'bot_handling'
    }
    // pending_human / human_handling are intentionally not overwritten here
  } else if (moduleType === 'system_notice') {
    // ⚠️ 這裡是「統計」與「佇列」分家的那一行。動它之前先讀
    //    docs/CONVERSATION-STATS-DEFINITIONS.md（含改動前檢查清單）。
    // 統計與佇列是兩件事，這裡是分界點：
    //   initialHandler（統計「誰回答了客人」）→ 上面刻意不記，系統通知不是客服回覆
    //   status（佇列「還需不需要人處理」）  → 必須移出 open，系統確實已經回應過客人
    // 先前兩者綁在一起，導致「客人問了、機器人用系統通知回了」的會話永遠掛在未首接。
    // currentHandler 也不動：沒有人「接手」，只是系統回了一則通知。
    if (session.status === 'open') {
      updates.status = 'bot_handling'
    }
  }

  // Record handoff_request on first live_agent entry
  if (moduleType === 'live_agent' && !session.hasHandoff) {
    updates.hasHandoff = true
    updates.handoffRequestedAt = FieldValue.serverTimestamp()
  }

  return updates
}

/**
 * Record a human agent's first reply in a session (after handoff).
 * Idempotent: only fires once per session.
 *
 * 「只記一次」的判斷與寫入放在同一個交易裡：先前是分開的兩步，兩個客服同時回話
 * 兩邊都會通過 humanFirstRepliedAt 的檢查，重複寫一筆 human_first_reply 事件。
 */
export async function recordHumanFirstReply(sessionId: string, userId: string): Promise<void> {
  const db = getDb()
  const sessionRef = db.collection('conversationSessions').doc(sessionId)

  const recorded = await db.runTransaction(async (tx) => {
    const sessionSnap = await tx.get(sessionRef)
    if (!sessionSnap.exists) return false
    const session = sessionSnap.data() as any
    if (session.humanFirstRepliedAt) return false

    tx.update(sessionRef, {
      humanFirstRepliedAt: FieldValue.serverTimestamp(),
      humanLastRepliedAt: FieldValue.serverTimestamp(),
      status: 'human_handling' as ConversationStatus,
      currentHandler: 'human' as InitialHandler,
      currentModuleType: 'live_agent' as ModuleType,
      lastActivityAt: FieldValue.serverTimestamp(),
    })
    return true
  })
  if (!recorded) return

  _updateSessionStatusCache(sessionId, 'human_handling')
  await recordConversationEvent(sessionId, userId, 'human_first_reply')
}

/**
 * 把 pending_human / human_handling 的會話交還機器人，bot/AI 恢復接手後續訊息。
 * 觸發來源：後台「交還機器人」按鈕，或 auto-handback 排程（真人閒置過久）。
 * 回傳 false = session 不存在或目前狀態不可交還（已結束 / 本來就是 bot）。
 */
export async function handBackSessionToBot(
  sessionId: string,
  userId: string,
): Promise<boolean> {
  const db = getDb()
  const sessionRef = db.collection('conversationSessions').doc(sessionId)
  const sessionSnap = await sessionRef.get()
  if (!sessionSnap.exists) return false

  const session = sessionSnap.data() as any
  if (session.status !== 'pending_human' && session.status !== 'human_handling') return false

  await sessionRef.update({
    status: 'bot_handling' as ConversationStatus,
    currentHandler: 'bot' as InitialHandler,
    currentModuleType: 'bot_flow' as ModuleType,
    lastActivityAt: FieldValue.serverTimestamp(),
  })
  _updateSessionStatusCache(sessionId, 'bot_handling')
  await recordConversationEvent(sessionId, lineUserIdFromFirestoreDocId(userId), 'returned_to_bot')
  return true
}

/**
 * Close a conversation session. Idempotent.
 */
export async function closeConversationSession(sessionId: string, userId: string): Promise<void> {
  const db = getDb()
  const lineUserId = lineUserIdFromFirestoreDocId(userId)
  const convDocId = lineUserFirestoreDocId(lineUserId)
  const sessionRef = db.collection('conversationSessions').doc(sessionId)
  const sessionSnap = await sessionRef.get()
  if (!sessionSnap.exists) return

  const session = sessionSnap.data() as any
  if (session.status === 'closed') return

  await sessionRef.update({
    status: 'closed' as ConversationStatus,
    closedAt: FieldValue.serverTimestamp(),
    lastActivityAt: FieldValue.serverTimestamp(),
  })
  _updateSessionStatusCache(sessionId, 'closed')
  _invalidateUserSessionCache(lineUserId)
  await db.collection('conversations').doc(convDocId).set(
    { currentSessionId: null },
    { merge: true },
  )
  await recordConversationEvent(sessionId, lineUserId, 'conversation_closed')
}

/**
 * 待真人或真人處理中：使用者文字不應再觸發機器人（activeInput、自動回覆含 anyText），
 * 避免與真人客服對話時誤觸「輸入任何內容」等規則。
 */
export async function shouldSuppressInboundBotAutomationForSession(
  sessionId: string | null | undefined,
): Promise<boolean> {
  const status = await getSessionStatusCached(sessionId)
  return status === 'pending_human' || status === 'human_handling'
}

/**
 * 取得 session status（走 SESSION_STATUS_TTL_MS 這份短快取）。
 * 給「等待真人期間的輕量 ack」這類需要區分 pending_human / human_handling 的 caller 用。
 *
 * 過期就回讀 Firestore：這個值會被別的行程改（客服接手 / cron 交還 / 結束會話），
 * 拿舊值的代價是機器人跟真人搶著回話，所以寧可多一次 doc read。
 */
export async function getSessionStatusCached(
  sessionId: string | null | undefined,
): Promise<ConversationStatus | null> {
  if (!sessionId) return null

  const cached = sessionStatusById.get(sessionId)
  if (cached && Date.now() - cached.cachedAt < SESSION_STATUS_TTL_MS) {
    return cached.status
  }

  return refreshSessionStatusFromDb(sessionId)
}

export async function onHumanOutgoingMessage(userId: string, workspaceId: string): Promise<void> {
  const db = getDb()
  const convDocId = lineUserFirestoreDocId(lineUserIdFromFirestoreDocId(userId, workspaceId), workspaceId)
  const convSnap = await db.collection('conversations').doc(convDocId).get()
  const sessionId = convSnap.data()?.currentSessionId as string | undefined
  if (!sessionId) return

  const sessionRef = db.collection('conversationSessions').doc(sessionId)

  // 「真人首接 vs 轉真人」的判斷與寫入放在同一個交易裡。先前是分開兩步，
  // 兩位客服（或客服＋自動流程）同時動作時，兩邊都讀到同一份舊狀態，
  // 可能把「轉真人」誤記成「真人首接」，或漏掉 hasHandoff。
  const result = await db.runTransaction(async (tx) => {
    const sessionSnap = await tx.get(sessionRef)
    const session = sessionSnap.data()
    if (!session || session.status === 'closed') return null

    // 已正式轉真人（pending_human）等真人首次回覆 → 記首次回覆（hasHandoff 已於進 live_agent 時設定）
    if (session.status === 'pending_human' && !session.humanFirstRepliedAt) {
      tx.update(sessionRef, {
        humanFirstRepliedAt: FieldValue.serverTimestamp(),
        humanLastRepliedAt: FieldValue.serverTimestamp(),
        status: 'human_handling' as ConversationStatus,
        currentHandler: 'human' as InitialHandler,
        currentModuleType: 'live_agent' as ModuleType,
        lastActivityAt: FieldValue.serverTimestamp(),
      })
      return { isFirstHumanReply: true, newHandoff: false }
    }

    // 已在真人處理中 → 只更新「真人最後回覆時間」（auto-handback 用；與 lastActivityAt 分開，
    // 因為 lastActivityAt 客人傳訊也會動）
    if (session.status === 'human_handling') {
      tx.update(sessionRef, {
        lastActivityAt: FieldValue.serverTimestamp(),
        humanLastRepliedAt: FieldValue.serverTimestamp(),
      })
      return { isFirstHumanReply: false, newHandoff: false }
    }

    // 其餘（open / bot_handling）＝ 真人「直接在收件匣接手」。
    // 依「在他回覆之前有沒有人接過」補記，並把會話轉成真人處理中
    //（副作用：會停止機器人／AI 對後續訊息自動回覆，避免與真人搶話；閒置後由 auto-handback 交還）：
    //   - 之前沒人接（unhandled）→ 真人是第一個回覆的人 → 記「真人首接」
    //   - 機器人／AI 已先接過      → 真人後來接手           → 記「轉真人」
    const alreadyHandled
      = session.initialHandler === 'bot' || session.initialHandler === 'ai' || session.initialHandler === 'human'
    const updates: Record<string, any> = {
      status: 'human_handling' as ConversationStatus,
      currentHandler: 'human' as InitialHandler,
      currentModuleType: 'live_agent' as ModuleType,
      lastActivityAt: FieldValue.serverTimestamp(),
      humanLastRepliedAt: FieldValue.serverTimestamp(),
    }
    const isFirstHumanReply = !session.humanFirstRepliedAt
    if (isFirstHumanReply) updates.humanFirstRepliedAt = FieldValue.serverTimestamp()

    let newHandoff = false
    if (!alreadyHandled) {
      // 真人首接
      updates.initialHandler = 'human' as InitialHandler
      updates.initialModuleType = 'live_agent' as ModuleType
    } else if (!session.hasHandoff) {
      // 轉真人
      updates.hasHandoff = true
      updates.handoffRequestedAt = FieldValue.serverTimestamp()
      newHandoff = true
    }

    tx.update(sessionRef, updates)
    return { isFirstHumanReply, newHandoff }
  })
  if (!result) return

  _updateSessionStatusCache(sessionId, 'human_handling')

  if (result.isFirstHumanReply) await recordConversationEvent(sessionId, userId, 'human_first_reply')
  if (result.newHandoff) await recordConversationEvent(sessionId, userId, 'handoff_request')
}
