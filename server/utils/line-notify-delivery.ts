/**
 * LINE 通知「送到了沒」的紀錄（`D-103`⑥／`C-270`，2026-09-27）。
 *
 * 為什麼要有：通知名單上的人封鎖了官方帳號、或推播被 LINE 退回時，原本只寫一行 log——
 * 小幫手的「沒有人會收到」只看名單是不是空的，名單上兩個人都封鎖了也不會亮。
 * ⛔ 這是這個專案一再吃虧的「靜默死亡」：每天照樣「發」，其實一則都沒送到。
 *
 * 存放：`lineNotifyDelivery/{workspaceId}` 一份文件，`recipients.{lineUserId}` 一格一人。
 * - 為什麼不寫進 `aiSettings`：每次推播都寫一次會打掉設定快取，而且設定有自己的寫入規矩。
 * - 為什麼不寫進成員文件：名單以 lineUserId 為準，推播當下不必再查是哪位成員。
 * - 小幫手提醒與「LINE 通知」頁都只要讀這**一份**（1 次讀取），不必逐一去讀客人資料。
 *
 * 四種訊號（2026-09-27 `C-271` 拆開「一時」與「一直」）：
 * - `okAt`：最後一次送成功（推播或綁定成功的回覆）
 * - `failAt`／`failKind`／`failReason`：最後一次被**一直會失敗的原因**退回（封鎖／不是好友、額度用完、連線資訊失效、內容被拒）
 * - `glitchAt`／`glitchReason`：最後一次**一時的**失敗（LINE 5xx、送太快、斷線）——⛔ 不算「收不到」，
 *   原本跟封鎖一樣算，早上 LINE 抖一下就亮「沒有人會收到」到隔天
 * - `blockedAt`／`blockedVia`：封鎖（webhook 的 unfollow）或推播被退回說「封鎖或還沒加好友」；
 *   重新加好友（follow 事件）時連同退件紀錄一起清掉
 */
import type { messagingApi } from '@line/bot-sdk'
import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import { getDb } from './firebase'
import { pushMessage } from './line'
import { getAiSettings } from './ai-settings'
import { normalizeLineUserId, notifyListHas } from '~~/shared/line-notify-list'
import { lineSendFailureKind } from './line-send-error'

export const LINE_NOTIFY_DELIVERY_COLLECTION = 'lineNotifyDelivery'

/** 一直會失敗的原因（算「收不到」）；`transient`＝一時的（不算） */
export type NotifyFailKind = 'blocked' | 'quota' | 'auth' | 'invalid' | 'transient'

export interface NotifyRecipientDelivery {
  okAt?: number
  /** 最後一次成功送的是什麼：通知本身，還是綁定成功那則確認 */
  okKind?: 'notify' | 'confirm'
  failAt?: number
  failKind?: Exclude<NotifyFailKind, 'transient'>
  failReason?: string
  glitchAt?: number
  glitchReason?: string
  blockedAt?: number
  /** unfollow＝webhook 確定封鎖；push＝推播被退回（LINE 對封鎖與還沒加好友回同一句，分不出來） */
  blockedVia?: 'unfollow' | 'push'
}

/**
 * 被退回的原因翻成後台那一列看得懂的話。種類判斷走 `line-send-error.ts` 那一份（⛔ 不另判一次）。
 */
export function classifyNotifyPushFailure(e: unknown): { kind: NotifyFailKind, reason: string } {
  switch (lineSendFailureKind(e)) {
    // LINE 對「封鎖」與「還沒加好友」回同一句 → 一起講
    case 'blocked': return { kind: 'blocked', reason: '對方封鎖了官方帳號，或還沒加好友' }
    case 'monthlyQuota': return { kind: 'quota', reason: '官方帳號這個月的訊息額度用完了' }
    case 'auth': return { kind: 'auth', reason: 'LINE 連線資訊失效，要到「組織與 LINE」重新設定' }
    case 'tooLong':
    case 'badRequest':
    case 'other': return { kind: 'invalid', reason: 'LINE 不收這則訊息' }
    case 'rateLimited': return { kind: 'transient', reason: '送太快被 LINE 暫時擋下' }
    case 'server': return { kind: 'transient', reason: 'LINE 那邊暫時有問題' }
    default: return { kind: 'transient', reason: '連不上 LINE' }
  }
}

