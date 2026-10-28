/**
 * 「還原這一筆」第一批：**改了一個值、紀錄裡有完整的「改之前」**的那幾種（2026-10-28 `D-156` ①）。
 *
 * 為什麼要有：做「還原」時（09-16）只接了 AI 設定跟自動回應上下架，`C-254` 之後紀錄補到 95 支，
 * 還原沒跟上——MYFEEL 242 筆只有 12 筆按得動，模組改名、搬資料夾這種最常手滑的一筆都收不回來。
 *
 * 每一種都守同一套規矩（`audit-revert.ts` 檔頭）：
 * - ⛔ 現值還等於當時的「改之後」才動手，否則就是拿舊判斷蓋掉別人後來的修改
 * - ⛔ 白名單：紀錄裡出現沒想過的欄位就整筆不還原（寫一半比不寫更糟）
 * - ⛔ 原本那個動作有的護欄這裡一條都不能少——能走原本那支共用函式的就走它（權限、搬資料夾），
 *    走不了的照抄規則並註明出處
 */
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { FLOW_FOLDERS_COLLECTION, FLOWS_COLLECTION } from './flow-folders'
import { assertValidFlowName } from './flow-validator'
import { invalidateBrokenModuleRefsCache } from './broken-module-refs'
import { assertPlanAllows } from './billing'
import { getSource, updateSourceSettings } from './ai-knowledge-sources'
import { syncSourceAfterMove } from './ai-knowledge-source-move'
import { KNOWLEDGE_CHUNKS_COLLECTION } from './ai-knowledge-chunks'
import { ASSIGNABLE_MEMBER_ROLES, changeWorkspaceMemberRole } from './workspace-member-role'
import { memberNotifyKindsNow, setMemberNotifyKind, setMemberNotifyReceiving } from './member-line-bind'
import { syncPublishedEntryUrlForCampaign } from './lead-campaign-published-url'
import { assertFutureBroadcastScheduleAt } from './broadcast-schedule'
import { auditTimeText } from './audit-log'
import {
  changedSinceError,
  goneError,
  isRehearsal,
  matchesRecorded,
  onlyKeys,
  recordsNoChange,
  REHEARSED,
  type AuditRecordForRevert,
  type RevertHandler,
  type RevertPlan,
} from './audit-revert-common'
import { planAllowsScripting } from '~~/shared/billing/plans'
import { TAG_CATEGORY_OPTIONS } from '~~/shared/tag-admin'
import { NOTIFY_KIND_LABELS, NOTIFY_KINDS, type NotifyKind } from '~~/shared/line-notify-list'
import { auditTimeLabel, AUDIT_VALUE_LABELS } from '~~/shared/types/audit'
import type { Capability } from '~~/shared/permissions'
import type { WorkspaceMemberRole } from '~~/shared/types/organization'

type Rec = Record<string, unknown>

/**
 * 共用的前幾道關：有沒有記下動到哪一份、有沒有記到改了什麼、欄位在不在白名單裡。
 * `refuse`：白名單以外的欄位要講的那句話（各種動作不一樣，講去哪裡改）。
 */
function planFields(
  row: AuditRecordForRevert,
  opts: { allowed: readonly string[], capability: Capability, what: string, page: string, refuse: string },
): RevertPlan {
  if (!row.targetId)
    return { ok: false, reason: `這筆是舊紀錄，沒有記下動到哪一份，所以還原不了——請到${opts.page}自己改回來。` }
  if (recordsNoChange(row))
    return { ok: false, reason: '這筆沒有記到改了哪一格，還原不了。' }
  if (!onlyKeys(row.before, opts.allowed) || !onlyKeys(row.after, opts.allowed))
    return { ok: false, reason: opts.refuse }
  return { ok: true, capability: opts.capability, what: opts.what }
}

/** 現值（只看紀錄裡有寫到的那幾格）還是當時的「改之後」嗎 */
function stillAsRecorded(current: Rec, after: Rec | null | undefined): boolean {
  return Object.entries(after ?? {}).every(([k, v]) => matchesRecorded(current[k], v))
}

