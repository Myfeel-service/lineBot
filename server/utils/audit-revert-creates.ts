/**
 * 「還原這一筆」第二批：**新增的東西**——還原就是把剛建的那個拿掉（2026-10-28 `D-156` ②）。
 *
 * 老闆拍板的前提：**只在還沒被用到時給還原**。建好之後已經有選單指到它、有好友被貼上、
 * 有客人透過活動加好友，那就不是「收回一個手滑」，而是在拆正在服務客人的東西——
 * 那種要去原本的頁面刪（那裡會講刪了影響哪裡），這裡講清楚被誰用了、⛔ 不動手。
 *
 * 每一種都守：
 * - ⛔ 建好之後又被改過就不刪（連後來的修改一起丟掉＝把別人的工作丟掉）
 * - ⛔ 「有沒有被用到」查不完整（某一類掃失敗、或筆數多到沒掃完）就當作有，不刪
 * - 拿掉的方式跟原本頁面上的刪除同一套：模組真刪、標籤停用、推播草稿改成已取消、知識進回收桶
 */
import { FieldValue } from 'firebase-admin/firestore'
import { FLOW_FOLDERS_COLLECTION, FLOWS_COLLECTION, deleteFlowFolderCascade } from './flow-folders'
import { invalidateBrokenModuleRefsCache } from './broken-module-refs'
import { scanConfigReferences } from './config-references'
import { removeTagsFromUser } from './tagging'
import { TAG_DISCOVERY_COLLECTION } from './tag-discovery'
import { KNOWLEDGE_CHUNKS_COLLECTION, invalidateSourceProductCache, invalidateWorkspaceProductNames } from './ai-knowledge-chunks'
import { softDeleteKnowledgeChunk } from './ai-knowledge-chunk-delete'
import { KNOWLEDGE_SOURCES_COLLECTION } from './ai-knowledge-sources'
import { KNOWLEDGE_FOLDERS_COLLECTION, deleteFolderCascade } from './ai-knowledge-folders'
import {
  goneError,
  isPrecheck,
  isRehearsal,
  matchesRecorded,
  REHEARSED,
  type AuditRecordForRevert,
  type RevertCtx,
  type RevertHandler,
} from './audit-revert-common'
import { CONFIG_REF_KIND_LABEL, type ConfigRef, type ConfigReferenceIndex } from '~~/shared/config-references'
import type { Capability } from '~~/shared/permissions'
import type { TagDiscoveryDoc } from '~~/shared/tag-discovery'

type Rec = Record<string, unknown>

const nameOf = (row: AuditRecordForRevert, key = 'name') => String(row.after?.[key] ?? '').trim()

/** 新增類共用的計畫：要記下建了哪一份，確認框講「會把什麼拿掉」 */
function planCreate(row: AuditRecordForRevert, capability: Capability, what: string) {
  if (!row.targetId)
    return { ok: false as const, reason: '這筆是舊紀錄，沒有記下建了哪一份，所以還原不了。' }
  return { ok: true as const, capability, what }
}

/**
 * 建好之後又被改過了嗎：紀錄裡的「建出來的樣子」跟現在對不上。
 * ⛔ 對不上就不刪——後來的修改是別人（或自己）的工作，跟「收回一個手滑」不是同一件事。
 */
function editedSince(now: Rec, after: Rec | null | undefined, keys: readonly string[]): boolean {
  return keys.some(k => after && k in after && !matchesRecorded(now[k], after[k]))
}

function editedSinceError(what: string, page: string): Error {
  return createError({
    statusCode: 409,
    statusMessage: `${what}建好之後又被改過了，所以我沒有拿掉（避免連後來的修改一起丟掉）。要拿掉請到${page}。`,
  })
}

/** 「用到它的地方」講給人聽：最多列三個，其餘講總數 */
function refsText(refs: ConfigRef[]): string {
  const head = refs.slice(0, 3).map(r => `${CONFIG_REF_KIND_LABEL[r.kind]}「${r.label}」`).join('、')
  return refs.length > 3 ? `${head} 等 ${refs.length} 處` : head
}

/**
 * 掃一次「誰在用它」（不吃快取：60 秒前的答案可能剛好漏掉剛建的那個按鈕）。
 * ⛔ 某一類掃失敗或沒掃完，就不能說「沒有地方在用」——三態鐵律，查不到≠沒有。
 */
