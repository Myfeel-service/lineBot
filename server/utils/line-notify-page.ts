/**
 * 「設定 → LINE 通知」頁與首頁那張卡要的資料（`D-103`／`C-270`，2026-09-27）。
 * 端點只做權限與回應，組資料的邏輯放這裡，方便測。
 */
import type { Firestore } from 'firebase-admin/firestore'
import { getDb, getFirebaseAuth } from './firebase'
import { readAiSettingsFresh } from './ai-settings'
import { normalizeLineUserId, notifyListHas } from '~~/shared/line-notify-list'
import { compareMembersForList } from '~~/shared/member-order'
import { HANDOFF_NOTIFY_MAX, memberDocId } from './member-line-bind'
import { readNotifyDelivery, recipientDeliveryState, type NotifyRecipientDelivery, type RecipientState } from './line-notify-delivery'
import { getLineWorkspaceCredentials } from './line-workspace-credentials'
import { notifyLinksEnabled } from './notify-links'
import type { AiSettingsDoc } from '~~/shared/types/ai-knowledge'
import type { WorkspaceMemberRole } from '~~/shared/types/organization'

/** 「什麼時候通知」那幾格（跟 AiSettingsDoc['handoffNotify'] 同名） */
export const NOTIFY_TIMING_KEYS = ['mode', 'slaRemindMinutes', 'digestHour', 'festivalTips', 'weeklyInsights', 'criticalAlertPush'] as const
export type NotifyTiming = Pick<AiSettingsDoc['handoffNotify'], typeof NOTIFY_TIMING_KEYS[number]>

export function pickNotifyTiming(h: AiSettingsDoc['handoffNotify']): NotifyTiming {
  return {
    mode: h.mode,
    slaRemindMinutes: h.slaRemindMinutes,
    digestHour: h.digestHour,
    festivalTips: h.festivalTips,
    weeklyInsights: h.weeklyInsights,
    criticalAlertPush: h.criticalAlertPush,
  }
}

export interface LineNotifyRow {
  uid: string
  email: string
  role: WorkspaceMemberRole
  isSelf: boolean
  line: { userId: string, displayName: string, pictureUrl: string } | null
  receiving: boolean
  /** 有一組還沒用掉的綁定碼（「傳連結給他」之後在等對方點）：到期時間 */
  pendingCodeExpiresAt: number | null
  /** 那組碼什麼時候產的：畫面只在剛產的 15 分鐘內頻繁重抓（連結改 24 小時之後不能整天每 15 秒抓一次） */
  pendingCodeIssuedAt: number | null
  /**
   * 首頁那張「要傳到你的手機嗎？」第一次出現在他眼前的時間（`D-119` 拍板 B）。
   * null＝還沒看過——那一列才講得出「看過邀請還沒加」還是「根本沒看過」。
   */
  inviteSeenAt: number | null
  /**
   * 對方在首頁那張「要傳到你的手機嗎？」卡按過「先不用」（`D-106`）。
   * 按過就不會再被問——名單上 ⛔ 不可以再寫「對方登入時會被問」。
   */
  inviteDismissed: boolean
  /** 在收的人才有：送到了沒 */
  delivery: RecipientState | null
}

export interface LineNotifyPageData {
  canManage: boolean
  selfUid: string
  /** 登入者自己有沒有成員資格（組織管理員／超管沒有，就不能「把我的手機加進來」） */
  selfIsMember: boolean
  lineConnected: boolean
  /** 名單滿了（最多 10 位） */
  full: boolean
  rows: LineNotifyRow[]
  /** 名單上、卻對不上任何成員的 LINE 帳號（`D-103` 拍板後不會再新增，舊資料才有）：只能拿掉 */
  others: { lineUserId: string, displayName: string, delivery: RecipientState }[]
  /** 送達紀錄這次讀不到（⛔ 讀不到不等於都送到了，畫面要講） */
  deliveryKnown: boolean
  timing: NotifyTiming
  serviceHours: AiSettingsDoc['serviceHours']
  /**
   * 通知裡有沒有放連結（`NOTIFY_LINKS_ENABLED`）。手機預覽照這個畫——
   * ⛔ 開關關著卻畫出連結＝示範一行客人永遠收不到的東西（推播預覽 `D-96` 踩過同一種）
   */
  linksEnabled: boolean
}