const swap = (row: AuditRecordForRevert) => ({ before: row.after ?? null, after: row.before ?? null })

// ── 機器人模組：改名、開關、搬資料夾 ─────────────────────────────

const FLOW_KEYS = ['name', 'isActive', 'folderId'] as const

const flowPut: RevertHandler = {
  plan: row => planFields(row, {
    allowed: FLOW_KEYS,
    capability: 'marketing.write',
    what: '把這個模組的名稱／開關／所在資料夾改回原本的樣子',
    page: '「機器人模組」頁',
    // 訊息內容紀錄只記「幾則」（整份存進來會被截斷、反而整筆不能還原），寫不回去
    refuse: '這筆改了模組裡的訊息，紀錄只記了幾則、沒記內容，沒辦法一鍵還原——請到「機器人模組」頁改回來。',
  }),
  async apply(row, ctx) {
    const { db, workspaceId } = ctx
    // 方案閘門跟 PUT /api/flow/:id 同一道（D-69 拍板④）
    await assertPlanAllows(workspaceId, planAllowsScripting, '這個方案不含流程自動化功能，請升級方案後再使用')
    const before = row.before ?? {}
    const write: Rec = {}
    if ('name' in before) write.name = assertValidFlowName(before.name)
    if ('isActive' in before) write.isActive = before.isActive === null ? FieldValue.delete() : before.isActive === true
    if ('folderId' in before) {
      const folderId = typeof before.folderId === 'string' && before.folderId ? before.folderId : null
      if (folderId) {
        const f = await db.collection(FLOW_FOLDERS_COLLECTION).doc(folderId).get()
        if (!f.exists || f.data()?.workspaceId !== workspaceId)
          throw createError({ statusCode: 409, statusMessage: '原本的資料夾已經刪掉了，放不回去——請到「機器人模組」頁另外選一個資料夾。' })
      }
      write.folderId = folderId
    }

    const ref = db.collection(FLOWS_COLLECTION).doc(String(row.targetId))
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      if (!snap.exists || snap.data()?.workspaceId !== workspaceId) throw goneError('那個模組')
      if (!stillAsRecorded(snap.data()!, row.after)) throw changedSinceError('這個模組')
      if (!isRehearsal(ctx)) tx.update(ref, { ...write, updatedAt: FieldValue.serverTimestamp() })
    })
    if (isRehearsal(ctx)) return REHEARSED
    // 讓「按鈕按下去沒反應」的異常檢查立刻反映（同 PUT /api/flow/:id）
    invalidateBrokenModuleRefsCache(workspaceId)
    return { message: '已經把這個模組改回原本的樣子。', ...swap(row) }
  },
}

// ── 標籤：改名、分類、顏色、說明、停用、AI 判斷 ─────────────────

const TAG_KEYS = ['name', 'category', 'color', 'description', 'status', 'aiMode', 'aiCriteria'] as const
const TAG_CATEGORIES: readonly string[] = TAG_CATEGORY_OPTIONS.map(o => o.value)

