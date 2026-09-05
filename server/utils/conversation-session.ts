import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from './firebase'
import { getAiSettings } from './ai-settings'
import { clearInactiveTagOnReturn } from './inactive-tag'
import {
  DEFAULT_LINE_WORKSPACE_ID,
  lineUserFirestoreDocId,
  lineUserIdFromFirestoreDocId,
} from '~~/shared/line-workspace'
import type {
  ConversationEventType,
  ConversationStatus,
  InitialHandler,
  ModuleType,
  SessionCloseReason,
} from '~~/shared/types/conversation-stats'
import { isHumanOwnedSessionStatus, SESSION_24H_MS } from '~~/shared/types/conversation-stats'
import { DEFAULT_HUMAN_SESSION_MAX_IDLE_HOURS } from '~~/shared/types/ai-knowledge'

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

/**
 * 寫一筆會話事件。
 *
 * `workspaceId` 是後補的欄位（舊資料沒有）：沒有它，讀取端只能先查出這位客人的每一場
 * 會話、再用 sessionId 分批 `in` 回來湊（見 messages.get.ts 的 loadEventItems）——因為
 * 用 userId 直接查會跨 workspace（同一個 LINE Provider 下的兩個 OA，同一位客人的 userId
 * 是同一組）。每個呼叫端本來就知道自己在哪個 workspace，寫下去以後新資料就能直接查，
 * 舊資料仍走原本的 join（要整個換掉得先回填）。
 */
export async function recordConversationEvent(
  sessionId: string,
  userId: string,
  eventType: ConversationEventType,
  extras?: {
    moduleType?: ModuleType
    moduleId?: string
    workspaceId?: string
    /** conversation_closed 專用：系統自動收尾時帶，時間軸才講得出是誰收的 */
    reason?: SessionCloseReason
  },
): Promise<void> {
  const db = getDb()
  const eventRef = db.collection('conversationEvents').doc()
  await eventRef.set({
    sessionId,
    userId,
    eventType,
    ...(extras?.workspaceId ? { workspaceId: extras.workspaceId } : {}),
    ...(extras?.moduleType ? { moduleType: extras.moduleType } : {}),
    ...(extras?.moduleId ? { moduleId: extras.moduleId } : {}),
    ...(extras?.reason ? { reason: extras.reason } : {}),
    timestamp: FieldValue.serverTimestamp(),
  })
}

/**
 * 真人接手中的會話「雙方都沒動靜」能撐多久（毫秒）。
 *
 * 下界鎖在 24 小時：工作區把時數設得比 24 小時短時，真人接手的場反而比機器人的場更早
 * 換場——那正是這次要修掉的行為。設得短的意思是「請 cron 早點收尾」，不是「請提早換場」。
 */
export function humanSessionMaxIdleMs(hours: unknown): number {
  const n = Number(hours)
  /**
   * 0 ＝「自動結束」關閉（預設，2026-08-21 拍板）→ 永不換場：真人接手的對話只有真人自己
   * 按「結束會話」／「交還機器人」才結束，時間到就換場等於系統代他放手。
   * 讀不出數字（設定讀取失敗、舊髒資料）也走這條：寧可讓那場繼續掛著，也不要在真人還沒
   * 放手時把客人交回 AI——那是這條規則存在的全部理由。
   */
  if (!Number.isFinite(n) || n <= 0) return Number.POSITIVE_INFINITY
  const ms = Math.round(n * 3600_000)
  return ms > SESSION_24H_MS ? ms : SESSION_24H_MS
}

/**
 * 這位客人現在是真人的嗎？（＝新開的這場要不要一開始就算真人在處理）
 *
 * 為什麼需要這個判斷：「現在誰在處理這位客人」以前只存在**進行中的那一場會話**上，
 * 會話一結束就整個歸零。但真人常常在沒有進行中會話時講話——客服回完順手按「結束會話」、
 * 或上一場早就到期被收掉、或主動發訊問候客人——那則訊息掛不到任何一場；客人一回話就開
 * 新的一場，而新的一場是從「沒人接手」起算，於是 AI 把真人的話接走：
 *   · 2026-08-17 14:52 真人回出貨進度 → 14:53 客服按結束 → 12 秒後客人追問「你們不是在
 *     台灣嗎？」→ AI 亂答委製進口商資訊
 *   · 2026-08-20 17:40 真人主動問「補寄商品收到了嗎」→ 24 分鐘後客人回「有收到」→ AI 接手
 *     連回三則
 * 正式資料近 7 天 593 場新會話中有 35 場（約 6%）是這樣開始的（STATUS `H-13`）。
 *
 * ⛔ **刻意不看時間**。老闆 2026-08-20 拍板：「真人沒有切就不要轉，等真人按下結束才結束。」
 * 所以這裡只問「真人有沒有放手」，不問「隔了多久」——放手只有兩種方式，都是真人自己按的：
 *   · 「結束會話」（closeConversationSession，客服手動那次）
 *   · 「交還機器人」（handBackSessionToBot）
 * 先前寫過一版 48 小時窗口（沿用 humanSessionMaxIdleHours），拍板後移除：時間到就自動把
 * 客人交回 AI，正是這條規則要防的事。
 *
 * 回傳真人那次動作的時間（寫進新會話的 humanLastRepliedAt，工作區若開了「閒置自動交還」
 * 才有基準）；不是真人的就回 null。
 */