export async function buildLineNotifyPageData(input: {
  workspaceId: string
  uid: string
  canManage: boolean
  db?: Firestore
}): Promise<LineNotifyPageData> {
  const db = input.db ?? getDb()
  const wid = input.workspaceId
  const [settings, memberSnap, delivery, creds] = await Promise.all([
    // 不經快取（這一頁剛有人加進名單，下一次讀到的必須是新的），⛔ 也不清共用快取
    readAiSettingsFresh(wid, db),
    db.collection('workspaceMembers').where('workspaceId', '==', wid).get(),
    readNotifyDelivery(wid, db)
      .then(d => ({ ok: true as const, d }))
      .catch(() => ({ ok: false as const, d: {} as Record<string, NotifyRecipientDelivery> })),
    getLineWorkspaceCredentials(wid).catch(() => null),
  ])
  // normalizeAiSettings 已經把舊資料「名單有人但關著」收成空名單（`C-271`⑮），這裡只看名單
  const ids = settings.handoffNotify.lineUserIds

  // 自己加入的擁有者（自助開帳）成員文件上沒有 invitedEmail，要去 Auth 查
  const members = memberSnap.docs.map(d => d.data() as Record<string, any>)
  const needEmail = members.filter(m => m.uid && !String(m.invitedEmail ?? '').trim()).map(m => String(m.uid))
  const uidToEmail: Record<string, string> = {}
  if (needEmail.length) {
    try {
      const res = await getFirebaseAuth().getUsers(needEmail.map(uid => ({ uid })))
      for (const u of res.users) uidToEmail[u.uid] = String(u.email ?? '')
    }
    catch (err) {
      console.warn('[line-notify] email lookup failed:', err)
    }
  }

  const now = Date.now()
  const matched = new Set<string>()
  const rows: LineNotifyRow[] = []
  for (const m of members) {
    const uid = String(m.uid ?? '')
    if (!uid) continue
    const lineUserId = String(m.lineUserId ?? '').trim()
    const receiving = Boolean(lineUserId) && notifyListHas(ids, lineUserId)
    if (receiving) matched.add(lineUserId)
    const role = (m.role ?? 'viewer') as WorkspaceMemberRole
    // 觀察者不處理客人、也不能自己加（notify.self 是客服起跳）：沒綁的不列，綁了（舊資料）照列
    if (role === 'viewer' && !lineUserId) continue
    const codeExp = Number(m.lineBindCodeExpiresAt ?? 0)
    rows.push({
      uid,
      email: String(m.invitedEmail ?? '').trim() || uidToEmail[uid] || '',
      role,
      isSelf: uid === input.uid,
      line: lineUserId
        ? { userId: lineUserId, displayName: String(m.lineDisplayName ?? ''), pictureUrl: String(m.linePictureUrl ?? '') }
        : null,
      receiving,
      pendingCodeExpiresAt: !lineUserId && m.lineBindCode && codeExp > now ? codeExp : null,
      pendingCodeIssuedAt: !lineUserId && m.lineBindCode && codeExp > now ? (Number(m.lineBindCodeIssuedAt ?? 0) || null) : null,
      inviteSeenAt: Number(m.lineNotifyInviteFirstSeenAt ?? 0) || null,
      inviteDismissed: Number(m.lineNotifyInviteDismissedAt ?? 0) > 0,
      delivery: receiving ? recipientDeliveryState(delivery.d[normalizeLineUserId(lineUserId)]) : null,
    })
  }
  // 自己排第一，其餘照角色、同角色照 Email——跟「成員管理」同一個順序（`D-117`）
  rows.sort(compareMembersForList)

  const others = ids
    .map(id => normalizeLineUserId(id))
    .filter(id => !matched.has(id))
    .map(id => ({
      lineUserId: id,
      displayName: String(settings.handoffNotify.displayNames?.[id] ?? '').trim(),
      delivery: recipientDeliveryState(delivery.d[id]),
    }))

  return {
    canManage: input.canManage,
    selfUid: input.uid,
    selfIsMember: members.some(m => String(m.uid ?? '') === input.uid),
    lineConnected: Boolean(creds?.channelAccessToken),
    full: ids.length >= HANDOFF_NOTIFY_MAX,
    rows,
    others,
    deliveryKnown: delivery.ok,
    timing: pickNotifyTiming(settings.handoffNotify),
    serviceHours: settings.serviceHours,
    linksEnabled: notifyLinksEnabled(),
  }
}

export interface LineNotifySelfStatus {
  isMember: boolean
  bound: boolean
  lineDisplayName: string
  linePictureUrl: string
  boundAt: number
  receiving: boolean
  /** 首頁那張卡按過「先不用」 */
  inviteDismissed: boolean
  lineConnected: boolean
  /** 名單滿了（最多 10 位）：綁好了卻沒進名單時，講得出是這個原因（`C-271`⑨） */
  full: boolean
  /** 名單上有幾位在收：小幫手分得出「沒有人在名單上」還是「名單上的人都收不到」（`C-271`⑪） */
  receivingCount: number
  timing: NotifyTiming
  serviceHours: AiSettingsDoc['serviceHours']
}

/**
 * 首頁那張卡、掃 QR 等待時每幾秒問一次：只讀自己的成員文件＋設定（2 次讀取）。
 * ⛔ 讀設定不清共用快取（`C-271`⑫：原本每 2.5 秒清一次，這台送訊息的熱路徑就一直重讀 Firestore）。
 */
export async function buildLineNotifySelfStatus(workspaceId: string, uid: string, db: Firestore = getDb()): Promise<LineNotifySelfStatus> {
  const [memberSnap, settings, creds] = await Promise.all([
    db.collection('workspaceMembers').doc(memberDocId(uid, workspaceId)).get(),
    readAiSettingsFresh(workspaceId, db),
    getLineWorkspaceCredentials(workspaceId).catch(() => null),
  ])
  const ids = settings.handoffNotify.lineUserIds
  const m = memberSnap.exists ? (memberSnap.data() as Record<string, any>) : null
  const lineUserId = String(m?.lineUserId ?? '').trim()
  const boundAt = m?.lineBoundAt?.toMillis?.() ?? 0
  return {
    isMember: Boolean(m),
    bound: Boolean(lineUserId),
    lineDisplayName: String(m?.lineDisplayName ?? ''),
    linePictureUrl: String(m?.linePictureUrl ?? ''),
    boundAt: Number(boundAt) || 0,
    receiving: Boolean(lineUserId) && notifyListHas(ids, lineUserId),
    inviteDismissed: Number(m?.lineNotifyInviteDismissedAt ?? 0) > 0,
    lineConnected: Boolean(creds?.channelAccessToken),
    full: ids.length >= HANDOFF_NOTIFY_MAX,
    receivingCount: ids.length,
    timing: pickNotifyTiming(settings.handoffNotify),
    serviceHours: settings.serviceHours,
  }
}