const tagPut: RevertHandler = {
  plan: row => planFields(row, {
    allowed: TAG_KEYS,
    capability: 'tags.write',
    what: '把這個標籤改回原本的樣子',
    page: '「標籤」頁',
    refuse: '這筆動到的標籤欄位目前不支援一鍵還原，請到「標籤」頁改回來。',
  }),
  async apply(row, ctx) {
    const { db, workspaceId } = ctx
    const before = row.before ?? {}
    const write: Rec = {}
    for (const [k, v] of Object.entries(before)) {
      // 規則照 POST /api/tag/create、PUT /api/tag/:id：名字不能空、分類／狀態／AI 判斷只收認得的值
      if (k === 'name') {
        if (typeof v !== 'string' || !v.trim()) throw createError({ statusCode: 400, statusMessage: '這筆沒記到原本的名字，還原不了。' })
        write.name = v
      }
      else if (k === 'category') {
        if (typeof v !== 'string' || !TAG_CATEGORIES.includes(v)) throw createError({ statusCode: 400, statusMessage: '這筆記到的分類認不得，還原不了。' })
        write.category = v
      }
      else if (k === 'status') {
        if (v !== 'active' && v !== 'inactive') throw createError({ statusCode: 400, statusMessage: '這筆記到的狀態認不得，還原不了。' })
        write.status = v
      }
      else if (k === 'aiMode') {
        // 沒有這一格＝off（舊標籤），寫回「沒有」就好
        if (v !== null && v !== 'off' && v !== 'suggest' && v !== 'auto') throw createError({ statusCode: 400, statusMessage: '這筆記到的 AI 判斷方式認不得，還原不了。' })
        write.aiMode = v === null ? FieldValue.delete() : v
      }
      else {
        write[k] = v === null ? FieldValue.delete() : String(v)
      }
    }

    const ref = db.collection('tags').doc(String(row.targetId))
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      if (!snap.exists || snap.data()?.workspaceId !== workspaceId) throw goneError('那個標籤')
      if (!stillAsRecorded(snap.data()!, row.after)) throw changedSinceError('這個標籤')
      if (!isRehearsal(ctx)) tx.update(ref, { ...write, updatedAt: FieldValue.serverTimestamp() })
    })
    if (isRehearsal(ctx)) return REHEARSED
    return { message: '已經把這個標籤改回原本的樣子。', ...swap(row) }
  },
}

// ── 知識庫的一份資料：改名、搬分組、多久同步、變動時怎麼處理 ────────

const SOURCE_KEYS = ['name', 'folderId', 'refreshIntervalMinutes', 'onChangeBehavior'] as const

const sourcePut: RevertHandler = {
  plan(row) {
    const base = planFields(row, {
      allowed: SOURCE_KEYS,
      capability: 'sources.write',
      what: '把這份資料改回原本的樣子（搬回原本的分組的話，AI 會跟著重新學一次）',
      page: '「知識庫」頁',
      // 商品名跟著分組走（`D-127`，多半是系統對齊的）；網址一改就把比對基準整個重設
      refuse: '這筆動到這份資料的商品名或網址，沒辦法一鍵還原——請到「知識庫」這份資料自己改回來。',
    })
    if (!base.ok) return base
    // 原本「沒有設定」的那幾格寫不回去（updateSourceSettings 只收有值的），⛔ 不可以回「還原了」卻沒變
    const before = row.before ?? {}
    if (['name', 'refreshIntervalMinutes', 'onChangeBehavior'].some(k => k in before && before[k] == null))
      return { ok: false, reason: '這筆原本是「沒有設定」，沒辦法一鍵改回去——請到「知識庫」這份資料自己改。' }
    return base
  },
  async apply(row, ctx) {
    const { db, workspaceId, uid } = ctx
    const sourceId = String(row.targetId)
    const src = await getSource(db, sourceId, workspaceId)
    if (!src) throw goneError('那份資料')
    if (!stillAsRecorded(src.data as unknown as Rec, row.after)) throw changedSinceError('這份資料')
    if (isRehearsal(ctx)) return REHEARSED

    const before = row.before ?? {}
    // 走跟 PUT /api/ai/sources/:sourceId 同一支（資料夾要是這個帳號的、找不到會講）
    await updateSourceSettings(db, workspaceId, sourceId, {
      ...('name' in before ? { name: String(before.name) } : {}),
      ...('folderId' in before ? { folderId: typeof before.folderId === 'string' && before.folderId ? before.folderId : null } : {}),
      ...('refreshIntervalMinutes' in before ? { refreshIntervalMinutes: Number(before.refreshIntervalMinutes) } : {}),
      ...('onChangeBehavior' in before ? { onChangeBehavior: before.onChangeBehavior as never } : {}),
    })

    // ⛔ 搬回原本的分組＝商品名也要跟著換回來、重新學（只寫 folderId 的話 AI 還當成搬過去那一台）
    if ('folderId' in before) {
      const moved = await syncSourceAfterMove(db, workspaceId, sourceId, uid)
      if (moved.error)
        return { message: '已經把這份資料搬回原本的分組；AI 重新學的那一步還沒做完，系統會自己補上。', ...swap(row) }
      if (moved.sync.changed)
        return { message: '已經把這份資料搬回原本的分組，AI 也跟著重新學了一次。', ...swap(row) }
    }
    return { message: '已經把這份資料改回原本的樣子。', ...swap(row) }
  },
}