export interface DeliveryEntry {
  lineUserId: string
  ok: boolean
  kind?: 'notify' | 'confirm'
  error?: unknown
}

/**
 * 記下這一批的結果。⛔ 紀錄失敗不影響通知本身（只寫 log）——連 `getDb()` 都在 try 裡面取
 * （`C-271`⑧：原本寫成預設參數、在 try 外面求值，取不到時整支 reject，已經送出的每日摘要
 * 被當成失敗、下一輪再發一次；跟 `C-254` 同一種型）。
 */
export async function recordNotifyDelivery(workspaceId: string, entries: DeliveryEntry[], db?: Firestore): Promise<void> {
  try {
    if (!workspaceId || !entries.length) return
    const now = Date.now()
    const recipients: Record<string, Record<string, unknown>> = {}
    for (const e of entries) {
      const id = normalizeLineUserId(e.lineUserId)
      if (!id) continue
      if (e.ok) {
        recipients[id] = { okAt: now, okKind: e.kind ?? 'notify' }
        continue
      }
      const f = classifyNotifyPushFailure(e.error)
      if (f.kind === 'transient') {
        recipients[id] = { glitchAt: now, glitchReason: f.reason }
        continue
      }
      recipients[id] = { failAt: now, failKind: f.kind, failReason: f.reason }
      // LINE 明講封鎖／不是好友 → 跟 unfollow 同一格，加好友時一起清掉
      if (f.kind === 'blocked') Object.assign(recipients[id], { blockedAt: now, blockedVia: 'push' })
    }
    if (!Object.keys(recipients).length) return
    await (db ?? getDb()).collection(LINE_NOTIFY_DELIVERY_COLLECTION).doc(workspaceId).set({ recipients, updatedAt: now }, { merge: true })
  }
  catch (err) {
    console.warn('[notify-delivery] record failed:', workspaceId, err)
  }
}

/**
 * 推給通知名單上的每一位，並把每一位的結果記下來。
 * 回傳跟 `Promise.allSettled` 同一個形狀，呼叫端原本的判斷（全滅要不要重試）照舊；
 * ⛔ 記錄那一步不會讓這支 reject（見 recordNotifyDelivery）。
 */
export async function pushToNotifyList(
  workspaceId: string,
  lineUserIds: string[],
  messages: messagingApi.Message[],
  db?: Firestore,
): Promise<PromiseSettledResult<unknown>[]> {
  const results = await Promise.allSettled(lineUserIds.map(uid => pushMessage(uid, messages, workspaceId)))
  await recordNotifyDelivery(workspaceId, lineUserIds.map((id, i) => {
    const r = results[i]!
    return { lineUserId: id, ok: r.status === 'fulfilled', kind: 'notify' as const, error: r.status === 'rejected' ? r.reason : undefined }
  }), db)
  return results
}

/**
 * 封鎖（unfollow）→ 記下來；重新加好友（follow）→ 連同退件紀錄一起清掉。
 * ⚠️ 清的時候 `failAt`／`failKind`／`failReason` 也要清（`C-271`④）：封鎖期間被退回的那一筆比成功新，
 *    只清 blockedAt 的話照樣判成「收不到」，要等下一則真的送到才轉回來。
 */
export async function markNotifyRecipientBlocked(workspaceId: string, lineUserId: string, blocked: boolean, db?: Firestore): Promise<void> {
  try {
    const id = normalizeLineUserId(lineUserId)
    if (!workspaceId || !id) return
    const patch = blocked
      ? { blockedAt: Date.now(), blockedVia: 'unfollow' }
      : {
          blockedAt: FieldValue.delete(),
          blockedVia: FieldValue.delete(),
          failAt: FieldValue.delete(),
          failKind: FieldValue.delete(),
          failReason: FieldValue.delete(),
        }
    await (db ?? getDb()).collection(LINE_NOTIFY_DELIVERY_COLLECTION).doc(workspaceId).set({
      recipients: { [id]: patch },
      updatedAt: Date.now(),
    }, { merge: true })
  }
  catch (err) {
    console.warn('[notify-delivery] mark blocked failed:', workspaceId, err)
  }
}

