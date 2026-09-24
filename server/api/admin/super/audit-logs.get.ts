import { requireSuperAdmin } from '~~/server/utils/workspace-auth'
import { getDb, getFirebaseAuth } from '~~/server/utils/firebase'
import { AUDIT_LOGS_COLLECTION } from '~~/server/utils/audit-log'
import type { AuditLogRow } from '~~/shared/types/audit'

/**
 * GET /api/admin/super/audit-logs —— 平台層操作紀錄（`C-254`，2026-09-24）。
 *
 * **為什麼要有這一支**：`C-254` 把超管的動作（調額度、作廢發票、停用組織、升降超管）
 * 都補上了稽核，但那些動作**不屬於任何一個官方帳號**——`workspaceId` 是空的。
 * 租戶的「操作紀錄」頁只查自己的 workspaceId，所以那批紀錄在那裡一筆都看不到。
 * ⛔ 沒有這一支的話，我們就只是把 2026-08-14 那個「只進不出」的洞**原樣複製一份**到平台層。
 *
 * 跟租戶那支的差別：
 * - **不篩 workspaceId**：這裡要看的就是全站，包含租戶自己做的事（誰改了誰的設定一次看完）。
 * - 因此只用 `orderBy(createdAt)`，**不需要新的複合索引**（單欄索引 Firestore 自動有）。
 * - 一樣走游標分頁，⛔ 不用 offset（Firestore 對跳過的每一筆照樣收錢）。
 */

const DEFAULT_LIMIT = 40
const MAX_LIMIT = 100
/** uid → Email 一次最多換幾個（Firebase getUsers 單次上限 100） */
const MAX_UID_LOOKUP = 100

export default defineEventHandler(async (event) => {
  await requireSuperAdmin(event)
  const query = getQuery(event)

  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(query.limit) || DEFAULT_LIMIT))
  const cursor = String(query.cursor ?? '').trim().slice(0, 200)

  const db = getDb()
  const col = db.collection(AUDIT_LOGS_COLLECTION)
  let q = col.orderBy('createdAt', 'desc')

  // 游標＝上一頁最後一筆的 doc id：同一毫秒寫進來的兩筆也不會被跳過（用時間值當游標就會）
  if (cursor) {
    const cursorSnap = await col.doc(cursor).get()
    // ⛔ 游標失效時不可以默默回第一頁：畫面是「載入更多」，人會拿到同一批再貼一次，
    //    還以為那是更舊的紀錄。
    if (!cursorSnap.exists) {
      throw createError({
        statusCode: 410,
        statusMessage: '這份清單的位置已經失效（那筆紀錄可能已經不在了）。請重新整理再看一次。',
      })
    }
    q = q.startAfter(cursorSnap)
  }

  const docs = (await q.limit(limit + 1).get()).docs
  const hasMore = docs.length > limit
  const page = hasMore ? docs.slice(0, limit) : docs

  const items: (AuditLogRow & { workspaceId: string, orgId: string, scope: string })[] = page.map((d) => {
    const data = d.data()
    const ts = data.createdAt as { toMillis?: () => number } | undefined
    return {
      id: d.id,
      // ⚠️ 這一頁**不提供還原**：還原要驗「這段期間有沒有被改過」與動作本身的權限門檻，
      //    那套邏輯綁在租戶情境上。平台頁只讀，⛔ 不給一顆按下去行為不明的按鈕。
      revertible: false,
      action: String(data.action ?? ''),
      actor: data.actor === 'agent' ? 'agent' : 'human',
      uid: String(data.uid ?? ''),
      before: (data.before ?? null) as Record<string, unknown> | null,
      after: (data.after ?? null) as Record<string, unknown> | null,
      ...(data.note ? { note: String(data.note) } : {}),
      // serverTimestamp 蓋章前讀到會是 null——如實回 null，⛔ 不要拿現在的時間補上去
      createdAt: typeof ts?.toMillis === 'function' ? ts.toMillis() : null,
      workspaceId: String(data.workspaceId ?? ''),
      orgId: String(data.orgId ?? ''),
      scope: data.scope === 'platform' ? 'platform' : '',
    }
  })

  // uid → Email：只有 uid 等於沒回答「是誰」。查不到就讓畫面顯示 uid 本身。
  const uids = [...new Set(items.map(i => i.uid).filter(Boolean))].slice(0, MAX_UID_LOOKUP)
  const uidEmails: Record<string, string> = {}
  if (uids.length) {
    try {
      const res = await getFirebaseAuth().getUsers(uids.map(uid => ({ uid })))
      for (const u of res.users) if (u.email) uidEmails[u.uid] = u.email
    }
    catch (e) {
      console.error('[super/audit-logs] getUsers failed:', e)
    }
  }

  /*
   * workspaceId → 名稱：畫面上要看得出「這筆動的是哪一家」。
   * ⛔ 查不到就留空讓畫面顯示 id，不要憑空補一個名字。
   */
  const wsIds = [...new Set(items.map(i => i.workspaceId).filter(Boolean))].slice(0, 100)
  const workspaceNames: Record<string, string> = {}
  if (wsIds.length) {
    const snaps = await db.getAll(...wsIds.map(id => db.collection('workspaces').doc(id))).catch(() => [])
    for (const s of snaps) {
      const name = String(s.data()?.name ?? '').trim()
      if (name) workspaceNames[s.id] = name
    }
  }

  return {
    items,
    uidEmails,
    workspaceNames,
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  }
})