// ── 成員權限 ───────────────────────────────────────────────────

const roleLabel = (r: unknown) => AUDIT_VALUE_LABELS.role?.[String(r)] ?? String(r)

const memberRole: RevertHandler = {
  plan(row) {
    const was = row.before?.role
    if (!row.targetId || typeof was !== 'string' || !was || typeof row.after?.role !== 'string')
      return { ok: false, reason: '這筆沒記到原本的權限，還原不了——請到「成員管理」頁自己改回來。' }
    // ⛔ 誰都不能把人改成擁有者（`G-96`），還原也不行
    if (!ASSIGNABLE_MEMBER_ROLES.includes(was as WorkspaceMemberRole))
      return { ok: false, reason: '這位原本是擁有者，擁有者沒辦法用還原改回來——請找組織管理員處理。' }
    if (was === row.after.role) return { ok: false, reason: '這筆沒有記到改了哪一格，還原不了。' }
    return { ok: true, capability: 'members.manage', what: `把他的權限改回「${roleLabel(was)}」` }
  },
  async apply(row, ctx) {
    const { db, workspaceId, uid, isSuperAdmin, isOrgAdmin } = ctx
    const targetUid = String(row.targetId)
    const role = String(row.before?.role) as WorkspaceMemberRole
    // 同 PUT .../members/:uid 護欄①：手滑把自己改掉會被踢出設定頁、沒有權限再改回來（超管例外）
    if (targetUid === uid && !isSuperAdmin)
      throw createError({ statusCode: 400, statusMessage: '不能還原自己的權限，請由其他管理員操作。' })
    const snap = await db.collection('workspaceMembers').doc(`${targetUid}_${workspaceId}`).get()
    if (!snap.exists) throw goneError('這位成員')
    if (snap.data()?.role !== row.after?.role) throw changedSinceError('這位成員的權限')
    // ⚠️ 預演看不到「會不會變成零管理員」那一關（在下面那支交易裡），真的按下去時照樣會擋
    if (isRehearsal(ctx)) return REHEARSED

    // 擁有者、零管理員、降成觀察者要拿掉通知——全在同一支（跟成員管理頁改權限同一套）
    const { notifyRemoved } = await changeWorkspaceMemberRole(db, {
      workspaceId,
      targetUid,
      role,
      canTouchOwner: !!(isOrgAdmin || isSuperAdmin),
    })
    const parts = [`已經把權限改回「${roleLabel(role)}」。`]
    if (notifyRemoved) parts.push('觀察者不收 LINE 通知，也順手把他從通知名單拿掉了。')
    // 改成觀察者那一次可能把他移出了通知名單，這裡不會自動加回去（要不要收是他自己勾的）
    if (row.after?.role === 'viewer') parts.push('他之前如果有收 LINE 通知，要收的話請到「設定 → LINE 通知」勾回來。')
    return { message: parts.join(''), ...swap(row) }
  },
}

// ── 知識的開關與有效期限 ─────────────────────────────────────────

const CARD_STATES = ['indexed', 'disabled']