async function freshReferences(ctx: RevertCtx, page: string): Promise<ConfigReferenceIndex> {
  const idx = await scanConfigReferences(ctx.db, ctx.workspaceId, { skipCache: true })
  const unsure = [...idx.failedKinds, ...(idx.truncatedKinds ?? [])]
  if (unsure.length) {
    const kinds = [...new Set(unsure)].map(k => CONFIG_REF_KIND_LABEL[k]).join('、')
    throw createError({
      statusCode: 409,
      statusMessage: `${kinds}這幾類沒查完，沒辦法確定它有沒有被用到，所以我沒有拿掉——請到${page}自己確認後再刪。`,
    })
  }
  return idx
}

// ── 機器人模組 ─────────────────────────────────────────────────

const flowCreate: RevertHandler = {
  // 確認框只講會發生什麼：「沒被用到才刪」那道關在跳確認框之前已經預演過了，再講一次是廢話
  plan: row => planCreate(row, 'marketing.write', `刪掉模組「${nameOf(row)}」`),
  async apply(row, ctx) {
    const page = '「機器人模組」頁'
    const ref = ctx.db.collection(FLOWS_COLLECTION).doc(String(row.targetId))
    const snap = await ref.get()
    const d = snap.data() as Rec | undefined
    if (!snap.exists || d?.workspaceId !== ctx.workspaceId) throw goneError('那個模組')
    if (d.isSystem) throw createError({ statusCode: 403, statusMessage: '系統模組不可刪除' })
    // 紀錄存的形狀照 POST /api/flow/create（訊息只記幾則）
    const now = { ...d, messagesCount: Array.isArray(d.messages) ? d.messages.length : 0 }
    if (editedSince(now, row.after, ['name', 'isActive', 'folderId', 'messagesCount'])) throw editedSinceError('這個模組', page)

    // ⛔ 停用中的引用也算（停用的推播草稿還是會有人回頭按發送）。清單預查不掃（六類各讀幾百筆），按下去才掃
    if (!isPrecheck(ctx)) {
      const refs = (await freshReferences(ctx, page)).modules[String(row.targetId)] ?? []
      if (refs.length) {
        throw createError({
          statusCode: 409,
          statusMessage: `這個模組已經被用到了（${refsText(refs)}），所以我沒有刪掉——要刪請到${page}，那裡會講刪了會影響哪裡。`,
        })
      }
    }
    if (isRehearsal(ctx)) return REHEARSED

    // 刪法同 DELETE /api/flow/:id：真刪＋清「按鈕按下去沒反應」的快取
    await ref.delete()
    invalidateBrokenModuleRefsCache(ctx.workspaceId)
    return { message: `已經把模組「${String(d.name ?? '')}」刪掉了。`, before: row.after ?? null, after: null }
  },
}

// ── 模組資料夾、知識庫分組（資料夾）─────────────────────────────

const flowFolderCreate: RevertHandler = {
  plan: row => planCreate(row, 'marketing.write', `刪掉資料夾「${nameOf(row)}」`),
  async apply(row, ctx) {
    const page = '「機器人模組」頁'
    const id = String(row.targetId)
    const snap = await ctx.db.collection(FLOW_FOLDERS_COLLECTION).doc(id).get()
    const d = snap.data() as Rec | undefined
    if (!snap.exists || d?.workspaceId !== ctx.workspaceId) throw goneError('那個資料夾')
    if (editedSince(d, row.after, ['name'])) throw editedSinceError('這個資料夾', page)
    const inside = await ctx.db.collection(FLOWS_COLLECTION)
      .where('workspaceId', '==', ctx.workspaceId).where('folderId', '==', id).limit(1).get()
    if (!inside.empty)
      throw createError({ statusCode: 409, statusMessage: `這個資料夾裡已經放了模組，所以我沒有刪掉——要刪請到${page}。` })
    if (isRehearsal(ctx)) return REHEARSED
    await deleteFlowFolderCascade(ctx.db, ctx.workspaceId, id)
    return { message: `已經把資料夾「${String(d.name ?? '')}」刪掉了。`, before: row.after ?? null, after: null }
  },
}