function resolveHumanOwnership(
  convData: FirebaseFirestore.DocumentData | undefined,
): Timestamp | null {
  const raw = convData?.lastHumanActionAt
  // 只認得出時間的值（舊資料沒這欄、髒值都當「不是真人的」，不猜）
  return typeof raw?.toMillis === 'function' ? (raw as Timestamp) : null
}

/**
 * 真人放手了（按「結束會話」或「交還機器人」）→ 清掉「這位客人是真人的」那個記號，
 * AI／自動回覆從下一則訊息開始恢復接手。
 *
 * ⚠️ 系統自動收尾（排程把太久沒動靜的場關掉）**不可以**呼叫這支：那不是真人按的，
 * 清掉就等於「時間到自動把客人交回 AI」，正是拍板要防的事。
 */
async function releaseHumanOwnership(convDocId: string): Promise<void> {
  await getDb()
    .collection('conversations')
    .doc(convDocId)
    .set({ lastHumanActionAt: FieldValue.delete() }, { merge: true })
    .catch(e => console.warn('[session] release human ownership failed:', convDocId, e))
}

/**
 * 真人對這位客人動作了（送出訊息、或按「我接手」）→ 蓋上「這位客人是真人的」記號。
 *
 * 送出訊息那條路不走這裡（saveConversationMessage 寫對話文件時順手蓋，零額外寫入）；
 * 這支給「按了按鈕但還沒說話」用——客服按「我接手」就是宣告所有權，不該等他打字。
 */
export async function markHumanOwnership(userId: string, workspaceId: string): Promise<void> {
  const wid = requireWorkspaceId(workspaceId, 'markHumanOwnership')
  const lineUserId = lineUserIdFromFirestoreDocId(userId, wid)
  await getDb()
    .collection('conversations')
    .doc(lineUserFirestoreDocId(lineUserId, wid))
    .set({
      workspaceId: wid,
      userId: lineUserId,
      lastHumanActionAt: FieldValue.serverTimestamp(),
    }, { merge: true })
}

// ── Session Lifecycle ─────────────────────────────────────────────

/**
 * 關閉一場會話時，把「這場的最後一則訊息」快照到 session 文件上。
 *
 * 為什麼要快照：對話列表五個分頁的第二行都是訊息摘要，但 `conversations` 上的
 * `lastMessage` 是**對話層級**的最新一則。已結束的那場如果直接借用，就會被標上
 * 後來新會話的訊息，點進去時間軸對不上——列表在說謊。
 * 進行中的那場不需要快照（它就是 currentSessionId，兩者必定同一則）。
 *
 * ⚠️ 只在「對話的最後一則確實還屬於這場」時才蓋。24h 過期關閉是**新訊息觸發**的，
 * 而非文字訊息那條路徑（handler.ts 的 else 分支）是先送存檔、後 await 開會話，
 * 存檔有可能先落地——那時 conversations.lastMessage 已經是新那場的第一句了。
 * 用「訊息時間不得晚於這場的最後活動時間」擋掉：正常情況兩者幾乎同時（給 60 秒容差），
 * 搶跑的情況差距是 24 小時以上，分得很開。分不清就回空物件＝留白不猜。
 */
const CLOSE_SNAPSHOT_TOLERANCE_MS = 60_000