const knowledgeSettings: RevertHandler = {
  plan(row) {
    const base = planFields(row, {
      allowed: ['cardStatus', 'activeUntil'],
      capability: 'knowledge.write',
      what: '把這條知識的開關和有效期限改回原本的樣子',
      page: '「知識庫」頁',
      refuse: '這筆動到的知識設定目前不支援一鍵還原，請到「知識庫」頁改回來。',
    })
    if (!base.ok) return base
    // 還沒學好／學失敗的不是「開關」能決定的狀態，寫回去會變成畫面說可用、AI 卻用不到
    if (!CARD_STATES.includes(String(row.before?.cardStatus)) || !CARD_STATES.includes(String(row.after?.cardStatus)))
      return { ok: false, reason: '這條知識當時不是「可用」或「停用」，沒辦法一鍵還原——請到「知識庫」頁確認。' }
    return base
  },
  async apply(row, ctx) {
    const { db, workspaceId } = ctx
    const ref = db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(String(row.targetId))
    const snap = await ref.get()
    const chunk = snap.data() as Rec | undefined
    if (!snap.exists || chunk?.workspaceId !== workspaceId) throw goneError('那條知識')
    // 規則照 POST /api/ai/knowledge/:chunkId/settings：回收桶的卡不能開關（會讓刪掉的卡復活上線）
    if (chunk.deletedAt != null)
      throw createError({ statusCode: 400, statusMessage: '這條知識在回收桶裡，請先還原再操作。' })
    const now = { cardStatus: String(chunk.status ?? ''), activeUntil: auditTimeText(chunk.activeUntil) }
    if (!stillAsRecorded(now, row.after)) throw changedSinceError('這條知識')

    const status = String(row.before?.cardStatus)
    const until = row.before?.activeUntil
    const update: Rec = {
      status,
      activeUntil: typeof until === 'string' && until ? Timestamp.fromDate(new Date(until)) : FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    }
    if (status === 'indexed') {
      // ⛔ 沒有向量的卡不能標可用：畫面顯示可用、AI 卻永遠撈不到（同 settings 那支的守門）
      if (!chunk.embedding)
        throw createError({ statusCode: 400, statusMessage: '這條知識 AI 還沒學會，請先在「知識庫」按「再試一次」。' })
      update.expiredAt = FieldValue.delete()
    }
    if (isRehearsal(ctx)) return REHEARSED
    await ref.update(update)
    return { message: '已經把這條知識的開關和期限改回原本的樣子。', ...swap(row) }
  },
}

// ── 推播排程：取消排程改回草稿，或改回原本的送出時間 ───────────────

/** 離送出不到這麼久就不給還原：排程器每分鐘挑「時間到了」的那幾則，留兩分鐘就不會跟它搶 */
const SCHEDULE_REVERT_MARGIN_MS = 2 * 60 * 1000

const broadcastSchedule: RevertHandler = {
  plan(row) {
    const was = row.before?.status
    if (!row.targetId || row.after?.status !== 'scheduled' || typeof row.after?.scheduleAt !== 'string')
      return { ok: false, reason: '這筆沒記到排了哪一則、排在什麼時候，還原不了——請到「推播」頁確認。' }
    if (was === 'draft')
      return { ok: true, capability: 'broadcast.send', what: '取消這個排程、改回草稿（不會送出）' }
    if (was === 'scheduled' && typeof row.before?.scheduleAt === 'string')
      return { ok: true, capability: 'broadcast.send', what: `把送出時間改回 ${auditTimeLabel(row.before.scheduleAt)}` }
    return { ok: false, reason: '這筆排程之前的狀態認不得，還原不了——請到「推播」頁確認。' }
  },
  async apply(row, ctx) {
    const { db, workspaceId } = ctx
    const toDraft = row.before?.status === 'draft'
    let back: Date | null = null
    if (!toDraft) {
      try { back = assertFutureBroadcastScheduleAt(row.before?.scheduleAt) }
      catch { throw createError({ statusCode: 409, statusMessage: '原本排的時間已經過了，改不回去——請到「推播」頁重新排。' }) }
    }

    const ref = db.collection('broadcasts').doc(String(row.targetId))
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      const b = snap.data()
      if (!snap.exists || b?.workspaceId !== workspaceId) throw goneError('那則推播')
      if (b.status === 'processing' || b.status === 'completed')
        throw createError({ statusCode: 409, statusMessage: '這則推播已經開始送或送完了，收不回來。' })
      if (b.status !== 'scheduled' || auditTimeText(b.scheduleAt) !== row.after?.scheduleAt) throw changedSinceError('這則推播')
      const atMs = (b.scheduleAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0
      if (atMs - Date.now() < SCHEDULE_REVERT_MARGIN_MS)
        throw createError({ statusCode: 409, statusMessage: '這則推播兩分鐘內就要送出了，來不及還原——要停下來請到「推播」頁按取消。' })
      if (isRehearsal(ctx)) return
      // 改回草稿的寫法同「重設回草稿」（retry）：scheduleAt 清成 null
      tx.update(ref, toDraft
        ? { status: 'draft', scheduleAt: null, updatedAt: FieldValue.serverTimestamp() }
        : { scheduleAt: back, updatedAt: FieldValue.serverTimestamp() })
    })
    if (isRehearsal(ctx)) return REHEARSED
    return {
      message: toDraft ? '已經取消排程，這則推播改回草稿，不會送出。' : `已經把送出時間改回 ${auditTimeLabel(String(row.before?.scheduleAt))}。`,
      ...swap(row),
    }
  },
}