const knowledgeFolderCreate: RevertHandler = {
  plan: row => planCreate(row, 'folders.write', `刪掉知識庫的分組「${nameOf(row)}」`),
  async apply(row, ctx) {
    const page = '「知識庫」頁'
    const id = String(row.targetId)
    const snap = await ctx.db.collection(KNOWLEDGE_FOLDERS_COLLECTION).doc(id).get()
    const d = snap.data() as Rec | undefined
    if (!snap.exists || d?.workspaceId !== ctx.workspaceId) throw goneError('那個分組')
    if (editedSince(d, row.after, ['name'])) throw editedSinceError('這個分組', page)
    const inside = await ctx.db.collection(KNOWLEDGE_SOURCES_COLLECTION)
      .where('workspaceId', '==', ctx.workspaceId).where('folderId', '==', id).limit(1).get()
    if (!inside.empty)
      throw createError({ statusCode: 409, statusMessage: `這個分組裡已經放了資料，所以我沒有刪掉——要刪請到${page}。` })
    if (isRehearsal(ctx)) return REHEARSED
    // 刪法同 DELETE /api/ai/folders/:folderId（空的分組不會有要清商品名的資料，照樣把快取清乾淨）
    const result = await deleteFolderCascade(ctx.db, ctx.workspaceId, id)
    for (const sid of result.clearedProductSourceIds) invalidateSourceProductCache(sid)
    if (result.clearedProductSourceIds.length) invalidateWorkspaceProductNames(ctx.workspaceId)
    return { message: `已經把分組「${String(d.name ?? '')}」刪掉了。`, before: row.after ?? null, after: null }
  },
}

// ── 標籤（自己建的、AI 發現後按「建立」的）──────────────────────

/** 標籤頁的「刪除」就是停用（歷史貼標與報表要留著，見 DELETE /api/tag/:id） */
async function deactivateTag(ctx: RevertCtx, tagId: string) {
  await ctx.db.collection('tags').doc(tagId).update({ status: 'inactive', updatedAt: FieldValue.serverTimestamp() })
}

async function readActiveTag(ctx: RevertCtx, row: AuditRecordForRevert, page: string): Promise<Rec> {
  const snap = await ctx.db.collection('tags').doc(String(row.targetId)).get()
  const d = snap.data() as Rec | undefined
  if (!snap.exists || d?.workspaceId !== ctx.workspaceId) throw goneError('那個標籤')
  if (d.status === 'inactive') throw createError({ statusCode: 409, statusMessage: '這個標籤已經停用了。' })
  if (editedSince(d, row.after, ['name', 'category', 'aiMode', 'color'])) throw editedSinceError('這個標籤', page)
  return d
}

/**
 * 幾位好友身上有這顆標籤。用 count()（讀一次算一筆、每千筆索引再加一筆）：
 * 清單每一列都要算，⛔ 不用 memberCountsForTagIds——那支一位讀一筆，500 位就是 500 筆讀取。
 */
async function tagHolderCount(ctx: RevertCtx, tagId: string): Promise<number> {
  const agg = await ctx.db.collection('userTags')
    .where('workspaceId', '==', ctx.workspaceId).where('tagId', '==', tagId).count().get()
  return Number(agg.data().count ?? 0)
}

function assertTagUnused(idx: ConfigReferenceIndex, tagId: string, page: string) {
  const refs = idx.tags[tagId] ?? []
  if (refs.length) {
    throw createError({
      statusCode: 409,
      statusMessage: `這個標籤已經被用到了（${refsText(refs)}），所以我沒有停用——要停用請到${page}。`,
    })
  }
}

const tagCreate: RevertHandler = {
  plan: row => planCreate(row, 'tags.write', `停用標籤「${nameOf(row)}」`),
  async apply(row, ctx) {
    const page = '「標籤」頁'
    const tagId = String(row.targetId)
    const d = await readActiveTag(ctx, row, page)
    const members = await tagHolderCount(ctx, tagId)
    if (members)
      throw createError({ statusCode: 409, statusMessage: `已經有 ${members} 位好友被貼上這個標籤了，所以我沒有停用——要停用請到${page}。` })
    if (!isPrecheck(ctx)) assertTagUnused(await freshReferences(ctx, page), tagId, page)
    if (isRehearsal(ctx)) return REHEARSED
    await deactivateTag(ctx, tagId)
    return { message: `已經把標籤「${String(d.name ?? '')}」停用了。`, before: row.after ?? null, after: null }
  },
}

/** AI 發現新標籤按「建立」時幫那批好友貼上用的來源記號（`POST /api/tag/discovery`） */
const DISCOVERY_ADOPT_REF = 'tag-discovery'

