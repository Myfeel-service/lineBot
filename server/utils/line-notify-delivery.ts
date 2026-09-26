/**
 * LINE 通知「送到了沒」的紀錄（`D-103`⑥／`C-270`，2026-09-27）。
 *
 * 為什麼要有：通知名單上的人封鎖了官方帳號、或推播被 LINE 退回時，原本只寫一行 log——
 * 小幫手的「沒有人會收到」只看名單是不是空的，名單上兩個人都封鎖了也不會亮。
 * ⛔ 這是這個專案一再吃虧的「靜默死亡」：每天照樣「發」，其實一則都沒送到。
 *
 * 存放：`lineNotifyDelivery/{workspaceId}` 一份文件，`recipients.{lineUserId}` 一格一人。
 * - 為什麼不寫進 `aiSettings`：每次推播都寫一次會打掉設定快取，而且 `setAiSettings` 是整份覆寫，
 *   兩邊同時寫會互相蓋掉。
 * - 為什麼不寫進成員文件：名單以 lineUserId 為準，推播當下不必再查是哪位成員。
 * - 小幫手提醒與「LINE 通知」頁都只要讀這**一份**（1 次讀取），不必逐一去讀客人資料。
 *
 * 三種訊號：
 * - `okAt`：最後一次送成功（推播或綁定成功的回覆）
 * - `failAt`／`failKind`／`failReason`：最後一次被退回，與它的原因
 * - `blockedAt`：對方封鎖／退好友（webhook 的 unfollow 一來就記；重新加好友時清掉）
 */
import type { messagingApi } from '@line/bot-sdk'
import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import { getDb } from './firebase'
import { pushMessage } from './line'

export const LINE_NOTIFY_DELIVERY_COLLECTION = 'lineNotifyDelivery'

export type NotifyFailKind = 'blocked' | 'quota' | 'other'

export interface NotifyRecipientDelivery {
  okAt?: number
  /** 最後一次成功送的是什麼：通知本身，還是綁定成功那則確認 */
  okKind?: 'notify' | 'confirm'
  failAt?: number
  failKind?: NotifyFailKind
  failReason?: string
  blockedAt?: number
}

/** 名單舊資料可能存成 `${workspaceId}_U…`；紀錄一律用純 lineUserId 當鑰匙 */
export function bareLineUserId(workspaceId: string, id: string): string {
  const v = String(id || '').trim()
  const prefix = `${workspaceId}_`
  return v.startsWith(prefix) ? v.slice(prefix.length) : v
}

/**
 * 被退回的原因翻成後台那一列看得懂的話。
 * LINE 對「封鎖」與「還沒加好友」回同一句（`describeLineSendFailure` 同一套判斷），所以一起講。
 */
export function classifyNotifyPushFailure(e: unknown): { kind: NotifyFailKind, reason: string } {
  const status = Number((e as { status?: unknown })?.status)
  const body = String((e as { body?: unknown })?.body ?? (e as { message?: unknown })?.message ?? '').toLowerCase()
  if (body.includes('blocked') || body.includes("hasn't added") || body.includes('has not added'))
    return { kind: 'blocked', reason: '對方封鎖了官方帳號，或還沒加好友' }
  if (status === 429 && (body.includes('monthly limit') || body.includes('quota')))
    return { kind: 'quota', reason: '官方帳號這個月的訊息額度用完了' }
  if (status === 401 || status === 403)
    return { kind: 'other', reason: 'LINE 連線資訊失效，要到「組織與 LINE」重新設定' }
  if (Number.isFinite(status) && status >= 500)
    return { kind: 'other', reason: 'LINE 那邊暫時有問題' }
  return { kind: 'other', reason: Number.isFinite(status) && status > 0 ? `LINE 回應 ${status}` : '連不上 LINE' }
}

export interface DeliveryEntry {
  lineUserId: string
  ok: boolean
  kind?: 'notify' | 'confirm'
  error?: unknown
}

/**
 * 記下這一批的結果。⛔ 紀錄失敗不影響通知本身（只寫 log）——但測試要斷言「成功時確實寫了」，
 * 不然 catch 會讓「一筆都沒寫」跟「正常」長得一樣。
 */