// ── 「設定 → LINE 通知」：某位成員收哪幾種 ────────────────────────

const KIND_BY_LABEL = Object.fromEntries(NOTIFY_KINDS.map(k => [NOTIFY_KIND_LABELS[k], k])) as Record<string, NotifyKind>
/** LINE 的使用者編號（U＋32 位）：名單上不是成員的舊帳號那一種，targetId 記的是它 */
const LINE_USER_ID_RE = /^U[0-9a-f]{32}$/i

function kindsFromLabels(v: unknown): NotifyKind[] | null {
  if (!Array.isArray(v)) return null
  const kinds = v.map(l => KIND_BY_LABEL[String(l)])
  return kinds.every(Boolean) ? kinds as NotifyKind[] : null
}

function notifyFailure(r: { ok: false, reason: string } | { ok: true, result: string }): Error | null {
  if (!r.ok) {
    return createError({
      statusCode: 400,
      statusMessage: r.reason === 'viewer'
        ? '他現在是觀察者，觀察者不收 LINE 通知——要收的話先到「成員管理」把角色改成客服。'
        : '這位成員已經沒綁 LINE（或不在這個帳號了），改不回去。',
    })
  }
  if (r.result === 'full') return createError({ statusCode: 409, statusMessage: '通知名單滿了（最多 10 位），先到「設定 → LINE 通知」取消一位再還原。' })
  if (r.result === 'failed') return createError({ statusCode: 500, statusMessage: '存不進去，請再試一次。' })
  return null
}

const lineNotifyReceiving: RevertHandler = {
  plan(row) {
    if (row.targetId && LINE_USER_ID_RE.test(row.targetId))
      return { ok: false, reason: '這筆是拿掉名單上一個不是成員的 LINE 帳號；名單現在只收綁好的成員，沒辦法加回去。' }
    const base = planFields(row, {
      allowed: ['notifyKinds', 'receiving'],
      capability: 'notify.manage',
      what: '把這位成員收哪幾種 LINE 通知改回原本的樣子',
      page: '「設定 → LINE 通知」',
      refuse: '這筆動到的通知設定目前不支援一鍵還原，請到「設定 → LINE 通知」改回來。',
    })
    if (!base.ok) return base
    if ('notifyKinds' in (row.before ?? {}) && (!kindsFromLabels(row.before?.notifyKinds) || !kindsFromLabels(row.after?.notifyKinds)))
      return { ok: false, reason: '這筆記到的通知種類認不得，還原不了——請到「設定 → LINE 通知」改回來。' }
    return base
  },
  async apply(row, ctx) {
    const { workspaceId } = ctx
    const target = String(row.targetId)
    const now = await memberNotifyKindsNow(workspaceId, target)
    if (now === null)
      throw createError({ statusCode: 400, statusMessage: '這位成員已經沒綁 LINE（或不在這個帳號了），改不回去。' })

    if ('receiving' in (row.before ?? {})) {
      // 整列開關那一種（`C-270`）：在名單上＝收
      if ((now.length > 0) !== (row.after?.receiving === true)) throw changedSinceError('這位成員的 LINE 通知')
      if (isRehearsal(ctx)) return REHEARSED
      const fail = notifyFailure(await setMemberNotifyReceiving(workspaceId, target, row.before?.receiving === true))
      if (fail) throw fail
      return { message: '已經把他的 LINE 通知改回原本的樣子。', ...swap(row) }
    }

    const want = kindsFromLabels(row.before?.notifyKinds)!
    const was = kindsFromLabels(row.after?.notifyKinds)!
    if (now.length !== was.length || !was.every(k => now.includes(k))) throw changedSinceError('這位成員的 LINE 通知')
    if (isRehearsal(ctx)) return REHEARSED
    // ⛔ 先勾後取消：反過來的話中間那一刻三種都沒勾＝從名單拿掉，再勾回來可能剛好撞名單滿
    const toggles = NOTIFY_KINDS.filter(k => want.includes(k) !== now.includes(k))
      .sort((a, b) => Number(want.includes(b)) - Number(want.includes(a)))
    for (const k of toggles) {
      const fail = notifyFailure(await setMemberNotifyKind(workspaceId, target, k, want.includes(k)))
      if (fail) throw fail
    }
    return { message: '已經把他收的 LINE 通知改回原本的樣子。', ...swap(row) }
  },
}

