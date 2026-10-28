import { requireCapability } from '~~/server/utils/workspace-auth'
import { getDb, getFirebaseAuth } from '~~/server/utils/firebase'
import { AUDIT_LOGS_COLLECTION } from '~~/server/utils/audit-log'
import { AI_USAGE_COLLECTION, currentYyyyMm } from '~~/server/utils/ai-usage'
import { checkRevert, planRevert, revertedIdsAmong } from '~~/server/utils/audit-revert'
import type { RevertCtx } from '~~/server/utils/audit-revert-common'
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

/*
 * 便宜的預查（`D-156`）：那一份還在不在、建好後有沒有被改過、推播送出了沒。回傳「哪幾筆擋下來、為什麼」。
 * 為什麼要有：拿 MYFEEL 真資料預演，新增類的還原鈕大半按下去會被擋——
 * 給了按鈕、按下去卻說不行，比沒有按鈕更糟。擋得下來的就收掉按鈕、直接寫原因。
 * ⚠️ 只做便宜的（每列讀一兩筆）：「哪裡在用它」要掃六類設定，留到按下去那一刻。
 * ⛔ 走的是只檢查的 checkRevert，不是真的還原那支（code review `C-412`）。
 * ⛔ 預查自己出錯（不是被規則擋）就照舊給按鈕：按下去時還會完整再查一次
 */
async function precheckReverts(rows: AuditLogRow[], ctx: RevertCtx): Promise<Map<string, string>> {
  const blocked = new Map<string, string>()
  await Promise.all(rows.map(async (i) => {
    try {
      await checkRevert({
        id: i.id,
        action: i.action,
        before: i.before,
        after: i.after,
        ...(i.targetId ? { targetId: i.targetId } : {}),
      }, ctx, 'list')
    }
    catch (e: any) {
      const status = Number(e?.statusCode ?? 0)
      if (status < 400 || status >= 500 || !e?.statusMessage) {
        console.error('[audit-logs] revert precheck failed:', i.id, i.action, e)
        return
      }
      blocked.set(i.id, String(e.statusMessage))
    }
  }))
  return blocked
}

/** uid → Email：畫面要顯示「誰」，只有 uid 等於沒回答。查不到就讓畫面顯示 uid 本身。 */
async function lookupEmails(uids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  if (!uids.length) return out
  try {
    const res = await getFirebaseAuth().getUsers(uids.map(uid => ({ uid })))
    for (const u of res.users)
      if (u.email) out[u.uid] = u.email
  }
  catch (e) {
    // 換不到名字不影響紀錄本身：紀錄照給，畫面退回顯示 uid
    console.error('[audit-logs] getUsers failed:', e)
  }
  return out
}

export default defineEventHandler(async (event) => {
  const { workspaceId, uid, isSuperAdmin } = await requireCapability(event, 'audit.read')
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
    // ⛔ 游標失效時**不可以默默回第一頁**：畫面是「載入更多」，使用者會拿到同一批資料
    //    再貼一次，而且以為那是更舊的紀錄。如實說一句，讓他重新整理。
    if (!cursorSnap.exists || cursorSnap.get('workspaceId') !== workspaceId) {
      throw createError({
        statusCode: 410,
        statusMessage: '這份清單的位置已經失效（紀錄可能已過期或換了官方帳號）。請重新整理再看一次。',
      })
    }
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
    // 能不能還原由後端算：⛔前端自己判斷的話，兩邊遲早對不起來
    //（畫面給了按鈕、按下去卻說不行，比沒有按鈕更糟）
    const plan = planRevert({
      id: d.id,
      action: String(data.action ?? ''),
      before: (data.before ?? null) as Record<string, unknown> | null,
      after: (data.after ?? null) as Record<string, unknown> | null,
      ...(data.targetId ? { targetId: String(data.targetId) } : {}),
      lossy: data.lossy === true,
    })
    return {
      id: d.id,
      revertible: plan.ok,
      ...(plan.ok ? { revertWhat: plan.what } : { revertReason: plan.reason }),
      action: String(data.action ?? ''),
      actor: data.actor === 'agent' || data.actor === 'system' ? data.actor : 'human',
      uid: String(data.uid ?? ''),
      before: (data.before ?? null) as Record<string, unknown> | null,
      after: (data.after ?? null) as Record<string, unknown> | null,
      ...(data.note ? { note: String(data.note) } : {}),
      // 畫面拿它做「點推播名字打開那一則」（`D-117`）
      ...(data.targetId ? { targetId: String(data.targetId) } : {}),
      // serverTimestamp 寫入後、伺服器蓋章前讀到會是 null——如實回 null，
      // ⛔不要拿現在的時間補上去（那會讓紀錄的時間軸說謊）
      createdAt: typeof ts?.toMillis === 'function' ? ts.toMillis() : null,
    }
  })

  const revertible = items.filter(i => i.revertible)
  const uids = [...new Set(items.map(i => i.uid).filter(Boolean))].slice(0, MAX_UID_LOOKUP)

  // 下面四件互不相干，一起跑（code review `C-412`：以前一件等一件，打開一頁要多等好幾趟來回）
  const [done, blocked, uidEmails, usage] = await Promise.all([
    // 已經還原過的那幾筆不再給「還原」鈕（`D-156`）：⛔ 不然再按一次會說「這段期間又被改過了」，
    // 人會去找一個不存在的同事。只問「能還原的」那幾筆；查不到不影響清單本身
    revertible.length
      ? revertedIdsAmong(db, workspaceId, revertible.map(i => i.id)).catch((e) => {
          // 查不到就照舊顯示還原鈕：按下去時 revert 那支還會再查一次、擋得住
          console.error('[audit-logs] reverted lookup failed:', e)
          return new Set<string>()
        })
      : new Set<string>(),
    precheckReverts(revertible, { db, workspaceId, uid, isSuperAdmin }),
    lookupEmails(uids),
    // 這個月小幫手提了幾次、你按了幾次確定。⛔兩個數字取同一顆月結桶，
    // 不去掃紀錄推算——推算出來的東西一旦跟畫面對不起來，就再也沒人相信它。
    db.collection(AI_USAGE_COLLECTION).doc(`${workspaceId}_${currentYyyyMm()}`).get().catch(() => null),
  ])

  for (const i of items) {
    if (done.has(i.id)) {
      i.revertible = false
      i.reverted = true
      delete i.revertWhat
      delete i.revertReason
      continue
    }
    const reason = blocked.get(i.id)
    if (reason) {
      i.revertible = false
      i.revertReason = reason
      delete i.revertWhat
    }
  }

  const proposed = Number(usage?.data()?.agentProposed ?? 0)
  const executed = Number(usage?.data()?.agentExecuted ?? 0)

  return {
    items,
    uidEmails,
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    agentStats: {
      proposed,
      executed,
      // 提了卻沒按確定的次數。⚠️「取消」與「看一看就走掉」在資料上分不出來，
      // 所以措辭一律是「沒有按確定」，⛔不要寫成「被拒絕」。
      notConfirmed: Math.max(0, proposed - executed),
    },
  }
})