export async function recordNotifyDelivery(workspaceId: string, entries: DeliveryEntry[], db: Firestore = getDb()): Promise<void> {
  if (!workspaceId || !entries.length) return
  const now = Date.now()
  const recipients: Record<string, Record<string, unknown>> = {}
  for (const e of entries) {
    const id = bareLineUserId(workspaceId, e.lineUserId)
    if (!id) continue
    if (e.ok) {
      recipients[id] = { okAt: now, okKind: e.kind ?? 'notify' }
    }
    else {
      const f = classifyNotifyPushFailure(e.error)
      recipients[id] = { failAt: now, failKind: f.kind, failReason: f.reason }
      // LINE 明講封鎖／不是好友 → 跟 unfollow 事件同一格，重新加好友時一起清掉
      if (f.kind === 'blocked') recipients[id].blockedAt = now
    }
  }
  if (!Object.keys(recipients).length) return
  try {
    await db.collection(LINE_NOTIFY_DELIVERY_COLLECTION).doc(workspaceId).set({ recipients, updatedAt: now }, { merge: true })
  }
  catch (err) {
    console.warn('[notify-delivery] record failed:', workspaceId, err)
  }
}

/**
 * 推給通知名單上的每一位，並把每一位的結果記下來。
 * 回傳跟 `Promise.allSettled` 同一個形狀，呼叫端原本的判斷（全滅要不要重試）照舊。
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
 * webhook 看到名單上的人封鎖（unfollow）或重新加好友時呼叫。
 * 呼叫端先確認他在名單上（不在名單上的客人不需要這份紀錄）。
 */
export async function markNotifyRecipientBlocked(workspaceId: string, lineUserId: string, blocked: boolean, db: Firestore = getDb()): Promise<void> {
  const id = bareLineUserId(workspaceId, lineUserId)
  if (!workspaceId || !id) return
  try {
    await db.collection(LINE_NOTIFY_DELIVERY_COLLECTION).doc(workspaceId).set({
      recipients: { [id]: { blockedAt: blocked ? Date.now() : FieldValue.delete() } },
      updatedAt: Date.now(),
    }, { merge: true })
  }
  catch (err) {
    console.warn('[notify-delivery] mark blocked failed:', workspaceId, err)
  }
}

export async function readNotifyDelivery(workspaceId: string, db: Firestore = getDb()): Promise<Record<string, NotifyRecipientDelivery>> {
  const snap = await db.collection(LINE_NOTIFY_DELIVERY_COLLECTION).doc(workspaceId).get()
  const raw = snap.exists ? snap.data()?.recipients : null
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, NotifyRecipientDelivery> = {}
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue
    const d = v as Record<string, unknown>
    const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined)
    out[id] = {
      okAt: num(d.okAt),
      okKind: d.okKind === 'confirm' ? 'confirm' : d.okKind === 'notify' ? 'notify' : undefined,
      failAt: num(d.failAt),
      failKind: d.failKind === 'blocked' || d.failKind === 'quota' || d.failKind === 'other' ? d.failKind : undefined,
      failReason: typeof d.failReason === 'string' ? d.failReason.slice(0, 80) : undefined,
      blockedAt: num(d.blockedAt),
    }
  }
  return out
}

export type RecipientState =
  | { state: 'blocked', since: number }
  | { state: 'failing', at: number, reason: string }
  | { state: 'ok', at: number, kind: 'notify' | 'confirm' }
  | { state: 'never' }

/**
 * 一位收件人現在的狀態（「LINE 通知」頁那一列、小幫手提醒共用）。
 * - 封鎖優先：LINE 對封鎖的人推播不一定回錯，只看成功時間會把封鎖的人算成「送到了」
 * - 最後一次是失敗＝收不到（成功之後又失敗才算，舊的失敗被新的成功蓋過）
 */
export function recipientDeliveryState(d: NotifyRecipientDelivery | undefined): RecipientState {
  if (!d) return { state: 'never' }
  if (d.blockedAt) return { state: 'blocked', since: d.blockedAt }
  if (d.failAt && (!d.okAt || d.failAt > d.okAt)) return { state: 'failing', at: d.failAt, reason: d.failReason ?? '被 LINE 退回' }
  if (d.okAt) return { state: 'ok', at: d.okAt, kind: d.okKind ?? 'notify' }
  return { state: 'never' }
}
