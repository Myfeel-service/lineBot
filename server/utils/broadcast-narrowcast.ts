import { v5 as uuidv5 } from 'uuid'
import { FieldValue } from 'firebase-admin/firestore'
import { HTTPFetchError } from '@line/bot-sdk'
import {
  audienceReadiness,
  createRetargetAudience,
  deleteAudience,
  lineErrorText,
  narrowcastProgress,
  sendNarrowcast,
  uploadAudience,
} from './line-narrowcast'
import { multicastMessage } from './line'
import { broadcastOutcomePatch, writeFailedDeliveries } from './broadcast-outcome'
import { broadcastAggregationUnit } from '~~/shared/broadcast-insight'
import { parseFirestoreDate } from '~~/shared/firestore-date'
import { lineUserIdFromFirestoreDocId } from '~~/shared/line-workspace'
import {
  followUpAudienceKind,
  followUpRecipient,
  followUpSourceProblem,
  isFollowUpTarget,
  narrowcastFailureText,
} from '~~/shared/broadcast-follow-up'
import { BROADCAST_STUCK_SAFE_TO_RESEND, BROADCAST_STUCK_UNVERIFIED } from '~~/shared/broadcast-failure'
import type { BroadcastDoc, BroadcastNarrowcastState } from '~~/shared/types/tag-broadcast'

/**
 * 用 LINE narrowcast（先上傳名單、再發給名單）送推播（`D-154`②③，2026-10-28 老闆拍板）。
 *
 * ── 為什麼要換送法 ───────────────────────────────────────────────────
 * 只有 narrowcast 送的推播，LINE 事後才肯把「看過的人」「點過連結的人」圈成名單——
 * 「補發給沒打開的人」「發給點了／沒點連結的人」只能靠它（見 shared/broadcast-follow-up.ts）。
 *
 * ── 為什麼要分好幾步、跨好幾輪排程 ─────────────────────────────────
 * 上傳的名單 LINE 要先「準備好」（READY）才能送；2026-10-28 實測一個人的名單也要 87 秒。
 * 送出那一下（`executeBroadcastSend`）只上傳名單，推播停在「發送中」；之後每一輪排程
 * （`runDueScheduledBroadcasts`：Cloud Scheduler 的 trigger-scheduled，推播頁開著時每分鐘的 process-due）
 * 叫 `advanceNarrowcastBroadcasts` 往前推一步：
 *   audience（等名單）→ calling（叫 LINE 送）→ sending（LINE 收下了、在送）→ done（結果寫回推播）
 *
 * ── 出事時的退路 ─────────────────────────────────────────────────────
 * - **還沒送出去**（名單建不起來、30 分鐘還沒好、LINE 不收、LINE 回報一位都沒送到）：
 *   一般推播改用原本的群發送出去（客人照樣收得到、不會重複），推播記下原因（報表講「為什麼不能補發」）；
 *   補發沒有退路（是誰只有 LINE 知道），標失敗、可以放心重設再發。
 * - **不確定有沒有送出去**（叫 LINE 時斷線、LINE 一直沒回報）：⛔ 不自動重送，標失敗、講「不確定」，
 *   跟看門狗同一句（`BROADCAST_STUCK_UNVERIFIED`）。
 * - 總開關：環境變數 `BROADCAST_NARROWCAST=off` → 全部照舊群發（`narrowcastDisabled`）。
 */

/** 名單等這麼久還沒好就放棄（一般推播改用群發）。2026-10-28 實測上傳的名單 20～87 秒 */
const AUDIENCE_TIMEOUT_MS = 30 * 60_000
/**
 * 補發等 LINE 圈「看過／點過的人」的上限。2026-10-28 實測圈完 2 分半還在準備中、時間不固定；
 * 補發不是急件，又沒有群發的退路（放棄＝失敗），所以等久一點。
 */
const FOLLOW_UP_AUDIENCE_TIMEOUT_MS = 24 * 3600_000
/** 「叫 LINE 送」一直沒得到明確答覆（斷線、5xx）這麼久＝不確定有沒有送 */
const CALLING_TIMEOUT_MS = 30 * 60_000
/** LINE 收下了卻這麼久都沒回報送完 */
const SENDING_TIMEOUT_MS = 24 * 3600_000
/** 名單交出去之前就斷掉（快照寫了、名單沒記下來）＝一定沒送，等這麼久沒動靜就收掉（同看門狗） */
const PREPARE_STUCK_MS = 10 * 60_000
const ADVANCE_LIMIT = 20

