/**
 * 試發推播可以發給誰（`D-119` ⑥，2026-10-09 老闆「照改」）。
 *
 * 為什麼要有：原本試發框是「在九千多位好友裡打名字搜」——MYFEEL 好友裡叫 Alice 的有 5 位，
 * 挑錯就是把還沒定稿的內容發給客人。但也**不能只限發給自己**：試發功能出來前，
 * 20 則被拿來試打的推播、36 人次收件裡 29 次是發給不在後台的看稿同事（游瑞茹、陳品潔…），
 * 4 則一次發 3–5 人——「發給大家看稿」是常態。
 *
 * 所以改成一份固定名單，三種人：
 *   ① 你自己綁好 LINE 的那支手機
 *   ② 綁好 LINE 的同事（成員管理裡的人）
 *   ③ 常找來看稿的人：從好友裡加一次就一直在（存在 `broadcastTestRecipients/{workspaceId}`）
 * ⛔ 伺服器也只收名單上的人（`allowedTestRecipientIds`），不是只有畫面藏起來。
 */
import type { Firestore } from 'firebase-admin/firestore'
import { getDb, getFirebaseAuth } from './firebase'
import { lineUserFirestoreDocId } from '~~/shared/line-workspace'
import { normalizeLineUserId } from '~~/shared/line-notify-list'
import { compareMembersForList } from '~~/shared/member-order'

export const TEST_RECIPIENTS_COLLECTION = 'broadcastTestRecipients'
/** 常找來看稿的人最多幾位：這是看稿名單，不是第二份推播名單 */
export const TEST_RECIPIENTS_MAX = 20

export interface TestRecipient {
  lineUserId: string
  /** LINE 上的名字（好友資料現在的，讀不到就用存的時候的） */
  displayName: string
  pictureUrl: string
  /** 同事才有：後台 Email，同名時分得出是誰 */
  email?: string
  /**
   * 收不到：封鎖了官方帳號，或已經不是好友。照樣列出來（⛔ 不安靜地拿掉——
   * 他會以為那個人被誰刪了），但畫面要講、而且不給勾。
   */
  unreachable?: 'blocked' | 'gone'
}

export interface TestRecipientList {
  /** 自己是這個官方帳號的成員嗎（不是＝平台管理員、組織管理員，沒有手機可以加） */
  selfIsMember: boolean
  /** 自己綁好的手機；null＝還沒加 */
  self: TestRecipient | null
  /** 綁好 LINE 的同事（不含自己） */
  members: TestRecipient[]
  /** 常找來看稿的人（已經是同事的不重複列） */
  saved: TestRecipient[]
}

interface SavedDoc {
  lineUserIds?: unknown
  /** 加進來那時候的名字（好友資料讀不到時的退路） */
  names?: Record<string, string>
}

function savedIdsOf(raw: SavedDoc | undefined): string[] {
  if (!Array.isArray(raw?.lineUserIds)) return []
  return [...new Set(raw.lineUserIds.map(v => normalizeLineUserId(String(v ?? ''))).filter(Boolean))]
}

async function friendOf(workspaceId: string, lineUserId: string, db: Firestore) {
  const snap = await db.collection('users').doc(lineUserFirestoreDocId(lineUserId, workspaceId)).get()
  return snap.exists ? (snap.data() as Record<string, unknown>) : null
}

export async function buildTestRecipients(workspaceId: string, uid: string, db: Firestore = getDb()): Promise<TestRecipientList> {
  const [memberSnap, savedSnap] = await Promise.all([
    db.collection('workspaceMembers').where('workspaceId', '==', workspaceId).get(),
    db.collection(TEST_RECIPIENTS_COLLECTION).doc(workspaceId).get(),
  ])
  const members = memberSnap.docs.map(d => d.data() as Record<string, any>)

  // 自助開帳的擁有者沒有 invitedEmail，要去 Auth 查（同成員管理）
  const needEmail = members.filter(m => m.uid && m.lineUserId && !String(m.invitedEmail ?? '').trim()).map(m => String(m.uid))
  const uidToEmail: Record<string, string> = {}
  if (needEmail.length) {
    try {
      const res = await getFirebaseAuth().getUsers(needEmail.map(id => ({ uid: id })))
      for (const u of res.users) uidToEmail[u.uid] = String(u.email ?? '')
    }
    catch (e) {
      console.warn('[test-recipients] email lookup failed:', e)
    }
  }

  const bound = members
    .filter(m => String(m.lineUserId ?? '').trim())
    .map(m => ({
      isSelf: String(m.uid ?? '') === uid,
      role: String(m.role ?? ''),
      email: String(m.invitedEmail ?? '').trim() || uidToEmail[String(m.uid)] || '',
      r: {
        lineUserId: normalizeLineUserId(String(m.lineUserId)),
        displayName: String(m.lineDisplayName ?? '').trim(),
        pictureUrl: String(m.linePictureUrl ?? ''),
      } as TestRecipient,
    }))
    .sort(compareMembersForList)

  const selfRow = bound.find(b => b.isSelf)
  const memberIds = new Set(bound.map(b => b.r.lineUserId))

  const raw = savedSnap.exists ? (savedSnap.data() as SavedDoc) : undefined
  const savedIds = savedIdsOf(raw).filter(id => !memberIds.has(id))
  const saved = await Promise.all(savedIds.map(async (id): Promise<TestRecipient> => {
    const f = await friendOf(workspaceId, id, db).catch(() => null)
    return {
      lineUserId: id,
      displayName: String(f?.displayName ?? raw?.names?.[id] ?? '').trim(),
      pictureUrl: String(f?.pictureUrl ?? ''),
      ...(!f ? { unreachable: 'gone' as const } : f.isBlocked === true ? { unreachable: 'blocked' as const } : {}),
    }
  }))

  return {
    selfIsMember: members.some(m => String(m.uid ?? '') === uid),
    self: selfRow ? { ...selfRow.r, ...(selfRow.email ? { email: selfRow.email } : {}) } : null,
    members: bound.filter(b => !b.isSelf).map(b => ({ ...b.r, ...(b.email ? { email: b.email } : {}) })),
    saved,
  }
}