/**
 * webhook 看到 follow／unfollow 時呼叫：這個人在通知名單上才記（不在名單上的客人——絕大多數——什麼都不寫）。
 * ⚠️ follow 一定要呼叫（`C-271`②）：還沒加好友就綁定的人，第一則被退回記成「封鎖」，
 *    他加好友時 users 文件原本不是 isBlocked，原本那條「解除封鎖」的路不會走到，那一列會永遠黃著。
 */
export async function syncNotifyRecipientFollowState(workspaceId: string, lineUserId: string, blocked: boolean): Promise<void> {
  try {
    const settings = await getAiSettings(workspaceId)
    if (!notifyListHas(settings.handoffNotify?.lineUserIds ?? [], lineUserId)) return
    await markNotifyRecipientBlocked(workspaceId, lineUserId, blocked)
  }
  catch (e) {
    console.warn('[notify-delivery] follow state sync failed:', e)
  }
}

export async function readNotifyDelivery(workspaceId: string, db?: Firestore): Promise<Record<string, NotifyRecipientDelivery>> {
  const snap = await (db ?? getDb()).collection(LINE_NOTIFY_DELIVERY_COLLECTION).doc(workspaceId).get()
  const raw = snap.exists ? snap.data()?.recipients : null
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, NotifyRecipientDelivery> = {}
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined)
  const str = (x: unknown) => (typeof x === 'string' ? x.slice(0, 80) : undefined)
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue
    const d = v as Record<string, unknown>
    out[id] = {
      okAt: num(d.okAt),
      okKind: d.okKind === 'confirm' ? 'confirm' : d.okKind === 'notify' ? 'notify' : undefined,
      failAt: num(d.failAt),
      failKind: d.failKind === 'blocked' || d.failKind === 'quota' || d.failKind === 'auth' || d.failKind === 'invalid' ? d.failKind : undefined,
      failReason: str(d.failReason),
      glitchAt: num(d.glitchAt),
      glitchReason: str(d.glitchReason),
      blockedAt: num(d.blockedAt),
      blockedVia: d.blockedVia === 'unfollow' || d.blockedVia === 'push' ? d.blockedVia : undefined,
    }
  }
  return out
}

export type RecipientState =
  | { state: 'blocked', since: number, via: 'unfollow' | 'push' }
  | { state: 'failing', at: number, reason: string }
  /** 一時的失敗：那一列講一句「下一則會再試」，⛔ 不算收不到、不亮提醒 */
  | { state: 'glitch', at: number, reason: string }
  | { state: 'ok', at: number, kind: 'notify' | 'confirm' }
  | { state: 'never' }

/** 算不算「收不到」（兩顆提醒共用）：只有封鎖與一直會失敗的原因算 */
export function isUndeliverable(s: RecipientState): boolean {
  return s.state === 'blocked' || s.state === 'failing'
}

/**
 * 一位收件人現在的狀態（「LINE 通知」頁那一列、小幫手提醒共用）。
 * - 封鎖優先：LINE 對封鎖的人推播不一定回錯，只看成功時間會把封鎖的人算成「送到了」
 * - 最後一次是「一直會失敗」的退件＝收不到（成功之後又失敗才算，舊的失敗被新的成功蓋過）
 * - 最後一次是一時的失敗＝glitch（不算收不到）
 */
export function recipientDeliveryState(d: NotifyRecipientDelivery | undefined): RecipientState {
  if (!d) return { state: 'never' }
  if (d.blockedAt) return { state: 'blocked', since: d.blockedAt, via: d.blockedVia ?? 'unfollow' }
  const okAt = d.okAt ?? 0
  if (d.failAt && d.failAt > okAt) return { state: 'failing', at: d.failAt, reason: d.failReason ?? '被 LINE 退回' }
  if (d.glitchAt && d.glitchAt > okAt && d.glitchAt > (d.failAt ?? 0)) return { state: 'glitch', at: d.glitchAt, reason: d.glitchReason ?? 'LINE 那邊暫時有問題' }
  if (d.okAt) return { state: 'ok', at: d.okAt, kind: d.okKind ?? 'notify' }
  return { state: 'never' }
}
