/**
 * 指派通知（`H-16`，老闆 2026-10-20「照建議」）：同事在對話頁把客人指派給**別人**時，
 * 用官方帳號傳一則 LINE 給被指派的那位：「○○ 把客人「王小明」交給你」＋打開那段對話的短網址。
 *
 * 為什麼要有：指派（`C-67`）只在清單上掛一顆圓章，分線負責的團隊裡被指派的人不會知道——
 * 「指派了也沒人知道」等於沒指派。
 *
 * 規矩：
 * - ⛔ 指給自己不傳（按「我接手」自動指給自己的那條路根本不會走到這裡；下拉選自己也不傳）。
 * - 只傳給**綁了自己的 LINE、而且「收通知」開著**的人（`C-270`／`D-119`）。沒綁的不傳、不報錯；
 *   在「設定 → LINE 通知」把收通知關掉的人也不傳——那一頁關掉時跟他說的是「這支手機不會再收到通知」。
 * - 走既有那一套：推播＋送達紀錄（`pushToNotifyList`，送不到那一列會變黃）、短網址（`NOTIFY_LINKS_ENABLED`
 *   關著或沒有對外網址就退回「請至後台…」）。⛔ 不新開通道。
 * - 節流：同一位同事、同一位客人 10 分鐘內只傳一次（指派來回改的時候不洗版；per-instance，同 handoff 通知的取捨）。
 * - ⛔ 不吃勿擾時段：勿擾擋的是「客人找真人」（綁定回覆也是這樣講的），這一則是同事當下親手按的。
 * - ⛔ 失敗不能讓指派失敗：指派本身是主要的事，這一則只是順手告知（呼叫端照樣回成功）。
 * - ⛔ 不做自動輪流分派（客服的專長與班表系統不知道）。
 */
import type { messagingApi } from '@line/bot-sdk'
import type { Firestore } from 'firebase-admin/firestore'
import { getDb } from './firebase'
import { getAiSettings } from './ai-settings'
import { pushToNotifyList } from './line-notify-delivery'
import { conversationPath, createNotifyLink } from './notify-links'
import { capMapSize } from './bounded-cache'
import { notifyListHas } from '~~/shared/line-notify-list'
import { buildAssignNotifyText } from '~~/shared/line-notify-messages'
import { lineUserFirestoreDocId } from '~~/shared/line-workspace'

export const ASSIGN_NOTIFY_THROTTLE_MS = 10 * 60 * 1000
const ASSIGN_NOTIFY_MAP_MAX_ENTRIES = 5000
const lastAssignNotifiedAt = new Map<string, number>()

/** 這次為什麼傳／沒傳（呼叫端只記 log；測試靠它分得出「沒傳」是哪一種） */
export type AssignNotifyResult = 'self' | 'not-bound' | 'not-receiving' | 'throttled' | 'sent' | 'failed'

export interface AssignNotifyParams {
  workspaceId: string
  /** 被指派的同事 */
  assigneeUid: string
  /** 被指派的同事綁的 LINE（成員文件上的 `lineUserId`；沒綁＝空字串） */
  assigneeLineUserId: string
  /** 按下指派的人 */
  assignerUid: string
  assignerName: string
  /** 客人的 LINE userId（原始 `U…`，不是對話文件 id） */
  customerLineUserId: string
  db?: Firestore
}

/** 客人在 LINE 上的名字；拿不到（或存成了原始 id）就老實講「未知暱稱」（同逾時提醒的寫法） */
async function customerDisplayName(db: Firestore, workspaceId: string, customerLineUserId: string): Promise<string> {
  const snap = await db.collection('users').doc(lineUserFirestoreDocId(customerLineUserId, workspaceId)).get().catch(() => null)
  const raw = String(snap?.data()?.displayName ?? '').trim()
  return raw && raw !== customerLineUserId ? raw : `未知暱稱（…${customerLineUserId.slice(-6)}）`
}

export async function notifyAssignee(p: AssignNotifyParams): Promise<AssignNotifyResult> {
  if (!p.assigneeUid || p.assigneeUid === p.assignerUid) return 'self'
  const lineUserId = String(p.assigneeLineUserId ?? '').trim()
  if (!lineUserId) return 'not-bound'

  const key = `${p.workspaceId}:${p.assigneeUid}:${p.customerLineUserId}`
  /** 這一次有沒有佔位（失敗時只讓出自己佔的，⛔ 不可以把上一則成功留下的節流章一起清掉） */
  let claimed = false
  try {
    // ⚠️ getDb() 一定要在 try 裡面取（`C-254`／`C-271`⑧：寫在外面的話取不到就整支丟出去，指派跟著失敗）
    const db = p.db ?? getDb()
    // 名單以 getAiSettings() 那份為準（舊資料「名單有人但通知關著」已在 normalize 收成空名單）
    const settings = await getAiSettings(p.workspaceId, db)
    if (!notifyListHas(settings.handoffNotify?.lineUserIds ?? [], lineUserId)) return 'not-receiving'

    const now = Date.now()
    if (now - (lastAssignNotifiedAt.get(key) ?? 0) < ASSIGN_NOTIFY_THROTTLE_MS) return 'throttled'
    // 先佔位再送（同一秒按兩次不會傳兩則），送失敗再讓出來
    lastAssignNotifiedAt.set(key, now)
    claimed = true
    capMapSize(lastAssignNotifiedAt, ASSIGN_NOTIFY_MAP_MAX_ENTRIES)

    const [customerName, link] = await Promise.all([
      customerDisplayName(db, p.workspaceId, p.customerLineUserId),
      createNotifyLink(p.workspaceId, conversationPath(p.workspaceId, p.customerLineUserId), db).catch(() => undefined),
    ])
    const msg: messagingApi.TextMessage = {
      type: 'text',
      text: buildAssignNotifyText({ assignerName: p.assignerName.trim() || '同事', customerName, link }),
    }
    // 送達紀錄跟其他通知同一份：封鎖／不是好友的那位，「LINE 通知」頁那一列會變黃
    const [result] = await pushToNotifyList(p.workspaceId, [lineUserId], [msg], db)
    if (result?.status === 'fulfilled') return 'sent'
    lastAssignNotifiedAt.delete(key)
    console.warn('[assign-notify] push failed:', p.workspaceId, p.assigneeUid, (result as PromiseRejectedResult | undefined)?.reason)
    return 'failed'
  }
  catch (e) {
    if (claimed) lastAssignNotifiedAt.delete(key)
    console.warn('[assign-notify] failed:', p.workspaceId, p.assigneeUid, String((e as Error)?.message ?? e).slice(0, 200))
    return 'failed'
  }
}

/** 測試用：清掉節流表 */
export function _resetAssignNotifyThrottle(): void {
  lastAssignNotifiedAt.clear()
}