export function sessionClosingPreview(
  convData: Record<string, unknown> | undefined | null,
  sessionLastActivityAt: unknown,
): { lastMessage: string; lastDirection: 'incoming' | 'outgoing' } | Record<string, never> {
  const text = String(convData?.lastMessage ?? '')
  if (!text) return {}

  const msgMs = (convData?.lastMessageAt as any)?.toMillis?.() ?? 0
  const activityMs = (sessionLastActivityAt as any)?.toMillis?.() ?? 0
  // 任一邊沒有時間戳就不猜（舊資料、或 serverTimestamp 還沒解析）
  if (!msgMs || !activityMs) return {}
  if (msgMs > activityMs + CLOSE_SNAPSHOT_TOLERANCE_MS) return {}

  return {
    lastMessage: text,
    lastDirection: convData?.lastDirection === 'outgoing' ? 'outgoing' : 'incoming',
  }
}

/**
 * Close any non-closed sessions for a user that are not the current active session.
 * Handles orphaned sessions left by race conditions.
 *
 * 刻意不蓋 lastMessage 快照：孤兒是競態留下來的殘骸，它「真正的最後一則」無從得知，
 * 拿對話層級的最新一則去填就是亂猜。列表留白。
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
      recordConversationEvent(doc.id, lineUserId, 'conversation_closed', { workspaceId })
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
  //
  // 這裡的 24 小時**不放寬**給真人接手中的場：那要多讀一次工作區設定，而這條路的存在意義
  // 就是「什麼都不讀」。超過 24 小時就落到 slow path，由那邊決定續命或換場——
  // 代價只是客人隔天回來的那一則多跑一次交易，之後又回到 fast path。
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
  /** 這場是「延續真人對話」開的（要在交易外補一筆時間軸事件） */
  let humanLeadRecorded = false
  /**
   * 交易裡讀到的「客人上一次來訊」時間（舊值）——給交易後的「沒互動」摘標判斷用
   * （見 inactive-tag.ts）。文字訊息路徑存訊息在會話交易**之後**，所以這裡拿到的
   * 一定是更新前的值；拿它判斷「這位是不是沉睡了 N 天才回來」零額外讀取。
   */
  let prevInboundMsForReturnCheck = 0

  const resultId = await db.runTransaction(async (tx) => {
    // Firestore 競爭時會重跑整個 callback：上一輪留下的旗標一律歸零，
    // 否則被重試掉的那一輪會在交易外多記一筆事件（實際沒發生的事）
    createdNew = false
    closedOldSessionId = null
    resultStatus = 'open'
    humanLeadRecorded = false
    prevInboundMsForReturnCheck = 0

    const convSnap = await tx.get(convRef)
    const convData = convSnap.data()
    prevInboundMsForReturnCheck = (convData?.lastInboundMessageAt as Timestamp | undefined)?.toMillis?.() ?? 0

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
      const idleMs = now - lastActivity

      /**
       * 真人接手中的場不吃 24 小時換場（見 isHumanOwnedSessionStatus），改吃工作區設定的
       * 保底時限。設定只在「真的已經超過 24 小時、而且是真人接手中」時才去讀——那是客人隔了
       * 一天以上才回來的少數情況，一般訊息完全不碰這條路。
       *
       * 這筆讀取刻意不進交易：它是設定值不是要保證一致性的狀態（getAiSettings 有 60 秒快取，
       * 交易重試也不會真的重讀），拿進來只會讓交易的讀取集合白白變大。
       */
      let maxIdleMs = SESSION_24H_MS
      if (idleMs >= SESSION_24H_MS && isHumanOwnedSessionStatus(existingData.status)) {
        // 設定讀不到（Firestore 抖動、workspaceId 缺失）就退回預設值，**不是**退回 24 小時：
        // 退回 24 小時等於這條規則失效，客人那句話又會被 AI 搶走——而那正是要修的事。
        const hours = await getAiSettings(workspaceId, db)
          .then(s => s.humanSessionMaxIdleHours)
          .catch((e) => {
            console.warn('[session] settings read failed, using default max idle:', e)
            return DEFAULT_HUMAN_SESSION_MAX_IDLE_HOURS
          })
        maxIdleMs = humanSessionMaxIdleMs(hours)
      }

      if (idleMs < maxIdleMs) {
        tx.update(existingRef, {
          lastActivityAt: FieldValue.serverTimestamp(),
          ...(!opts.origin && !existingData.hasInbound ? { hasInbound: true } : {}),
        })
        resultStatus = existingData.status as ConversationStatus
        return convData!.currentSessionId as string
      }
      // 沒動靜太久 — close inline (event recorded outside the tx)
      // closedAt 收在「開啟新會話那句話的前一毫秒」：兩場的邊界要對齊，
      // 否則那句話會同時落在舊會話的窗口（<= closedAt）與新會話的窗口（>= openedAt）裡，
      // 客服在兩個分頁都看到同一句話。
      tx.update(existingRef, {
        status: 'closed' as ConversationStatus,
        closedAt: prevCloseAt,
        lastActivityAt: FieldValue.serverTimestamp(),
        // 這場的最後一則留一份給列表（convData 是這個 transaction 已經讀進來的，零額外讀取）
        ...sessionClosingPreview(convData, existingData.lastActivityAt),
      })
      closedOldSessionId = convData!.currentSessionId as string
    }

    /**
     * 這位客人已經是真人的（真人還沒按結束／交還）→ 這場一開始就算真人在處理
     * （見 resolveHumanOwnership）。只在「客人來訊開的場」判：origin='follow'
     * （加好友／活動入口）那種客人還沒開口，沒有任何一句話需要被搶，
     * 硬標成真人只會擋掉迎賓流程。
     */
    const humanLeadAt = opts.origin ? null : resolveHumanOwnership(convData)
    /**
     * 一個值兩個用途（寫進文件、寫進快取），**刻意只算一次**：分頭寫的話，
     * 文件說「真人處理中」而本行程的快取還說「沒人接手」，客人那一則照樣被 AI 接走
     * ——而且看文件完全看不出哪裡不對。
     */
    const newStatus: ConversationStatus = humanLeadAt ? 'human_handling' : 'open'

    tx.set(newSessionRef, {
      workspaceId,
      userId: lineUserId,
      openedAt,
      closedAt: null,
      lastActivityAt: FieldValue.serverTimestamp(),
      /**
       * 延續真人時只動「誰在處理」這一族欄位（status / currentHandler / currentModuleType），
       * ⛔ 統計那一族（initialHandler / initialModuleType / hasHandoff / humanFirstRepliedAt）
       * 一律留白：真人在**這一場**還沒回過話，先記成「真人首接」會讓「沒人回的對話」憑空消失
       * 一批——客人回一句「好，謝謝」而沒人理，帳面上會變成有人接了。
       * 真的回了那一刻由 onHumanOutgoingMessage 補記（它會認出這種還沒有首接紀錄的場）。
       */
      status: newStatus,
      initialHandler: 'unhandled' as InitialHandler,
      currentHandler: (humanLeadAt ? 'human' : 'unhandled') as InitialHandler,
      initialModuleType: null,
      currentModuleType: humanLeadAt ? ('live_agent' as ModuleType) : null,
      hasHandoff: false,
      handoffRequestedAt: null,
      humanFirstRepliedAt: null,
      // 自動交還機器人（handbackIdleMinutes）要有基準才收得掉這種場：沒有這一筆，
      // 它會 `continue` 跳過，開了自動交還的工作區反而永遠交不回來。
      ...(humanLeadAt ? { humanLastRepliedAt: humanLeadAt } : {}),
      // 出生方式:follow=加好友/活動入口(客人還沒開口);message=客人來訊。
      // origin='follow' 且尚無 hasInbound 的 session 不進首接統計(見 isPreInboundFollowSession)
      origin: opts.origin ?? 'message',
      hasInbound: !opts.origin,
    })
    // 快取要跟文件同一個值（否則這一則訊息自己還是會被 AI 接走），事件在交易外補記
    resultStatus = newStatus
    humanLeadRecorded = humanLeadAt != null
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
    recordConversationEvent(closedOldSessionId, lineUserId, 'conversation_closed', { workspaceId })
      .catch(e => console.warn('[session] close event record failed:', e))
  }
  if (createdNew) {
    // Event recording and orphan cleanup are independent — run in parallel, non-blocking
    Promise.all([
      recordConversationEvent(newSessionId, lineUserId, 'conversation_opened', { workspaceId }),
      // 時間軸要講出「為什麼這場一開始就是真人的」，否則客服只會看到 AI 忽然不回話了
      ...(humanLeadRecorded
        ? [recordConversationEvent(newSessionId, lineUserId, 'human_lead_continued', { workspaceId })]
        : []),
      closeOrphanedSessions(lineUserId, newSessionId, workspaceId),
    ]).catch(e => console.warn('[session] post-create cleanup failed:', e))
  }

  /**
   * 沉睡客回來了 → 摘掉「N 天沒互動」標籤（CRM 分眾，見 inactive-tag.ts）。
   * 放在慢路徑的交易之後：回來的客人必走慢路徑（快取早就沒了），而沒超過門檻的
   * 常態訊息在函式第一個 if 就返回＝零額外讀取。⛔ Lambda 上不可 fire-and-forget，
   * 所以 await；函式內部自己吞錯，不會拖垮收訊。
   */
  if (!opts.origin && prevInboundMsForReturnCheck) {
    await clearInactiveTagOnReturn(db, workspaceId, convDocId, prevInboundMsForReturnCheck, now)
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
  await recordConversationEvent(sid, lineUserIdFromFirestoreDocId(userId), 'entered_module', { moduleType, moduleId, workspaceId: wid })
  if (outcome.isNewHandoff) {
    await recordConversationEvent(sid, lineUserIdFromFirestoreDocId(userId), 'handoff_request', { workspaceId: wid })
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

  // 事件要帶 workspaceId，而這支的參數沒有——從交易裡讀到的那份會話文件拿，不必多讀一次
  let sessionWorkspaceId = ''
  const recorded = await db.runTransaction(async (tx) => {
    const sessionSnap = await tx.get(sessionRef)
    if (!sessionSnap.exists) return false
    const session = sessionSnap.data() as any
    sessionWorkspaceId = String(session.workspaceId ?? '')
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
  await recordConversationEvent(sessionId, userId, 'human_first_reply', { workspaceId: sessionWorkspaceId })
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
  /**
   * 「交還機器人」＝真人明確放手，所以連「這位客人是真人的」記號一起清掉。
   * 不清的話這場雖然回到機器人，客人**下一場**又會被判成真人的（記號還在），
   * 客服會覺得那顆按鈕只生效一次。
   */
  const wid = String(session.workspaceId ?? '') || DEFAULT_LINE_WORKSPACE_ID
  await releaseHumanOwnership(
    lineUserFirestoreDocId(lineUserIdFromFirestoreDocId(userId, wid), wid),
  )
  _updateSessionStatusCache(sessionId, 'bot_handling')
  await recordConversationEvent(sessionId, lineUserIdFromFirestoreDocId(userId), 'returned_to_bot', { workspaceId: String(session.workspaceId ?? '') })
  return true
}

/**
 * Close a conversation session. Idempotent.
 *
 * `opts.reason` 只有系統自動收尾時才帶（見 SessionCloseReason）：時間軸要分得出
 * 「客服按了結束」與「系統看它太久沒動靜幫忙收的」，並在 session 上留可回查的標記
 * （欄位沿用 scripts/close-stale-open-sessions.ts 那組，一次查詢就能撈出所有機器關掉的場）。
 *
 * `opts.preserveLastActivityAt`＝關掉它，但**不要**把「最後活動時間」蓋成現在（`D-64`）。
 *
 * ⛔ **這個選項是整條收尾機制的關鍵，不要順手拿掉**：AI 讀對話貼標籤與「AI 發現新標籤」
 * 兩支排程，撈的都是「已結束 **而且** 最後活動時間在游標／兩週窗之後」的對話。
 * 收尾如果照常蓋成現在，那 2,978 場躺了幾個月的舊對話會**整批跳到游標後面**，
 * 被當成「剛剛結束」拿去跑 AI ——那是約三千次 LLM（以每 10 分鐘 8 場計要跑 62 小時），
 * 而且會生出一大批三個月前對話的標籤建議倒進收件匣。
 * `ai-tag-suggest.ts` 檔頭明寫「開關剛打開從現在開始，**不追歷史**」，蓋時間等於繞過那個決定。
 * 保留原值同時也更誠實：**排程幫忙收尾不是「活動」**，那場對話最後真的有事發生就是三個月前。
 */
export async function closeConversationSession(
  sessionId: string,
  userId: string,
  opts: { reason?: SessionCloseReason, preserveLastActivityAt?: boolean } = {},
): Promise<void> {
  const db = getDb()
  const sessionRef = db.collection('conversationSessions').doc(sessionId)
  const sessionSnap = await sessionRef.get()
  if (!sessionSnap.exists) return

  const session = sessionSnap.data() as any
  if (session.status === 'closed') return

  /**
   * 主鍵要用**這場會話自己的** workspaceId 去組。先前一律用預設工作區，於是非預設工作區
   * 按下「結束會話」時，`currentSessionId: null` 會寫進一份不存在的 `default_U…` 文件，
   * 真正那份還指著這場已結束的會話（下次來訊靠 status==='closed' 才勉強自癒），
   * 而列表要的最後一則訊息快照也永遠讀不到、留白。
   */
  const workspaceId = String(session.workspaceId ?? '') || DEFAULT_LINE_WORKSPACE_ID
  const lineUserId = lineUserIdFromFirestoreDocId(userId, workspaceId)
  const convDocId = lineUserFirestoreDocId(lineUserId, workspaceId)

  // 手動按「結束會話」：這場就是進行中那場，對話的最後一則必然屬於它。
  // 不是的話（殘留的舊 session）就不蓋，留白不猜。
  const convRef = db.collection('conversations').doc(convDocId)
  const convData = (await convRef.get()).data()
  const isCurrent = convData?.currentSessionId === sessionId
  const preview = isCurrent ? sessionClosingPreview(convData, session.lastActivityAt) : {}

  await sessionRef.update({
    status: 'closed' as ConversationStatus,
    closedAt: FieldValue.serverTimestamp(),
    // ⛔ 見函式註解：保留原值是「別讓幾個月前的舊對話整批跑去餵 AI」的唯一機制
    ...(opts.preserveLastActivityAt ? {} : { lastActivityAt: FieldValue.serverTimestamp() }),
    ...preview,
    ...(opts.reason
      ? { staleClosedAt: FieldValue.serverTimestamp(), staleClosedReason: opts.reason }
      : {}),
  })
  _updateSessionStatusCache(sessionId, 'closed')
  _invalidateUserSessionCache(lineUserId)
  /**
   * 只有在這場**確實是**對話目前指著的那一場時才清指標。無條件清會誤傷：關掉一場殘留的
   * 舊 session（競態留下的孤兒，或排程收殮到的那種）時，會把對話指向進行中那場的指標
   * 一起抹掉——下一則訊息就找不到現在這場，於是又開一場新的，客人講到一半的對話被切成兩段。
   */
  /**
   * 真人按下「結束會話」＝他放手了 → 連「這位客人是真人的」記號一起清掉，
   * 客人下次來訊由 AI／自動回覆正常接手。這就是老闆拍板的那條線：**要結束，
   * 得有人按**（見 resolveHumanOwnership）。
   * ⛔ `opts.reason` 有值＝系統排程幫忙收的，**不可以**清：那會變成「時間到就自動把
   * 客人交回 AI」，正是這次要修掉的行為。
   */
  const releaseHuman = !opts.reason
  if (isCurrent || releaseHuman) {
    await convRef.set(
      {
        ...(isCurrent ? { currentSessionId: null } : {}),
        ...(releaseHuman ? { lastHumanActionAt: FieldValue.delete() } : {}),
      },
      { merge: true },
    )
  }
  await recordConversationEvent(sessionId, lineUserId, 'conversation_closed', {
    workspaceId: String(session.workspaceId ?? ''),
    ...(opts.reason ? { reason: opts.reason } : {}),
  })
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

    /**
     * 真人那側、但這場還沒有人真的回過話 → 這一則就是這場的真人首次回覆。
     *
     * 兩種來源：①正式轉真人（pending_human）等真人回覆，hasHandoff 已於進 live_agent 時設定
     * ②「延續真人對話」開場的（human_handling，見 ensureConversationSession 的 humanLeadAt）——
     * 那種場刻意沒有預先蓋首接欄位，所以這裡要補記，否則客服明明回了，統計仍算這場沒人回。
     */
    if (isHumanOwnedSessionStatus(session.status) && !session.humanFirstRepliedAt) {
      tx.update(sessionRef, {
        humanFirstRepliedAt: FieldValue.serverTimestamp(),
        humanLastRepliedAt: FieldValue.serverTimestamp(),
        status: 'human_handling' as ConversationStatus,
        currentHandler: 'human' as InitialHandler,
        currentModuleType: 'live_agent' as ModuleType,
        lastActivityAt: FieldValue.serverTimestamp(),
        // 轉真人來的場首接欄位已由 enterModule(live_agent) 記過，不重蓋；
        // 延續真人開場的場沒人記過 → 真人是這場第一個回覆的人（不是「轉真人」，本來就是他的）
        ...(session.initialModuleType
          ? {}
          : {
              initialHandler: 'human' as InitialHandler,
              initialModuleType: 'live_agent' as ModuleType,
            }),
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

  if (result.isFirstHumanReply) await recordConversationEvent(sessionId, userId, 'human_first_reply', { workspaceId })
  if (result.newHandoff) await recordConversationEvent(sessionId, userId, 'handoff_request', { workspaceId })
}
