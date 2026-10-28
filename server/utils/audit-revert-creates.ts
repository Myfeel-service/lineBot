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
 * - 檢查（只讀）跟動手分兩段（`RevertHandler.check`）：寫入只出現在回傳的那個函式裡
 */
import { FieldValue, type DocumentSnapshot, type Timestamp } from 'firebase-admin/firestore'
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
  matchesRecorded,
  type AuditRecordForRevert,
  type RevertCtx,
  type RevertHandler,
  type RevertStage,
} from './audit-revert-common'
import { CONFIG_REF_KIND_LABEL, type ConfigRef, type ConfigRefKind, type ConfigReferenceIndex } from '~~/shared/config-references'
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
 * ⚠️ 只比得到紀錄裡有的那幾格；內容（模組的訊息、活動要貼哪幾顆）紀錄只記數量，那兩種另外看寫入時間。
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

/** 兩個 Firestore 時間是同一刻嗎（任一個沒有＝說不準，當作不是） */
function sameInstant(a: unknown, b: unknown): boolean {
  const ta = a as Timestamp | undefined
  const tb = b as Timestamp | undefined
  return typeof ta?.isEqual === 'function' && !!tb && ta.isEqual(tb)
}

/**
 * 真刪那一步：只在「檢查之後沒人再寫過它」時刪（Firestore 的前置條件，跟檢查之間隔了一次掃描也守得住）。
 * 被搶先寫了＝回「又被改過」，⛔ 不刪
 */
async function deleteIfUnchanged(snap: DocumentSnapshot, what: string, page: string): Promise<void> {
  try {
    await snap.ref.delete(snap.updateTime ? { lastUpdateTime: snap.updateTime } : undefined)
  }
  catch (e: any) {
    // FAILED_PRECONDITION＝9
    if (e?.code === 9) throw editedSinceError(what, page)
    throw e
  }
}

/** 「用到它的地方」講給人聽：最多列三個，其餘講總數 */
function refsText(refs: ConfigRef[]): string {
  const head = refs.slice(0, 3).map(r => `${CONFIG_REF_KIND_LABEL[r.kind]}「${r.label}」`).join('、')
  return refs.length > 3 ? `${head} 等 ${refs.length} 處` : head
}

/**
 * 掃一次「誰在用它」。按下「還原」那一刻（confirm）可以用 60 秒內掃過的；
 * 按了「確定還原」要動手時（apply）⛔ 不吃快取——60 秒前的答案可能剛好漏掉剛建的那個按鈕。
 * ⛔ 某一類掃失敗或沒掃完，就不能說「沒有地方在用」——三態鐵律，查不到≠沒有。
 *    掃失敗＝暫時的（503，畫面留著按鈕，等一下再按）；沒掃完＝筆數太多，再按也一樣（409）
 */
async function referencesFor(ctx: RevertCtx, stage: RevertStage, page: string): Promise<ConfigReferenceIndex> {
  const idx = await scanConfigReferences(ctx.db, ctx.workspaceId, { skipCache: stage === 'apply' })
  const label = (kinds: ConfigRefKind[]) => [...new Set(kinds)].map(k => CONFIG_REF_KIND_LABEL[k]).join('、')
  if (idx.failedKinds.length) {
    throw createError({
      statusCode: 503,
      statusMessage: `${label(idx.failedKinds)}這幾類這次沒查成功，沒辦法確定它有沒有被用到，所以我沒有拿掉——請等一下再按一次。`,
    })
  }
  if (idx.truncatedKinds?.length) {
    throw createError({
      statusCode: 409,
      statusMessage: `${label(idx.truncatedKinds)}這幾類筆數太多、沒查完，沒辦法確定它有沒有被用到，所以我沒有拿掉——請到${page}自己確認後再刪。`,
    })
  }
  return idx
}

// ── 機器人模組 ─────────────────────────────────────────────────