const tagDiscoveryAdopt: RevertHandler = {
  plan(row) {
    const n = Number(row.after?.taggedCount)
    return planCreate(row, 'tags.write',
      `停用標籤「${nameOf(row)}」，並從這次一起貼上的${Number.isFinite(n) ? ` ${n} 位` : ''}好友身上拿掉`)
  },
  async apply(row, ctx) {
    const page = '「標籤」頁'
    const tagId = String(row.targetId)
    const d = await readActiveTag(ctx, row, page)

    // 誰身上有這顆：這次一起貼的（來源記號 tag-discovery）可以拿；之後別的路貼上的不是這次給的，⛔ 不動
    const holders = await ctx.db.collection('userTags')
      .where('workspaceId', '==', ctx.workspaceId).where('tagId', '==', tagId)
      .select('userId', 'sourceRefId').get()
    const batch = holders.docs.filter(h => h.get('sourceRefId') === DISCOVERY_ADOPT_REF)
    const others = holders.size - batch.length
    if (others)
      throw createError({ statusCode: 409, statusMessage: `這個標籤之後又貼給了 ${others} 位好友（不是這次一起貼的），所以我沒有動——要停用請到${page}。` })
    if (!isPrecheck(ctx)) assertTagUnused(await freshReferences(ctx, page), tagId, page)
    if (isRehearsal(ctx)) return REHEARSED

    // ⛔ 先拿掉再停用（同「解除合併」）：拿一半失敗時標籤還開著、這筆還能再按一次把剩下的拿完
    let removed = 0
    let failed = 0
    const userIds = batch.map(h => String(h.get('userId') ?? '')).filter(Boolean)
    for (let i = 0; i < userIds.length; i += 10) {
      const results = await Promise.all(userIds.slice(i, i + 10).map(uid =>
        removeTagsFromUser(uid, [tagId], 'ai', `${DISCOVERY_ADOPT_REF}:revert`, ctx.workspaceId)
          .then(r => r.removed.length)
          .catch((e) => { console.warn('[audit-revert] tag-discovery revert failed:', uid, e); return -1 }),
      ))
      for (const n of results) {
        if (n > 0) removed += n
        else if (n < 0) failed += 1
      }
    }
    if (failed) {
      throw createError({
        statusCode: 500,
        statusMessage: `拿掉了 ${removed} 位，還有 ${failed} 位沒拿成，標籤還沒停用——請再按一次還原，會把剩下的拿完。`,
      })
    }
    await deactivateTag(ctx, tagId)

    // 標籤頁「先前的建議與決定」那一條標上已收回（⛔ 名字不進「不再建議」：收回的是這次建了，不是這個主題不要）
    const docRef = ctx.db.collection(TAG_DISCOVERY_COLLECTION).doc(ctx.workspaceId)
    await ctx.db.runTransaction(async (tx) => {
      const snap = await tx.get(docRef)
      const history = (snap.data() as TagDiscoveryDoc | undefined)?.history
      if (!Array.isArray(history) || !history.some(h => h.action === 'adopt' && h.tagId === tagId)) return
      tx.set(docRef, {
        history: history.map(h => (h.action === 'adopt' && h.tagId === tagId ? { ...h, revertedAtMs: Date.now() } : h)),
      }, { merge: true })
    }).catch(e => console.warn('[audit-revert] tag-discovery history stamp failed:', ctx.workspaceId, e))

    return {
      message: `已經把標籤「${String(d.name ?? '')}」停用，並從 ${removed} 位好友身上拿掉了。`,
      before: { ...(row.after ?? {}) },
      after: { removedCount: removed },
    }
  },
}

// ── 推播草稿（建立、複製、補發）─────────────────────────────────

/** 推播沒有「刪除」：頁面上能做的是取消（同 POST /api/broadcast/:id/cancel），清單會顯示「已取消」 */
const broadcastDraftCreate: RevertHandler = {
  plan: row => planCreate(row, 'broadcast.send', `取消推播草稿「${nameOf(row)}」（推播頁會顯示「已取消」，不會送出）`),
  async apply(row, ctx) {
    const page = '「推播」頁'
    const ref = ctx.db.collection('broadcasts').doc(String(row.targetId))
    const name = await ctx.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      const b = snap.data() as Rec | undefined
      if (!snap.exists || b?.workspaceId !== ctx.workspaceId) throw goneError('那則推播')
      if (b.status === 'scheduled')
        throw createError({ statusCode: 409, statusMessage: `這則推播已經排程了，所以我沒有取消——要取消請到${page}。` })
      if (b.status !== 'draft')
        throw createError({ statusCode: 409, statusMessage: '這則推播已經送出、正在送或已經取消了，收不回來。' })
      const now = { ...b, messagesCount: Array.isArray(b.messages) ? b.messages.length : 0 }
      if (editedSince(now, row.after, ['name', 'messagesCount'])) throw editedSinceError('這則推播草稿', page)
      if (!isRehearsal(ctx)) tx.update(ref, { status: 'cancelled', updatedAt: FieldValue.serverTimestamp() })
      return String(b.name ?? '')
    })
    if (isRehearsal(ctx)) return REHEARSED
    return { message: `已經把推播草稿「${name}」取消了，不會送出。`, before: { status: 'draft' }, after: { status: 'cancelled' } }
  },
}