/** 正式站出事時的總開關：BROADCAST_NARROWCAST=off → 一律照舊群發 */
export function narrowcastDisabled(): boolean {
  return String(process.env.BROADCAST_NARROWCAST ?? '').trim().toLowerCase() === 'off'
}

const NARROWCAST_RETRY_KEY_NS = '9a3e6c41-2d7b-4f58-b1c0-7e4d2a9f6b13'
/**
 * 送出的重送編號：同一則、同一輪（重設再發是新的一輪）永遠算出同一個——
 * 「叫了 LINE、還沒記下來就斷掉」下一輪再叫，LINE 認得是同一則、不會重複送。
 */
export function narrowcastRetryKey(broadcastId: string, retryCount: number): string {
  return uuidv5(`${broadcastId}:narrowcast:${retryCount}`, NARROWCAST_RETRY_KEY_NS)
}

type Ref = FirebaseFirestore.DocumentReference

/** LINE 名單上看得到的說明（LINE 官方帳號後台的「受眾」頁會列出來） */
function audienceDescription(kind: string, name: string): string {
  return `MiniMe ${kind}：${String(name || '').trim() || '推播'}`.slice(0, 120)
}

export type StartResult = { ok: true; estimate: number } | { ok: false; reason: string }

/**
 * 一般推播：上傳名單、記下進度（推播維持「發送中」）。失敗＝什麼都還沒送，呼叫端改用群發。
 */
export async function startNarrowcast(args: {
  ref: Ref
  workspaceId: string
  name: string
  lineUserIds: string[]
  messages: unknown[]
}): Promise<StartResult> {
  let gid: number
  try {
    gid = await uploadAudience(args.workspaceId, args.lineUserIds, audienceDescription('推播', args.name))
  }
  catch (e) {
    return { ok: false, reason: `LINE 名單建不起來：${lineErrorText(e)}` }
  }
  const state: BroadcastNarrowcastState = {
    phase: 'audience',
    waitAudienceGroupIds: [gid],
    uploadAudienceGroupId: gid,
    recipientJson: JSON.stringify({ type: 'audience', audienceGroupId: gid }),
    messagesJson: JSON.stringify(args.messages),
    preparedAt: Date.now(),
  }
  try {
    await args.ref.update({ narrowcast: state, updatedAt: FieldValue.serverTimestamp() })
  }
  catch (e) {
    await deleteAudience(args.workspaceId, gid)
    return { ok: false, reason: `記不下名單：${lineErrorText(e)}` }
  }
  return { ok: true, estimate: args.lineUserIds.length }
}

/**
 * 補發：請 LINE 圈出原本那則「看過／點過的人」，組出「發給誰」，記下進度。
 * 失敗＝什麼都還沒送；補發沒有群發的退路（是誰只有 LINE 知道），呼叫端標失敗。
 */
export async function startFollowUpNarrowcast(args: {
  db: FirebaseFirestore.Firestore
  ref: Ref
  workspaceId: string
  data: BroadcastDoc
  messages: unknown[]
}): Promise<StartResult> {
  const src = args.data.audienceSource ?? ({} as BroadcastDoc['audienceSource'])
  const target = src.followUpTarget
  if (!src.sourceBroadcastId || !isFollowUpTarget(target)) return { ok: false, reason: '補發的對象不完整，請從原本那則推播的成效報表重新按一次' }

  const srcSnap = await args.db.collection('broadcasts').doc(src.sourceBroadcastId).get()
  const s = srcSnap.data() as BroadcastDoc | undefined
  const problem = followUpSourceProblem(
    s
      ? {
          workspaceId: s.workspaceId,
          sendMode: s.sendMode ?? null,
          lineRequestId: s.lineRequestId ?? null,
          uploadAudienceGroupId: s.narrowcast?.uploadAudienceGroupId ?? null,
          completedMs: parseFirestoreDate(s.completedAt)?.getTime() ?? null,
        }
      : null,
    args.workspaceId,
    Date.now(),
  )
  if (problem || !s) return { ok: false, reason: problem ?? '原本那則推播已經不在了' }
  const uploadGid = Number(s.narrowcast?.uploadAudienceGroupId)

  const kind = followUpAudienceKind(target)
  let derivedGid: number
  try {
    derivedGid = await createRetargetAudience(args.workspaceId, kind, String(s.lineRequestId), audienceDescription(kind === 'impression' ? '看過的人' : '點過的人', s.name))
  }
  catch (e) {
    return { ok: false, reason: `LINE 圈不出${kind === 'impression' ? '看過' : '點過連結'}的人：${lineErrorText(e)}` }
  }
  const state: BroadcastNarrowcastState = {
    phase: 'audience',
    // 原本上傳的那份也要還能用（LINE 180 天會收掉）
    waitAudienceGroupIds: [derivedGid, uploadGid],
    uploadAudienceGroupId: null,
    recipientJson: JSON.stringify(followUpRecipient(target, uploadGid, derivedGid)),
    messagesJson: JSON.stringify(args.messages),
    preparedAt: Date.now(),
  }
  await args.ref.update({ narrowcast: state, updatedAt: FieldValue.serverTimestamp() })
  return { ok: true, estimate: Number(args.data.audienceSnapshot?.estimatedCount) || 0 }
}

