/**
 * 接 LINE 那一趟的最後一步：「手機加好友、電腦按『是我』」（`C-250`③，`D-101` ①，示意頁 v80）。
 *
 * ⭐ 為什麼加好友就夠：加好友那一下 LINE 會送一個事件到 Webhook——簽章過得了＝第二組對、
 *    收得到＝網址與開關對、歡迎訊息回得出去＝第一組對。（v76 叫他照打一串綁定碼，那是這一步最難的地方）
 * ⚠️ 後端原本只把「真的訊息」算成收到（加好友是 traceOnly），所以**這一刻**要自己認加好友。
 * 🔴 「是我」是安全閘：等待期間剛好有**客人**加好友的話，綁錯人＝客人收到我們的內部通知。
 *    所以一定要秀出 LINE 名稱讓他認，⛔ 不可以「第一個進來的就當成他」自動綁；
 *    而且只認**這幾分鐘內**新加好友／剛傳訊息的人，按「是我」時伺服器再驗一次。
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { findLatestPeerActiveConversation } from '~~/server/utils/conversation-peer-activity'
import { lineUserFirestoreDocId } from '~~/shared/line-workspace'

/** 最多往回看多久（等待畫面開著的時間；⛔ 放太寬就等於任何舊好友都能被綁成管理員） */
export const PHONE_TEST_WINDOW_MS = 60 * 60 * 1000

export interface NewFollower {
  lineUserId: string
  displayName: string
  pictureUrl: string
  /** 加好友（多數人）／已經是好友、傳了一句話 */
  via: 'follow' | 'message'
  at: number
}

const ms = (v: unknown): number => {
  const t = v as { toMillis?: () => number } | null | undefined
  return typeof t?.toMillis === 'function' ? t.toMillis() : 0
}

/** 把呼叫端給的起點夾在「最多往回一小時、不能是未來」之間 */
export function clampSince(raw: unknown, now = Date.now()): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return now - 5 * 60 * 1000
  return Math.min(now, Math.max(now - PHONE_TEST_WINDOW_MS, n))
}

/**
 * 從「往回看多久」算起點（2026-09-26 code review 改）。
 * 🔴 原本前端給的是**自己電腦的時間**，伺服器拿去跟**伺服器時間**比——電腦時鐘快 5 分鐘的人，
 *    起點落在未來、被夾成伺服器的「現在」，剛加的好友永遠比它早＝**永遠等不到**。
 *    改成前端給一段**時間長度**（兩邊的時鐘差不會影響長度），起點由伺服器自己的時間往回推。
 */
export function sinceFromLookback(raw: unknown, now = Date.now()): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return now - 5 * 60 * 1000
  return now - Math.min(PHONE_TEST_WINDOW_MS, n)
}

/** 新的一份請求參數優先用 lookbackMs；舊的 since（epoch）只給還沒更新的分頁用 */
export function phoneTestSince(q: { lookbackMs?: unknown, since?: unknown }, now = Date.now()): number {
  return q.lookbackMs != null && q.lookbackMs !== '' ? sinceFromLookback(q.lookbackMs, now) : clampSince(q.since, now)
}

/** 這一位最近一次加好友的時間：第一次加＝createdAt；封鎖後重加＝lastFollowedAt（⛔ createdAt 不會變） */
function followedAtOf(u: Record<string, unknown> | undefined): number {
  return Math.max(ms(u?.createdAt), ms(u?.lastFollowedAt))
}

/**
 * 從 `since` 之後，最新的那一位：新加好友的、或（已經是好友的人）剛傳訊息的。
 * `exclude`＝他按過「不是我」的那幾位（⛔ 不要一直問同一個人）。
 */