const flowCreate: RevertHandler = {
  // 確認框只講會發生什麼：「沒被用到才刪」那道關在跳確認框之前已經預演過了，再講一次是廢話
  plan: row => planCreate(row, 'marketing.write', `刪掉模組「${nameOf(row)}」`),
  async check(row, ctx, stage) {
    const page = '「機器人模組」頁'
    const snap = await ctx.db.collection(FLOWS_COLLECTION).doc(String(row.targetId)).get()
    const d = snap.data() as Rec | undefined
    if (!snap.exists || d?.workspaceId !== ctx.workspaceId) throw goneError('那個模組')
    if (d.isSystem) throw createError({ statusCode: 403, statusMessage: '系統模組不可刪除' })
    /*
     * 建好之後有沒有再存過：看 Firestore 自己記的建立／最後寫入時間（code review `C-412`）。
     * ⛔ 不能只比紀錄裡的名稱、則數：同事把佔位的那一則改成正式文案（則數沒變、而且這種修改不留紀錄 `C-411`），
     *    比不出來，模組又沒有回收桶——真刪就把他的工作丟了。
     * ⚠️ 調順序（拖曳、複製別的模組插在上面）也會寫到它，一樣算「存過」：寧可多擋，不可誤刪
     */
    if (!snap.createTime || !snap.updateTime || !snap.updateTime.isEqual(snap.createTime)) {
      throw createError({
        statusCode: 409,
        statusMessage: `這個模組建好之後又被存過（改內容、調順序都算），所以我沒有刪掉（避免連後來的修改一起丟掉）。要刪請到${page}。`,
      })
    }

    // ⛔ 停用中的引用也算（停用的推播草稿還是會有人回頭按發送）。清單預查不掃（六類各讀幾百筆），按下去才掃
    if (stage !== 'list') {
      const refs = (await referencesFor(ctx, stage, page)).modules[String(row.targetId)] ?? []
      if (refs.length) {
        throw createError({
          statusCode: 409,
          statusMessage: `這個模組已經被用到了（${refsText(refs)}），所以我沒有刪掉——要刪請到${page}，那裡會講刪了會影響哪裡。`,
        })
      }
    }

    return async () => {
      // 刪法同 DELETE /api/flow/:id：真刪＋清「按鈕按下去沒反應」的快取
      await deleteIfUnchanged(snap, '這個模組', page)
      invalidateBrokenModuleRefsCache(ctx.workspaceId)
      return { message: `已經把模組「${String(d.name ?? '')}」刪掉了。`, before: row.after ?? null, after: null }
    }
  },
}

// ── 模組資料夾、知識庫分組（資料夾）─────────────────────────────

const flowFolderCreate: RevertHandler = {
  plan: row => planCreate(row, 'marketing.write', `刪掉資料夾「${nameOf(row)}」`),
  async check(row, ctx) {
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
    return async () => {
      await deleteFlowFolderCascade(ctx.db, ctx.workspaceId, id)
      return { message: `已經把資料夾「${String(d.name ?? '')}」刪掉了。`, before: row.after ?? null, after: null }
    }
  },
}