// ── 排程每一輪往前推一步 ─────────────────────────────────────────────

export type AdvanceStats = { checked: number; called: number; finished: number; fellBack: number; failed: number }

/** 只在狀態還是「發送中」、進度還在預期那幾步時才改（兩台排程同時跑不會各做一次） */
async function guardedUpdate(
  ref: Ref,
  phases: Array<BroadcastNarrowcastState['phase']>,
  patch: Record<string, unknown>,
): Promise<boolean> {
  return ref.firestore.runTransaction(async (tx) => {
    const fresh = (await tx.get(ref)).data() as BroadcastDoc | undefined
    if (!fresh || fresh.status !== 'processing' || fresh.sendMode !== 'narrowcast') return false
    if (!phases.includes(fresh.narrowcast?.phase as BroadcastNarrowcastState['phase'])) return false
    tx.update(ref, { ...patch, updatedAt: FieldValue.serverTimestamp() })
    return true
  })
}

async function markFailed(ref: Ref, phases: Array<BroadcastNarrowcastState['phase']>, reason: string): Promise<boolean> {
  return guardedUpdate(ref, phases, { status: 'failed', failureReason: reason, 'narrowcast.phase': 'done' })
}

/**
 * 還沒送出去就卡住了：一般推播改用群發送出去；補發標失敗（可以放心重發）。
 * ⛔ 只在「確定 LINE 沒收下」時叫——不確定的走 markFailed(UNVERIFIED)。
 */
async function giveUpBeforeSending(ref: Ref, data: BroadcastDoc, phases: Array<BroadcastNarrowcastState['phase']>, reason: string): Promise<'fellBack' | 'failed' | 'skipped'> {
  const wid = String(data.workspaceId || '')
  const ncIds = data.narrowcast?.waitAudienceGroupIds ?? []
  if (data.audienceSource?.type === 'followUp') {
    const ok = await markFailed(ref, phases, `${reason}。訊息沒有送出去，可以按「重設為草稿」再發一次。`)
    // 只刪 LINE 剛圈的那份（第一個）；第二個是原本那則上傳的名單，之後別的補發還要用
    if (ok) await Promise.all(ncIds.slice(0, 1).map(id => deleteAudience(wid, id)))
    return ok ? 'failed' : 'skipped'
  }

  // 先把這一則改成「群發、進度結束」再送：兩台排程同時到這裡，只有一台拿得到
  const claimed = await guardedUpdate(ref, phases, { sendMode: 'multicast', narrowcastFallback: reason, 'narrowcast.phase': 'done' })
  if (!claimed) return 'skipped'
  await Promise.all(ncIds.map(id => deleteAudience(wid, id)))

  const full = (await ref.get()).data() as BroadcastDoc
  const recipients = (full.audienceSnapshot?.resolvedUserIds ?? [])
    .map((docId) => {
      const lineUserId = String(lineUserIdFromFirestoreDocId(docId, wid) || '').trim()
      return { docId, lineUserId }
    })
    .filter(r => Boolean(r.lineUserId))
  const messages = JSON.parse(full.narrowcast?.messagesJson || '[]')
  const unit = broadcastAggregationUnit(ref.id, Number(full.retryCount ?? 0) + 1)
  const res = await multicastMessage(recipients.map(r => r.lineUserId), messages, wid, { customAggregationUnits: [unit] })
  const outcome = {
    successCount: res.successCount,
    failedCount: res.failedIds.length,
    allFailed: res.successCount === 0,
    aggregationUnit: res.lineAggregationApplied ? unit : null,
    aggregationApplied: res.lineAggregationApplied,
  }
  await ref.update({ ...broadcastOutcomePatch(outcome), updatedAt: FieldValue.serverTimestamp() })
  const failedSet = new Set(res.failedIds)
  const postSendError = await writeFailedDeliveries(ref.firestore, ref.id, recipients.filter(r => failedSet.has(r.lineUserId)))
  if (postSendError) await ref.update({ postSendError }).catch(() => {})
  console.warn(`[broadcast-narrowcast] ${ref.id} 改用群發：${reason}（送到 ${res.successCount} 人）`)
  return 'fellBack'
}

