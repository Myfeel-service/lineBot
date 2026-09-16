import { requireCapability } from '~~/server/utils/workspace-auth'
import { getDb, getFirebaseAuth } from '~~/server/utils/firebase'
import { AUDIT_LOGS_COLLECTION } from '~~/server/utils/audit-log'
import type { AuditActor, AuditLogRow } from '~~/shared/types/audit'

/**
 * GET /api/admin/audit-logs —— 操作紀錄查詢（`C-31` Phase 2 地基）。
 *
 * 為什麼現在才有：`auditLogs` 從 2026-08-14 就開始寫，但一直是**只進不出**——
 * 出事時「這筆設定是誰改的、改前是什麼」沒有任何地方查得到。小幫手要開始代人動手之前，
 * 這個洞必須先補起來（評估報告 §5.1「稽核先行不可妥協」）。
 *
 * 紀律：
 * - 只回這個工作區的紀錄（workspaceId 由 session 帶入，查詢一律 where）。
 * - **游標分頁，⛔不用 offset**：Firestore 對 offset 跳過的每一筆照樣收錢
 *   （2026-08-11 讀取費暴衝的主因之一）。
 * - 篩選「人 / 小幫手」需要另一支複合索引；索引還沒部署時**如實說用不了**，
 *   ⛔不可以退回去撈全部再在記憶體裡濾掉——那會安靜地少給資料，看的人卻以為看到了全部。
 */

const DEFAULT_LIMIT = 30
const MAX_LIMIT = 50
/** uid → Email 一次最多換幾個（Firebase getUsers 單次上限 100） */
const MAX_UID_LOOKUP = 100

function parseActor(raw: unknown): AuditActor | null {
  return raw === 'human' || raw === 'agent' ? raw : null
}

export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'audit.read')
  const query = getQuery(event)

  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(query.limit) || DEFAULT_LIMIT))
  const actor = parseActor(query.actor)
  const cursor = String(query.cursor ?? '').trim().slice(0, 200)

  const db = getDb()
  const col = db.collection(AUDIT_LOGS_COLLECTION)

  let q = col.where('workspaceId', '==', workspaceId)
  if (actor) q = q.where('actor', '==', actor)
  q = q.orderBy('createdAt', 'desc')

  // 游標＝上一頁最後一筆的 doc id：拿它的 snapshot 當 startAfter，
  // 同一毫秒寫進來的兩筆也不會被跳過（用時間值當游標就會）。
  if (cursor) {
    const cursorSnap = await col.doc(cursor).get()
    if (cursorSnap.exists && cursorSnap.get('workspaceId') === workspaceId)
      q = q.startAfter(cursorSnap)
  }

  let docs: FirebaseFirestore.QueryDocumentSnapshot[]
  try {
    // 多撈一筆用來判斷「還有沒有下一頁」，回傳時再切掉
    docs = (await q.limit(limit + 1).get()).docs
  }
  catch (e: any) {
    // 索引沒部署：Firestore 回 FAILED_PRECONDITION。如實講哪個篩選用不了，
    // ⛔不要自己降級成別的查法然後假裝一切正常。
    const msg = String(e?.message ?? e)
    if (actor && (e?.code === 9 || /index/i.test(msg))) {
      throw createError({
        statusCode: 503,
        statusMessage: '「只看成員／只看小幫手」這個篩選需要的資料庫索引還沒部署，請先看全部（或聯絡我們部署索引）。',
      })
    }
    throw e
  }

  const hasMore = docs.length > limit
  const page = hasMore ? docs.slice(0, limit) : docs

  const items: AuditLogRow[] = page.map((d) => {
    const data = d.data()
    const ts = data.createdAt as { toMillis?: () => number } | undefined
    return {
      id: d.id,
      action: String(data.action ?? ''),
      actor: data.actor === 'agent' ? 'agent' : 'human',
      uid: String(data.uid ?? ''),
      before: (data.before ?? null) as Record<string, unknown> | null,
      after: (data.after ?? null) as Record<string, unknown> | null,
      ...(data.note ? { note: String(data.note) } : {}),
      // serverTimestamp 寫入後、伺服器蓋章前讀到會是 null——如實回 null，
      // ⛔不要拿現在的時間補上去（那會讓紀錄的時間軸說謊）
      createdAt: typeof ts?.toMillis === 'function' ? ts.toMillis() : null,
    }
  })

  // uid → Email：畫面要顯示「誰」，只有 uid 等於沒回答。查不到就讓畫面顯示 uid 本身。
  const uids = [...new Set(items.map(i => i.uid).filter(Boolean))].slice(0, MAX_UID_LOOKUP)
  const uidEmails: Record<string, string> = {}
  if (uids.length) {
    try {
      const res = await getFirebaseAuth().getUsers(uids.map(uid => ({ uid })))
      for (const u of res.users)
        if (u.email) uidEmails[u.uid] = u.email
    }
    catch (e) {
      // 換不到名字不影響紀錄本身：紀錄照給，畫面退回顯示 uid
      console.error('[audit-logs] getUsers failed:', e)
    }
  }

  return {
    items,
    uidEmails,
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  }
})
