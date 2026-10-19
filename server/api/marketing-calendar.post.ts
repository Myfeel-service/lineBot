import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { writeAuditLog } from '~~/server/utils/audit-log'
import {
  createMarketingEvent,
  deleteMarketingEvent,
  MarketingEventError,
  updateMarketingEvent,
} from '~~/server/utils/marketing-events'
import { isOwnEventId, validateEventInput } from '~~/shared/marketing-events'
import { can } from '~~/shared/permissions'
import { taipeiDate } from '~~/shared/time'

/**
 * POST /api/marketing-calendar   Body: `{ op, … }`
 *
 * 店家自己的檔期（`D-122`②）：加、改、刪。讀在 `GET /api/marketing-calendar`（跟節日一起回）。
 *
 * - `op: 'create'`  `{ name, date, broadcastId? }`
 *   兩個入口共用：首頁卡片「＋ 加自己的檔期」（名稱＋日期）、推播頁已排程的推播「設成檔期」
 *   （多帶 `broadcastId`，同一個交易把那則推播綁到這一檔）。⛔ 不從推播名稱猜，只收人親手按的。
 * - `op: 'update'`  `{ id, name, date }`：日期改了，早上的 LINE 提醒從新的日子重新算（`updateMarketingEvent`）。
 * - `op: 'delete'`  `{ id }`：⛔ 只刪檔期，不動推播——為這一檔建的推播照樣在推播頁。
 *
 * ⛔ 節日表上的節日改不了也刪不了（id 不是 `own-` 開頭一律 404）——那些用「這次不做」收起來。
 * ⚠️ 刻意掛在既有的 `/api/marketing-calendar` 底下、一支收三件事：多開一個路徑會讓不相干的 $fetch
 *   型別推導爆掉（TS2589，見記憶 reference_nuxt_typecheck_traps；2026-10-19 實測連一支新路徑都塞不下了）。
 */
export default defineEventHandler(async (event) => {
  const ctx = await requireCapability(event, 'marketing.write')
  const { workspaceId, uid } = ctx
  const db = getDb()
  const today = taipeiDate()
  const body = await readBody(event).catch(() => ({})) as {
    op?: unknown, id?: unknown, name?: unknown, date?: unknown, broadcastId?: unknown
  }
  const op = String(body?.op ?? '')

  // 寫入時的錯誤訊息直接給人看
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    }
    catch (e) {
      if (e instanceof MarketingEventError) throw createError({ statusCode: e.statusCode, statusMessage: e.message })
      throw e
    }
  }
  const ownIdOrThrow = () => {
    const id = String(body?.id ?? '')
    if (!isOwnEventId(id)) throw createError({ statusCode: 404, statusMessage: '找不到這個檔期' })
    return id
  }

  if (op === 'delete') {
    const id = ownIdOrThrow()
    const removed = await run(() => deleteMarketingEvent(db, workspaceId, id, today))
    await writeAuditLog({
      workspaceId,
      uid,
      actor: 'human',
      action: 'marketingEvent.delete',
      targetId: id,
      before: { name: removed.name, date: removed.date },
      note: removed.name,
    }, db)
    return { success: true }
  }

  if (op !== 'create' && op !== 'update') throw createError({ statusCode: 400, statusMessage: 'op 不合法' })
  const v = validateEventInput(body ?? {}, today)
  if (!v.ok) throw createError({ statusCode: 400, statusMessage: v.message })

  if (op === 'update') {
    const id = ownIdOrThrow()
    const { before, after } = await run(() => updateMarketingEvent(db, workspaceId, id, { name: v.name, date: v.date }, today))
    const changed = (['name', 'date'] as const).filter(k => before[k] !== after[k])
    if (changed.length) {
      await writeAuditLog({
        workspaceId,
        uid,
        actor: 'human',
        action: 'marketingEvent.put',
        targetId: id,
        before: Object.fromEntries(changed.map(k => [k, before[k]])),
        after: Object.fromEntries(changed.map(k => [k, after[k]])),
        note: after.name,
      }, db)
    }
    return { event: after }
  }

  // create
  const broadcastId = typeof body?.broadcastId === 'string' ? body.broadcastId.trim() : ''
  // 「設成檔期」會改到推播（綁上這一檔），要能建推播草稿的人才可以
  if (broadcastId && !ctx.isSuperAdmin && !can(ctx.role, 'broadcast.write')) {
    throw createError({ statusCode: 403, statusMessage: '你的角色不能改推播' })
  }
  const created = await run(() => createMarketingEvent(db, workspaceId, {
    name: v.name,
    date: v.date,
    ...(broadcastId ? { broadcastId } : {}),
  }, today))
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'marketingEvent.create',
    targetId: created.id,
    after: { name: created.name, date: created.date, ...(broadcastId ? { broadcastId } : {}) },
    note: created.name,
  }, db)
  return { event: created }
})