async function callLine(ref: Ref, data: BroadcastDoc): Promise<'called' | 'fellBack' | 'failed' | 'pending' | 'skipped'> {
  const wid = String(data.workspaceId || '')
  const nc = data.narrowcast!
  // 先記「正在叫」再叫：斷在中間的話，下一輪看到 calling 會用同一個重送編號再叫一次
  const claimed = await guardedUpdate(ref, ['audience', 'calling'], {
    'narrowcast.phase': 'calling',
    'narrowcast.callingAt': nc.callingAt ?? Date.now(),
  })
  if (!claimed) return 'skipped'
  try {
    const requestId = await sendNarrowcast(
      wid,
      JSON.parse(nc.messagesJson),
      JSON.parse(nc.recipientJson),
      narrowcastRetryKey(ref.id, Number(data.retryCount ?? 0)),
    )
    await guardedUpdate(ref, ['calling'], {
      'narrowcast.phase': 'sending',
      'narrowcast.acceptedAt': Date.now(),
      'narrowcast.lastError': null,
      lineRequestId: requestId,
    })
    return 'called'
  }
  catch (e) {
    // 4xx（重送衝突與太頻繁以外）＝LINE 沒收下，什麼都沒送出去
    if (e instanceof HTTPFetchError && e.status >= 400 && e.status < 500 && e.status !== 409 && e.status !== 429) {
      const r = await giveUpBeforeSending(ref, data, ['calling'], `LINE 不收這一則：${lineErrorText(e)}`)
      return r === 'skipped' ? 'skipped' : r
    }
    // 斷線、5xx、太頻繁：不確定 LINE 有沒有收下 → 留在 calling，下一輪用同一個重送編號再叫
    const startedCalling = Number(nc.callingAt ?? Date.now())
    if (Date.now() - startedCalling > CALLING_TIMEOUT_MS) {
      return (await markFailed(ref, ['calling'], BROADCAST_STUCK_UNVERIFIED)) ? 'failed' : 'skipped'
    }
    await ref.update({ 'narrowcast.lastError': lineErrorText(e) }).catch(() => {})
    return 'pending'
  }
}

async function checkProgress(ref: Ref, data: BroadcastDoc): Promise<'finished' | 'fellBack' | 'failed' | 'pending' | 'skipped'> {
  const wid = String(data.workspaceId || '')
  const requestId = String(data.lineRequestId || '')
  const p = await narrowcastProgress(wid, requestId)
  if (p.phase === 'succeeded' || (p.phase === 'failed' && (p.successCount ?? 0) > 0)) {
    const success = p.successCount ?? 0
    const ok = await guardedUpdate(ref, ['sending'], {
      ...broadcastOutcomePatch({
        successCount: success,
        failedCount: p.failureCount ?? 0,
        allFailed: success === 0,
        // narrowcast 沒有彙總單位：打開／點連結人數拿 lineRequestId 問（broadcast-line-insight.ts）
        aggregationUnit: null,
        aggregationApplied: true,
        stoppedReason: success === 0 ? narrowcastFailureText(p.errorCode, p.failedDescription) : null,
      }),
      ...(p.targetCount != null ? { totalCount: p.targetCount } : {}),
      'narrowcast.phase': 'done',
    })
    return ok ? 'finished' : 'skipped'
  }
  if (p.phase === 'failed') {
    // 一位都沒送到＝什麼都沒送出去：一般推播改用群發
    const r = await giveUpBeforeSending(ref, data, ['sending'], narrowcastFailureText(p.errorCode, p.failedDescription))
    return r
  }
  if (Date.now() - Number(data.narrowcast?.acceptedAt ?? Date.now()) > SENDING_TIMEOUT_MS) {
    return (await markFailed(ref, ['sending'], BROADCAST_STUCK_UNVERIFIED)) ? 'failed' : 'skipped'
  }
  return 'pending'
}

