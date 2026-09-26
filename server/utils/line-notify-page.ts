/**
 * 「設定 → LINE 通知」頁與首頁那張卡要的資料（`D-103`／`C-270`，2026-09-27）。
 * 端點只做權限與回應，組資料的邏輯放這裡，方便測。
 */
import type { Firestore } from 'firebase-admin/firestore'
import { getDb, getFirebaseAuth } from './firebase'
import { AI_SETTINGS_COLLECTION, getAiSettings, invalidateAiSettingsCache, normalizeAiSettings } from './ai-settings'
import { effectiveNotifyIds, HANDOFF_NOTIFY_MAX, memberDocId } from './member-line-bind'
import { bareLineUserId, readNotifyDelivery, recipientDeliveryState, type NotifyRecipientDelivery, type RecipientState } from './line-notify-delivery'
import { getLineWorkspaceCredentials } from './line-workspace-credentials'
import { notifyLinksEnabled } from './notify-links'
import { buildDefaultAiSettings } from '~~/shared/types/ai-knowledge'
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

/**
 * 讀**不經快取**的設定：這一頁剛有人加進名單，下一次讀到的必須是新的。
 * ⚠️ 設定快取是每個執行個體各一份（60 秒），加名單的那一台清得掉自己的，清不到別台的。
 */
export async function readFreshAiSettings(workspaceId: string, db: Firestore = getDb()): Promise<AiSettingsDoc> {
  const snap = await db.collection(AI_SETTINGS_COLLECTION).doc(workspaceId).get()
  if (!snap.exists) return getAiSettings(workspaceId, db)
  invalidateAiSettingsCache(workspaceId)
  return normalizeAiSettings({ ...buildDefaultAiSettings(), ...(snap.data() as Partial<AiSettingsDoc>) })
}

export interface LineNotifyRow {
  uid: string
  email: string
  role: WorkspaceMemberRole
  isSelf: boolean
  line: { userId: string, displayName: string, pictureUrl: string } | null
  receiving: boolean
  /** 有一組還沒用掉的綁定碼（「改傳連結」之後在等對方點）：到期時間 */
  pendingCodeExpiresAt: number | null
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

/** 名單上是否有這個 LINE 帳號（舊資料可能存成 `${workspaceId}_U…`） */
function listHas(ids: string[], lineUserId: string): boolean {
  return ids.some(v => v === lineUserId || v.endsWith(`_${lineUserId}`))
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
    readFreshAiSettings(wid, db),
    db.collection('workspaceMembers').where('workspaceId', '==', wid).get(),
    readNotifyDelivery(wid, db)
      .then(d => ({ ok: true as const, d }))
      .catch(() => ({ ok: false as const, d: {} as Record<string, NotifyRecipientDelivery> })),
    getLineWorkspaceCredentials(wid).catch(() => null),
  ])
  const ids = effectiveNotifyIds(settings.handoffNotify)

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
    const receiving = Boolean(lineUserId) && listHas(ids, lineUserId)
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
      delivery: receiving ? recipientDeliveryState(delivery.d[bareLineUserId(wid, lineUserId)]) : null,
    })
  }
  // 自己排第一，其餘照角色（擁有者／管理員／客服）
  const ORDER: Record<string, number> = { owner: 0, admin: 1, agent: 2, viewer: 3 }
  rows.sort((a, b) => (a.isSelf === b.isSelf ? (ORDER[a.role] ?? 9) - (ORDER[b.role] ?? 9) : a.isSelf ? -1 : 1))

  const others = ids
    .map(id => bareLineUserId(wid, id))
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
  timing: NotifyTiming
  serviceHours: AiSettingsDoc['serviceHours']
}

/** 首頁那張卡、掃 QR 等待時每幾秒問一次：只讀自己的成員文件＋設定（2 次讀取） */
export async function buildLineNotifySelfStatus(workspaceId: string, uid: string, db: Firestore = getDb()): Promise<LineNotifySelfStatus> {
  const [memberSnap, settings, creds] = await Promise.all([
    db.collection('workspaceMembers').doc(memberDocId(uid, workspaceId)).get(),
    readFreshAiSettings(workspaceId, db),
    getLineWorkspaceCredentials(workspaceId).catch(() => null),
  ])
  const m = memberSnap.exists ? (memberSnap.data() as Record<string, any>) : null
  const lineUserId = String(m?.lineUserId ?? '').trim()
  const boundAt = m?.lineBoundAt?.toMillis?.() ?? 0
  return {
    isMember: Boolean(m),
    bound: Boolean(lineUserId),
    lineDisplayName: String(m?.lineDisplayName ?? ''),
    linePictureUrl: String(m?.linePictureUrl ?? ''),
    boundAt: Number(boundAt) || 0,
    receiving: Boolean(lineUserId) && listHas(effectiveNotifyIds(settings.handoffNotify), lineUserId),
    inviteDismissed: Number(m?.lineNotifyInviteDismissedAt ?? 0) > 0,
    lineConnected: Boolean(creds?.channelAccessToken),
    timing: pickNotifyTiming(settings.handoffNotify),
    serviceHours: settings.serviceHours,
  }
}
