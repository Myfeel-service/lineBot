import { FieldValue } from 'firebase-admin/firestore'
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
// TTL is intentionally short (10s) to limit stale-status window when admin changes session state.

interface SessionCacheEntry {
  sessionId: string
  status: ConversationStatus
  lastActivityAt: number  // JS ms timestamp
  cachedAt: number
  /** 已收過客人來訊(follow/活動出生的 session 在此之前不進首接統計) */
  hasInbound?: boolean
}
const SESSION_CACHE_TTL_MS = 30 * 1000
const sessionByUser = new Map<string, SessionCacheEntry>()   // lineUserId → entry
const sessionStatusById = new Map<string, { status: ConversationStatus; cachedAt: number }>() // sessionId → status

function requireWorkspaceId(workspaceId: string | undefined, context: string): string {
  const wid = String(workspaceId || '').trim()
  if (!wid) throw new Error(`workspaceId is required in ${context}`)
  return wid
}

export function _updateSessionStatusCache(sessionId: string, status: ConversationStatus) {
  sessionStatusById.set(sessionId, { status, cachedAt: Date.now() })
  // Also update per-user cache if it references this session
  for (const [uid, entry] of sessionByUser) {
    if (entry.sessionId === sessionId) {
      sessionByUser.set(uid, { ...entry, status, cachedAt: Date.now() })
      break
    }
  }
}