/**
 * 排程每一輪叫一次：所有「發送中」的 narrowcast 推播各往前推一步。
 * workspaceId 空字串＝全站（排程器）；有值＝只推那一個帳號（推播頁的 process-due）。
 * ⛔ 一則出錯不連坐其他則：每一則各自 try。
 */
export async function advanceNarrowcastBroadcasts(
  db: FirebaseFirestore.Firestore,
  workspaceId = '',
): Promise<AdvanceStats> {
  const stats: AdvanceStats = { checked: 0, called: 0, finished: 0, fellBack: 0, failed: 0 }
  // 只拿判斷要的欄位（⛔ 受眾名單可能上千個編號，只有改用群發時才另外讀整份）
  const snap = await db.collection('broadcasts')
    .where('status', '==', 'processing')
    .select('workspaceId', 'name', 'status', 'sendMode', 'narrowcast', 'lineRequestId', 'retryCount', 'startedAt', 'updatedAt', 'audienceSource.type')
    .limit(ADVANCE_LIMIT)
    .get()

  for (const doc of snap.docs) {
    const data = doc.data() as BroadcastDoc
    if (data.sendMode !== 'narrowcast') continue
    if (workspaceId && String(data.workspaceId || '') !== workspaceId) continue
    stats.checked++
    try {
      const nc = data.narrowcast
      if (!nc?.phase) {
        // 快照寫了、名單還沒記下來就斷了：一定還沒送出去 → 跟看門狗同一句「可以放心重發」
        const last = Math.max(parseFirestoreDate(data.startedAt)?.getTime() ?? 0, parseFirestoreDate(data.updatedAt)?.getTime() ?? 0)
        if (Date.now() - last > PREPARE_STUCK_MS) {
          const ok = await doc.ref.firestore.runTransaction(async (tx) => {
            const fresh = (await tx.get(doc.ref)).data() as BroadcastDoc | undefined
            if (fresh?.status !== 'processing' || fresh.narrowcast?.phase) return false
            tx.update(doc.ref, { status: 'failed', failureReason: BROADCAST_STUCK_SAFE_TO_RESEND, updatedAt: FieldValue.serverTimestamp() })
            return true
          })
          if (ok) stats.failed++
        }
        continue
      }
      if (nc.phase === 'audience') {
        const states = await Promise.all(nc.waitAudienceGroupIds.map(id => audienceReadiness(String(data.workspaceId), id)))
        if (states.every(s => s.readiness === 'ready')) {
          const r = await callLine(doc.ref, data)
          if (r === 'called') stats.called++
          else if (r === 'fellBack') stats.fellBack++
          else if (r === 'failed') stats.failed++
        }
        else if (
          states.some(s => s.readiness === 'failed')
          || Date.now() - nc.preparedAt > (data.audienceSource?.type === 'followUp' ? FOLLOW_UP_AUDIENCE_TIMEOUT_MS : AUDIENCE_TIMEOUT_MS)
        ) {
          const why = states.find(s => s.readiness === 'failed')?.detail
          const waited = data.audienceSource?.type === 'followUp' ? '一整天' : ' 30 分鐘'
          const r = await giveUpBeforeSending(doc.ref, data, ['audience'], why ? `LINE 名單不能用（${why}）` : `LINE 名單${waited}都沒準備好`)
          if (r === 'fellBack') stats.fellBack++
          else if (r === 'failed') stats.failed++
        }
      }
      else if (nc.phase === 'calling') {
        const r = await callLine(doc.ref, data)
        if (r === 'called') stats.called++
        else if (r === 'fellBack') stats.fellBack++
        else if (r === 'failed') stats.failed++
      }
      else if (nc.phase === 'sending') {
        const r = await checkProgress(doc.ref, data)
        if (r === 'finished') stats.finished++
        else if (r === 'fellBack') stats.fellBack++
        else if (r === 'failed') stats.failed++
      }
    }
    catch (e) {
      console.error(`[broadcast-narrowcast] ${doc.id} 往前推失敗（下一輪再試）:`, lineErrorText(e))
      await doc.ref.update({ 'narrowcast.lastError': lineErrorText(e) }).catch(() => {})
    }
  }
  return stats
}