const knowledgeFolderCreate: RevertHandler = {
  plan: row => planCreate(row, 'folders.write', `刪掉知識庫的分組「${nameOf(row)}」`),
  async check(row, ctx) {
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
    return async () => {
      // 刪法同 DELETE /api/ai/folders/:folderId（空的分組不會有要清商品名的資料，照樣把快取清乾淨）
      const result = await deleteFolderCascade(ctx.db, ctx.workspaceId, id)
      for (const sid of result.clearedProductSourceIds) invalidateSourceProductCache(sid)
      if (result.clearedProductSourceIds.length) invalidateWorkspaceProductNames(ctx.workspaceId)
      return { message: `已經把分組「${String(d.name ?? '')}」刪掉了。`, before: row.after ?? null, after: null }
    }
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
 * 清單每一列都要算，⛔ 不逐位讀——memberCountsForTagIds 一位讀一筆，500 位就是 500 筆讀取。
 * `sourceRefId`：只數某一條路貼上的（AI 發現新標籤按「建立」那一批）
 */
async function tagHolderCount(ctx: RevertCtx, tagId: string, sourceRefId?: string): Promise<number> {
  let q = ctx.db.collection('userTags').where('workspaceId', '==', ctx.workspaceId).where('tagId', '==', tagId)
  if (sourceRefId) q = q.where('sourceRefId', '==', sourceRefId)
  return Number((await q.count().get()).data().count ?? 0)
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
  async check(row, ctx, stage) {
    const page = '「標籤」頁'
    const tagId = String(row.targetId)
    const d = await readActiveTag(ctx, row, page)
    const members = await tagHolderCount(ctx, tagId)
    if (members)
      throw createError({ statusCode: 409, statusMessage: `已經有 ${members} 位好友被貼上這個標籤了，所以我沒有停用——要停用請到${page}。` })
    if (stage !== 'list') assertTagUnused(await referencesFor(ctx, stage, page), tagId, page)
    return async () => {
      await deactivateTag(ctx, tagId)
      return { message: `已經把標籤「${String(d.name ?? '')}」停用了。`, before: row.after ?? null, after: null }
    }
  },
}

/** AI 發現新標籤按「建立」時幫那批好友貼上用的來源記號（`POST /api/tag/discovery`） */
const DISCOVERY_ADOPT_REF = 'tag-discovery'

function otherHoldersError(others: number, page: string): Error {
  return createError({ statusCode: 409, statusMessage: `這個標籤之後又貼給了 ${others} 位好友（不是這次一起貼的），所以我沒有動——要停用請到${page}。` })
}

const tagDiscoveryAdopt: RevertHandler = {
  plan(row) {
    const n = Number(row.after?.taggedCount)
    return planCreate(row, 'tags.write',
      `停用標籤「${nameOf(row)}」，並從這次一起貼上的${Number.isFinite(n) ? ` ${n} 位` : ''}好友身上拿掉`)
  },
  async check(row, ctx, stage) {
    const page = '「標籤」頁'
    const tagId = String(row.targetId)
    const d = await readActiveTag(ctx, row, page)

    // 誰身上有這顆：這次一起貼的（來源記號 tag-discovery）可以拿；之後別的路貼上的不是這次給的，⛔ 不動。
    // 兩次 count()，⛔ 不逐位讀（清單每一列都要算；被貼了幾百位的標籤就是幾百筆讀取，code review `C-412`）
    const [all, ours] = await Promise.all([tagHolderCount(ctx, tagId), tagHolderCount(ctx, tagId, DISCOVERY_ADOPT_REF)])
    if (all > ours) throw otherHoldersError(all - ours, page)
    if (stage !== 'list') assertTagUnused(await referencesFor(ctx, stage, page), tagId, page)

    return async () => {
      // 這時候才逐位讀（要拿名單去一位位拿掉），順便再驗一次「沒有別的路貼上的」
      const holders = await ctx.db.collection('userTags')
        .where('workspaceId', '==', ctx.workspaceId).where('tagId', '==', tagId)
        .select('userId', 'sourceRefId').get()
      const batch = holders.docs.filter(h => h.get('sourceRefId') === DISCOVERY_ADOPT_REF)
      if (holders.size > batch.length) throw otherHoldersError(holders.size - batch.length, page)

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

      // 標籤頁「先前的建議與決定」那一條標上已收回。
      // ⚠️ 名字沒進「不再建議」，但停用的標籤名字一樣會擋 AI 再提同一個（`loadExistingTags` 連停用的都讀），
      //    要再用請到標籤頁把它重新啟用
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
    }
  },
}

// ── 推播草稿（建立、複製、補發）─────────────────────────────────

/** 推播沒有「刪除」：頁面上能做的是取消（同 POST /api/broadcast/:id/cancel），清單會顯示「已取消」 */
const broadcastDraftCreate: RevertHandler = {
  plan: row => planCreate(row, 'broadcast.send', `取消推播草稿「${nameOf(row)}」（推播頁會顯示「已取消」，不會送出）`),
  async check(row, ctx) {
    const page = '「推播」頁'
    const ref = ctx.db.collection('broadcasts').doc(String(row.targetId))
    const verify = (snap: DocumentSnapshot) => {
      const b = snap.data() as Rec | undefined
      if (!snap.exists || b?.workspaceId !== ctx.workspaceId) throw goneError('那則推播')
      if (b.status === 'scheduled')
        throw createError({ statusCode: 409, statusMessage: `這則推播已經排程了，所以我沒有取消——要取消請到${page}。` })
      if (b.status !== 'draft')
        throw createError({ statusCode: 409, statusMessage: '這則推播已經送出、正在送或已經取消了，收不回來。' })
      const now = { ...b, messagesCount: Array.isArray(b.messages) ? b.messages.length : 0 }
      if (editedSince(now, row.after, ['name', 'messagesCount'])) throw editedSinceError('這則推播草稿', page)
      return String(b.name ?? '')
    }
    verify(await ref.get())

    return async () => {
      // ⛔ 交易裡再驗一次：檢查之後有人按了「排程」或「送出」就不能再改成已取消
      const name = await ctx.db.runTransaction(async (tx) => {
        const n = verify(await tx.get(ref))
        tx.update(ref, { status: 'cancelled', updatedAt: FieldValue.serverTimestamp() })
        return n
      })
      return { message: `已經把推播草稿「${name}」取消了，不會送出。`, before: { status: 'draft' }, after: { status: 'cancelled' } }
    }
  },
}

// ── 知識 ──────────────────────────────────────────────────────

const knowledgeCreate: RevertHandler = {
  plan: row => planCreate(row, 'knowledge.write', `把知識「${nameOf(row, 'title')}」丟進回收桶（30 天內救得回來）`),
  async check(row, ctx) {
    const page = '「知識庫」頁'
    const id = String(row.targetId)
    const snap = await ctx.db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(id).get()
    const d = snap.data() as Rec | undefined
    if (!snap.exists || d?.workspaceId !== ctx.workspaceId) throw goneError('那條知識')
    if (d.deletedAt != null) throw createError({ statusCode: 409, statusMessage: '這條知識已經在回收桶裡了。' })
    if (editedSince(d, row.after, ['title'])) throw editedSinceError('這條知識', page)
    return async () => {
      // 丟法同知識庫頁的「刪除」（試算表那一列、單張手寫來源、空間快取都一起處理）
      const res = await softDeleteKnowledgeChunk(ctx.db, ctx.workspaceId, id)
      if (!res.deleted) throw goneError('那條知識')
      return {
        message: `已經把「${res.title}」丟進回收桶，30 天內可以在知識庫的回收桶救回來。`,
        before: row.after ?? null,
        after: null,
      }
    }
  },
}

// ── 加好友活動 ─────────────────────────────────────────────────

/** 有人透過活動加好友、或正在處理中的那幾種（`shared/types/lead-campaign.ts`；共用入口那一筆範本是 pending） */
const CLAIM_USED_STATUSES = ['claimed', 'applying', 'applied']

const campaignCreate: RevertHandler = {
  plan: row => planCreate(row, 'marketing.write', `刪掉加好友活動「${nameOf(row)}」`),
  async check(row, ctx) {
    const page = '「加好友活動」頁'
    const id = String(row.targetId)
    const snap = await ctx.db.collection('leadCampaigns').doc(id).get()
    const d = snap.data() as Rec | undefined
    if (!snap.exists || d?.workspaceId !== ctx.workspaceId) throw goneError('那個活動')
    /*
     * 建好之後有沒有再存過：建立時 createdAt＝updatedAt（同一個伺服器時間），之後每一條改活動的路
     * （活動頁存檔、修壞掉的模組按鈕、這裡的還原）都會蓋 updatedAt（code review `C-412`）。
     * ⛔ 不能只比名稱、開關、標籤「幾個」：換了要貼的標籤（個數沒變）、改了觸發的模組或網址都比不出來，而活動是真刪。
     * ⚠️ 活動連結那一步（publishedCtaUrl）不蓋 updatedAt，所以剛建好的活動不會被它誤判成「存過」
     */
    if (!sameInstant(d.updatedAt, d.createdAt)) throw editedSinceError('這個活動', page)

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
    return async () => {
      // 刪法同 DELETE /api/campaigns/:id（真刪）；活動也在「按鈕按下去沒反應」的檢查範圍裡，快取一起清
      await deleteIfUnchanged(snap, '這個活動', page)
      invalidateBrokenModuleRefsCache(ctx.workspaceId)
      return { message: `已經把活動「${String(d.name ?? '')}」刪掉了。`, before: row.after ?? null, after: null }
    }
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
