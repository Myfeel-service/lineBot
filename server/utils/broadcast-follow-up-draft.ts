import { v4 as uuidv4 } from 'uuid'
import { writeAuditLog } from './audit-log'
import { newBroadcastDraftDoc } from './broadcast-draft'
import { fetchBroadcastLineInsight } from './broadcast-line-insight'
import { parseStoredLineStats } from '~~/shared/broadcast-line-stats'
import { parseFirestoreDate } from '~~/shared/firestore-date'
import { FOLLOW_UP_LABEL, followUpAvailability, followUpDraftName } from '~~/shared/broadcast-follow-up'
import type { BroadcastDoc, BroadcastFollowUpTarget } from '~~/shared/types/tag-broadcast'

/**
 * 成效報表「補發給沒打開的人／發給點了連結的人／發給沒點連結的人」（`D-154`②③）：
 * 把原本那則複製成一則**草稿**（⛔ 不送），對象是「LINE 依那則挑的那群人」。
 * 他可以先改標題、試發，再走一般的「驗證並發送／排程」——跟複製一則同一條路。
 *
 * ⚠️ 掛在 `POST /api/broadcast/:id/duplicate`（帶 `followUpTarget`），⛔ 不另開一支路由：
 *    多一支路由就讓不相干的 `$fetch` 型別推導爆掉（TS2589，記憶 reference_nuxt_typecheck_traps）。
 * 能不能建、各約幾位，跟報表用**同一支**判斷（`followUpAvailability`）。
 */
export async function createFollowUpDraft(args: {
  db: FirebaseFirestore.Firestore
  uid: string
  workspaceId: string
  sourceId: string
  src: BroadcastDoc
  target: BroadcastFollowUpTarget
}): Promise<{ id: string; doc: BroadcastDoc }> {
  const { db, uid, workspaceId, sourceId, src, target } = args
  const messages = Array.isArray(src.messages) ? src.messages : []
  if (!messages.length) throw createError({ statusCode: 400, statusMessage: '這則推播沒有內容，沒辦法補發' })

  // 人數：先用存下來的那一份，還沒存（發完不到一天）才現場問 LINE（跟報表同一個口徑）
  const completedAt = parseFirestoreDate(src.completedAt)
  const stored = parseStoredLineStats(src.lineStats)
  let opened = stored?.opened ?? null
  let clicked = stored?.clicked ?? null
  if (opened == null && clicked == null && src.lineRequestId) {
    const live = await fetchBroadcastLineInsight(sourceId, workspaceId, null, parseFirestoreDate(src.startedAt), completedAt, src.lineRequestId)
    opened = live.lineUniqueImpression
    clicked = live.lineUniqueClick
  }
  const availability = followUpAvailability({
    status: src.status,
    sendMode: src.sendMode ?? null,
    isFollowUp: src.audienceSource?.type === 'followUp',
    lineRequestId: src.lineRequestId ?? null,
    uploadAudienceGroupId: src.narrowcast?.uploadAudienceGroupId ?? null,
    narrowcastFallback: src.narrowcastFallback ?? null,
    completedMs: completedAt?.getTime() ?? null,
    sentCount: Number(src.sentCount) || 0,
    opened,
    clicked,
    nowMs: Date.now(),
  })
  const option = availability.options.find(o => o.target === target)
  if (!option) {
    throw createError({ statusCode: 409, statusMessage: availability.reason || `現在沒辦法發給${FOLLOW_UP_LABEL[target]}` })
  }

  const id = uuidv4()
  const doc = newBroadcastDraftDoc({
    workspaceId,
    uid,
    name: followUpDraftName(String(src.name ?? ''), target),
    audienceSource: {
      type: 'followUp',
      sourceBroadcastId: sourceId,
      followUpTarget: target,
      sourceName: String(src.name ?? '').trim(),
    },
    messages,
    // ⛔ 不帶「發完貼記號」：LINE 只回人數、不回是誰，貼不了（narrowcast 的限制）
    completionTagIds: [],
  })
  // 列表「N 人」與驗證視窗的預估人數用這個（真正送到幾位要等 LINE 回報）
  doc.audienceSnapshot.estimatedCount = option.estimate
  await db.collection('broadcasts').doc(id).set(doc)

  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'broadcast.followUp',
    targetId: id,
    after: { name: doc.name, copiedFromId: sourceId, followUpLabel: FOLLOW_UP_LABEL[target], estimatedCount: option.estimate },
    note: String(src.name ?? ''),
  }, db)

  return { id, doc }
}