export async function findNewFollower(
  workspaceId: string,
  sinceMs: number,
  exclude: Set<string> = new Set(),
  db: Firestore = getDb(),
): Promise<NewFollower | null> {
  const found: NewFollower[] = []

  // ① 新加好友：users 依建立時間倒序（既有索引 workspaceId + createdAt desc）
  // ①' 封鎖後重加：依 lastFollowedAt 倒序（2026-09-26 code review 補：重加時 createdAt 不會變，原本永遠不算）
  //    ⚠️ 這一條要新索引（workspaceId + lastFollowedAt desc）；索引還沒部署時查詢會丟錯——⛔ 不擋第一次加好友那條
  const [byCreated, byRefollow] = await Promise.all([
    db.collection('users').where('workspaceId', '==', workspaceId).orderBy('createdAt', 'desc').limit(5).get(),
    db.collection('users').where('workspaceId', '==', workspaceId).orderBy('lastFollowedAt', 'desc').limit(5).get()
      .catch((e: unknown) => {
        // ⚠️ error 不是 warn（記憶 reference_firestore_index_deploy：唯讀路徑吞掉索引錯誤＝一整類東西靜靜消失）
        console.error('[phone-test] 查「重新加好友」失敗（多半是索引還沒建好）＝封鎖後重加的人這一次偵測不到，只看第一次加好友：', (e as Error)?.message)
        return null
      }),
  ])
  const seen = new Set<string>()
  for (const d of [...byCreated.docs, ...(byRefollow?.docs ?? [])]) {
    if (seen.has(d.id)) continue
    seen.add(d.id)
    const u = d.data()
    const at = followedAtOf(u)
    const id = String(u.lineUserId ?? '')
    if (!id || at < sinceMs || exclude.has(id) || u.isBlocked === true) continue
    found.push({ lineUserId: id, displayName: String(u.displayName ?? ''), pictureUrl: String(u.pictureUrl ?? ''), via: 'follow', at })
  }

  // ② 早就是好友（加不了第二次）→ 傳了一句話：最近一次有客人講話的那一場
  const conv = await findLatestPeerActiveConversation(db, workspaceId).catch(() => null)
  if (conv) {
    const c = conv.data()
    const at = ms(c.lastPeerActivityAt)
    const id = String(c.userId ?? '')
    if (id && at >= sinceMs && !exclude.has(id) && !found.some(f => f.lineUserId === id)) {
      const u = (await db.collection('users').doc(lineUserFirestoreDocId(id, workspaceId)).get().catch(() => null))?.data()
      found.push({ lineUserId: id, displayName: String(u?.displayName ?? ''), pictureUrl: String(u?.pictureUrl ?? ''), via: 'message', at })
    }
  }

  return found.sort((a, b) => b.at - a.at)[0] ?? null
}

/**
 * 按了「是我」：**再驗一次**這個人真的是這段時間內新進來的（⛔ 不信任前端給的 id），
 * 然後把這一下記成「收到第一則」（加好友原本不算，見檔頭）。
 * 回傳驗過的那一位；驗不過回 null。
 */
export async function confirmPhoneFollower(
  workspaceId: string,
  lineUserId: string,
  sinceMs: number,
  db: Firestore = getDb(),
): Promise<NewFollower | null> {
  const id = String(lineUserId || '').trim()
  if (!id) return null
  // 驗：只看這一位（其他人被排除），找得到才算
  const users = await db.collection('users').doc(lineUserFirestoreDocId(id, workspaceId)).get()
  const u = users.data()
  const convSnap = await db.collection('conversations').doc(lineUserFirestoreDocId(id, workspaceId)).get()
  const c = convSnap.data()
  const followedAt = u?.workspaceId === workspaceId && u?.isBlocked !== true ? followedAtOf(u) : 0
  const spokeAt = c?.workspaceId === workspaceId ? ms(c?.lastPeerActivityAt) : 0
  const via: NewFollower['via'] | null = followedAt >= sinceMs ? 'follow' : spokeAt >= sinceMs ? 'message' : null
  if (!via) return null

  // 加好友那一下算「收到了」：setup-status 的 firstMessageReceived 看的是 lastPeerActivityAt
  if (via === 'follow') {
    await db.collection('conversations').doc(lineUserFirestoreDocId(id, workspaceId)).set(
      { workspaceId, userId: id, lastPeerActivityAt: FieldValue.serverTimestamp() },
      { merge: true },
    )
  }
  return {
    lineUserId: id,
    displayName: String(u?.displayName ?? ''),
    pictureUrl: String(u?.pictureUrl ?? ''),
    via,
    at: via === 'follow' ? followedAt : spokeAt,
  }
}