export function _invalidateUserSessionCache(lineUserId: string) {
  const entry = sessionByUser.get(lineUserId)
  if (entry) sessionStatusById.delete(entry.sessionId)
  sessionByUser.delete(lineUserId)
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
   */
  opts: { origin?: 'follow' } = {},
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
    cached.status !== 'closed' &&
    now - cached.lastActivityAt < SESSION_24H_MS
  ) {
    const bgUpdate: Record<string, unknown> = { lastActivityAt: FieldValue.serverTimestamp() }
    // 客人來訊 → 補記 hasInbound(布林、重寫冪等;快取記住後同 instance 只寫一次)
    if (!opts.origin && !cached.hasInbound) bgUpdate.hasInbound = true
    db.collection('conversationSessions').doc(cached.sessionId)
      .update(bgUpdate)
      .catch(e => console.warn('[session] bg lastActivityAt update failed:', e))
    sessionByUser.set(lineUserId, { ...cached, lastActivityAt: now, cachedAt: now, hasInbound: cached.hasInbound || !opts.origin })
    // Sync sessionStatusById so shouldSuppressInboundBotAutomationForSession gets a cache hit
    sessionStatusById.set(cached.sessionId, { status: cached.status, cachedAt: now })
    return cached.sessionId
  }

  // ── Slow path: Firestore transaction ─────────────────────────────
  // Pre-generate the new session ID outside the transaction so tx.set() can reference it.
  const newSessionId = uuidv4()
  const newSessionRef = db.collection('conversationSessions').doc(newSessionId)

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
      tx.update(existingRef, {
        status: 'closed' as ConversationStatus,
        closedAt: FieldValue.serverTimestamp(),
        lastActivityAt: FieldValue.serverTimestamp(),
      })
      closedOldSessionId = convData!.currentSessionId as string
    }

    tx.set(newSessionRef, {
      workspaceId,
      userId: lineUserId,
      openedAt: FieldValue.serverTimestamp(),
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
  sessionByUser.set(lineUserId, {
    sessionId: resultId,
    status: resultStatus,
    lastActivityAt: now,
    cachedAt: now,
    // 這次呼叫是客人來訊就一定有 inbound;follow 呼叫先設 false,下次來訊會補記
    hasInbound: !opts.origin,
  })
  sessionStatusById.set(resultId, { status: resultStatus, cachedAt: now })

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
 * Record that a module was entered in the current session.
 * Updates initial/current handler and status accordingly.
 * system_notice entries do NOT count toward initialHandler.
 */
export async function enterModule(
  sessionId: string,
  userId: string,
  moduleType: ModuleType,
  moduleId?: string,
  workspaceId?: string,
): Promise<void> {
  const wid = requireWorkspaceId(workspaceId, 'enterModule')
  const db = getDb()
  const sessionRef = db.collection('conversationSessions').doc(sessionId)
  const sessionSnap = await sessionRef.get()
  if (!sessionSnap.exists) return

  const session = sessionSnap.data() as any
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
  }

  // Record handoff_request on first live_agent entry
  const isNewHandoff = moduleType === 'live_agent' && !session.hasHandoff
  if (isNewHandoff) {
    updates.hasHandoff = true
    updates.handoffRequestedAt = FieldValue.serverTimestamp()
  }

  await sessionRef.update(updates)

  // Keep status cache in sync after module entry changes session status
  if (updates.status) {
    _updateSessionStatusCache(sessionId, updates.status as ConversationStatus)
  }

  if (moduleType === 'live_agent') {
    const uid = lineUserFirestoreDocId(lineUserIdFromFirestoreDocId(userId, wid), wid)
    await db
      .collection('users')
      .doc(uid)
      .update({ activeInput: FieldValue.delete() })
      .catch((e) => console.warn('[session] clear activeInput on live_agent:', e))
  }
  await recordConversationEvent(sessionId, lineUserIdFromFirestoreDocId(userId), 'entered_module', { moduleType, moduleId })
  if (isNewHandoff) {
    await recordConversationEvent(sessionId, lineUserIdFromFirestoreDocId(userId), 'handoff_request')
  }
}

/**
 * Record a human agent's first reply in a session (after handoff).
 * Idempotent: only fires once per session.
 */
export async function recordHumanFirstReply(sessionId: string, userId: string): Promise<void> {
  const db = getDb()
  const sessionRef = db.collection('conversationSessions').doc(sessionId)
  const sessionSnap = await sessionRef.get()
  if (!sessionSnap.exists) return

  const session = sessionSnap.data() as any
  if (session.humanFirstRepliedAt) return

  await sessionRef.update({
    humanFirstRepliedAt: FieldValue.serverTimestamp(),
    humanLastRepliedAt: FieldValue.serverTimestamp(),
    status: 'human_handling' as ConversationStatus,
    currentHandler: 'human' as InitialHandler,
    currentModuleType: 'live_agent' as ModuleType,
    lastActivityAt: FieldValue.serverTimestamp(),
  })
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
 * 取得 session status（走同一份 30 秒 cache）。
 * 給「等待真人期間的輕量 ack」這類需要區分 pending_human / human_handling 的 caller 用。
 */
export async function getSessionStatusCached(
  sessionId: string | null | undefined,
): Promise<ConversationStatus | null> {
  if (!sessionId) return null

  // Use cached status to avoid a redundant DB read (session was just read in ensureConversationSession)
  const now = Date.now()
  const cached = sessionStatusById.get(sessionId)
  if (cached && now - cached.cachedAt < SESSION_CACHE_TTL_MS) {
    return cached.status
  }

  const db = getDb()
  const snap = await db.collection('conversationSessions').doc(sessionId).get()
  if (!snap.exists) return null
  const status = snap.data()?.status as ConversationStatus | undefined
  if (status) sessionStatusById.set(sessionId, { status, cachedAt: now })
  return status ?? null
}

export async function onHumanOutgoingMessage(userId: string, workspaceId: string): Promise<void> {
  const db = getDb()
  const convDocId = lineUserFirestoreDocId(lineUserIdFromFirestoreDocId(userId, workspaceId), workspaceId)
  const convSnap = await db.collection('conversations').doc(convDocId).get()
  const sessionId = convSnap.data()?.currentSessionId as string | undefined
  if (!sessionId) return

  const sessionRef = db.collection('conversationSessions').doc(sessionId)
  const sessionSnap = await sessionRef.get()
  const session = sessionSnap.data()
  if (!session || session.status === 'closed') return

  // 已正式轉真人（pending_human）等真人首次回覆 → 走既有流程（hasHandoff 已於進 live_agent 時設定）
  if (session.status === 'pending_human' && !session.humanFirstRepliedAt) {
    await recordHumanFirstReply(sessionId, userId)
    return
  }

  // 已在真人處理中 → 只更新「真人最後回覆時間」（auto-handback 用；與 lastActivityAt 分開，
  // 因為 lastActivityAt 客人傳訊也會動）
  if (session.status === 'human_handling') {
    await sessionRef.update({
      lastActivityAt: FieldValue.serverTimestamp(),
      humanLastRepliedAt: FieldValue.serverTimestamp(),
    })
    return
  }

  // 其餘（open / bot_handling）＝ 真人「直接在收件匣接手」，先前完全沒被記帳。
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

  await sessionRef.update(updates)
  _updateSessionStatusCache(sessionId, 'human_handling')

  if (isFirstHumanReply) await recordConversationEvent(sessionId, userId, 'human_first_reply')
  if (newHandoff) await recordConversationEvent(sessionId, userId, 'handoff_request')
}