/**
 * 試發端點用：名單上有誰（⛔ 一律從資料庫算，不信任前端傳來的名單）。
 *
 * ⚠️ 只讀兩份就夠（成員、常找來看稿的人），⛔ 不要拿畫面那份 `buildTestRecipients` 來算：
 *    那份為了顯示要去登入系統查 email、每一位常找來看稿的人各讀一次好友資料——每按一次試發
 *    多一次登入系統查詢、多最多 20 筆讀取，而試發端點本來就會對**這次勾的人**讀好友資料，
 *    還在不在、有沒有封鎖在那裡講（2026-10-10 審查抓到）。
 * `uid` 沒用到：名單上有誰跟誰按下去無關（自己也是成員之一），留著是為了呼叫端不必改。
 */
export async function allowedTestRecipientIds(workspaceId: string, _uid: string, db: Firestore = getDb()): Promise<Set<string>> {
  const [memberSnap, savedSnap] = await Promise.all([
    db.collection('workspaceMembers').where('workspaceId', '==', workspaceId).get(),
    db.collection(TEST_RECIPIENTS_COLLECTION).doc(workspaceId).get(),
  ])
  const ids = new Set<string>()
  for (const d of memberSnap.docs) {
    const id = normalizeLineUserId(String((d.data() as Record<string, unknown>).lineUserId ?? ''))
    if (id) ids.add(id)
  }
  for (const id of savedIdsOf(savedSnap.exists ? (savedSnap.data() as SavedDoc) : undefined)) ids.add(id)
  return ids
}

export type AddTestRecipientResult = 'added' | 'already' | 'full' | 'not-friend'

/** 加一位「常找來看稿的人」：一定要是這個官方帳號的好友（LINE 只讓我們發給好友） */
export async function addTestRecipient(
  workspaceId: string,
  lineUserId: string,
  db: Firestore = getDb(),
): Promise<{ result: AddTestRecipientResult, displayName: string }> {
  const id = normalizeLineUserId(lineUserId)
  const friend = id ? await friendOf(workspaceId, id, db) : null
  if (!friend) return { result: 'not-friend', displayName: '' }
  const displayName = String(friend.displayName ?? '').trim()
  const ref = db.collection(TEST_RECIPIENTS_COLLECTION).doc(workspaceId)
  // 交易：兩個人同時加，各讀一份再各寫回去會互相蓋掉
  const result = await db.runTransaction(async (tx): Promise<AddTestRecipientResult> => {
    const snap = await tx.get(ref)
    const raw = snap.exists ? (snap.data() as SavedDoc) : undefined
    const ids = savedIdsOf(raw)
    if (ids.includes(id)) return 'already'
    if (ids.length >= TEST_RECIPIENTS_MAX) return 'full'
    const names = { ...(raw?.names ?? {}) }
    if (displayName) names[id] = displayName.slice(0, 40)
    tx.set(ref, { workspaceId, lineUserIds: [...ids, id], names }, { merge: true })
    return 'added'
  })
  return { result, displayName }
}

export async function removeTestRecipient(workspaceId: string, lineUserId: string, db: Firestore = getDb()): Promise<boolean> {
  const id = normalizeLineUserId(lineUserId)
  const ref = db.collection(TEST_RECIPIENTS_COLLECTION).doc(workspaceId)
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) return false
    const raw = snap.data() as SavedDoc
    const ids = savedIdsOf(raw)
    if (!ids.includes(id)) return false
    const names = { ...(raw.names ?? {}) }
    delete names[id]
    // ⚠️ names 要整份換掉：merge 寫入不會刪掉 map 裡已經有的鍵
    tx.update(ref, { lineUserIds: ids.filter(v => v !== id), names })
    return true
  })
}