// ── 加好友活動：改名、開關 ─────────────────────────────────────────

const campaignPut: RevertHandler = {
  plan: row => planFields(row, {
    allowed: ['name', 'isActive'],
    capability: 'marketing.write',
    what: '把這個活動的名稱／開關改回原本的樣子',
    page: '「加好友活動」頁',
    // 貼哪些標籤、觸發什麼動作：紀錄只記了「幾個」「哪一種」，寫不回去
    refuse: '這筆改了活動要貼的標籤或觸發的動作，紀錄只記了數量和種類，沒辦法一鍵還原——請到「加好友活動」頁改回來。',
  }),
  async apply(row, ctx) {
    const { db, workspaceId } = ctx
    const id = String(row.targetId)
    const ref = db.collection('leadCampaigns').doc(id)
    const snap = await ref.get()
    const d = snap.data() as Rec | undefined
    if (!snap.exists || d?.workspaceId !== workspaceId) throw goneError('那個活動')
    // 紀錄存的形狀照 PUT /api/campaigns/:id 的 summarize（isActive 沒寫＝開著）
    if (!stillAsRecorded({ name: String(d.name ?? ''), isActive: d.isActive !== false }, row.after)) throw changedSinceError('這個活動')

    const before = row.before ?? {}
    const write: Rec = {}
    if ('name' in before) {
      if (typeof before.name !== 'string' || !before.name.trim()) throw createError({ statusCode: 400, statusMessage: '這筆沒記到原本的名字，還原不了。' })
      write.name = before.name.trim()
    }
    if ('isActive' in before) write.isActive = before.isActive !== false
    if (isRehearsal(ctx)) return REHEARSED
    await ref.update({ ...write, updatedAt: FieldValue.serverTimestamp() })

    // ⛔ 開關一動，活動連結要跟著換（同 PUT /api/campaigns/:id）：只改 isActive 的話客人點舊連結還是進得去／撲空
    if ('isActive' in write) {
      const merged = { ...d, ...write }
      await syncPublishedEntryUrlForCampaign(db, id, {
        workspaceId,
        liffId: String(merged.liffId ?? ''),
        campaignCode: String(merged.campaignCode ?? ''),
        isActive: merged.isActive !== false,
        tagIds: merged.tagIds as string[] | undefined,
        moduleId: merged.moduleId as string | null | undefined,
        action: merged.action as never,
        redirectUrl: String(merged.redirectUrl ?? '') || null,
        publishedClaimId: (d.publishedClaimId as string | null | undefined) ?? null,
        publishedCtaUrl: (d.publishedCtaUrl as string | null | undefined) ?? null,
      })
    }
    return { message: '已經把這個活動改回原本的樣子。', ...swap(row) }
  },
}

/** 動作代號 → 怎麼還原（第一批：改一個值） */
export const FIELD_REVERT_HANDLERS: Record<string, RevertHandler> = {
  'flow.put': flowPut,
  'tag.put': tagPut,
  'source.put': sourcePut,
  'members/role.put': memberRole,
  'knowledge.settings': knowledgeSettings,
  'broadcast.schedule': broadcastSchedule,
  'lineNotify.receiving': lineNotifyReceiving,
  'campaign.put': campaignPut,
}