// ── 知識 ──────────────────────────────────────────────────────

const knowledgeCreate: RevertHandler = {
  plan: row => planCreate(row, 'knowledge.write', `把知識「${nameOf(row, 'title')}」丟進回收桶（30 天內救得回來）`),
  async apply(row, ctx) {
    const page = '「知識庫」頁'
    const id = String(row.targetId)
    const snap = await ctx.db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(id).get()
    const d = snap.data() as Rec | undefined
    if (!snap.exists || d?.workspaceId !== ctx.workspaceId) throw goneError('那條知識')
    if (d.deletedAt != null) throw createError({ statusCode: 409, statusMessage: '這條知識已經在回收桶裡了。' })
    if (editedSince(d, row.after, ['title'])) throw editedSinceError('這條知識', page)
    if (isRehearsal(ctx)) return REHEARSED
    // 丟法同知識庫頁的「刪除」（試算表那一列、單張手寫來源、空間快取都一起處理）
    const res = await softDeleteKnowledgeChunk(ctx.db, ctx.workspaceId, id)
    if (!res.deleted) throw goneError('那條知識')
    return {
      message: `已經把「${res.title}」丟進回收桶，30 天內可以在知識庫的回收桶救回來。`,
      before: row.after ?? null,
      after: null,
    }
  },
}

// ── 加好友活動 ─────────────────────────────────────────────────

/** 有人透過活動加好友、或正在處理中的那幾種（`shared/types/lead-campaign.ts`；共用入口那一筆範本是 pending） */
const CLAIM_USED_STATUSES = ['claimed', 'applying', 'applied']

const campaignCreate: RevertHandler = {
  plan: row => planCreate(row, 'marketing.write', `刪掉加好友活動「${nameOf(row)}」`),
  async apply(row, ctx) {
    const page = '「加好友活動」頁'
    const id = String(row.targetId)
    const ref = ctx.db.collection('leadCampaigns').doc(id)
    const snap = await ref.get()
    const d = snap.data() as Rec | undefined
    if (!snap.exists || d?.workspaceId !== ctx.workspaceId) throw goneError('那個活動')
    // 紀錄存的形狀照 POST /api/campaigns/create（isActive 沒寫＝開著、標籤只記幾個）
    const now = { name: String(d.name ?? ''), isActive: d.isActive !== false, itemsCount: Array.isArray(d.tagIds) ? d.tagIds.length : 0 }
    if (editedSince(now, row.after, ['name', 'isActive', 'itemsCount'])) throw editedSinceError('這個活動', page)

    // 用 count()：清單每一列都要數，大活動一讀就是幾百筆（2026-10-28 對 MYFEEL 五個活動實測，
    // 數字跟逐筆讀再濾一模一樣，現有索引就跑得動）。共用入口那一筆範本是 pending，不在這三種裡
    const used = Number((await ctx.db.collection('leadClaims')
      .where('campaignId', '==', id).where('status', 'in', CLAIM_USED_STATUSES).count().get()).data().count ?? 0)
    if (used) {
      throw createError({
        statusCode: 409,
        statusMessage: `已經有 ${used} 位客人透過這個活動加好友了，所以我沒有刪掉——要停掉請到${page}把它關掉。`,
      })
    }
    if (isRehearsal(ctx)) return REHEARSED
    // 刪法同 DELETE /api/campaigns/:id（真刪）；活動也在「按鈕按下去沒反應」的檢查範圍裡，快取一起清
    await ref.delete()
    invalidateBrokenModuleRefsCache(ctx.workspaceId)
    return { message: `已經把活動「${now.name}」刪掉了。`, before: row.after ?? null, after: null }
  },
}

/** 動作代號 → 怎麼還原（第二批：新增的東西） */
export const CREATE_REVERT_HANDLERS: Record<string, RevertHandler> = {
  'flow.create': flowCreate,
  'flowFolder.create': flowFolderCreate,
  'knowledgeFolder.create': knowledgeFolderCreate,
  'tag.create': tagCreate,
  'tagDiscovery.adopt': tagDiscoveryAdopt,
  'broadcast.create': broadcastDraftCreate,
  'broadcast.duplicate': broadcastDraftCreate,
  'broadcast.followUp': broadcastDraftCreate,
  'knowledge.create': knowledgeCreate,
  'campaign.create': campaignCreate,
}
