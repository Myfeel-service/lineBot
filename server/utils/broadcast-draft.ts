import { FieldValue } from 'firebase-admin/firestore'
import type { BroadcastAudienceSource, BroadcastDoc } from '~~/shared/types/tag-broadcast'

/**
 * 一則全新推播草稿的文件（`/api/broadcast/create` 與 `/api/broadcast/:id/duplicate` 共用）。
 *
 * ⛔ 複製也一定要走這支：排程、受眾快照、發送結果一律從零開始。
 *    兩支各自組一份的話，以後替草稿加一個欄位，就會一條路有、一條路沒有。
 */
export function newBroadcastDraftDoc(input: {
  workspaceId: string
  uid: string
  name: string
  audienceSource: BroadcastAudienceSource
  messages: unknown[]
  completionTagIds: string[]
  festivalId?: string
}): BroadcastDoc {
  const now = FieldValue.serverTimestamp()
  return {
    workspaceId: input.workspaceId,
    name: input.name,
    status: 'draft',
    channel: 'line',
    audienceSource: input.audienceSource,
    audienceSnapshot: {
      filter: null,
      resolvedUserIds: [],
      estimatedCount: 0,
    },
    messages: input.messages,
    completionTagIds: input.completionTagIds,
    ...(input.festivalId ? { festivalId: input.festivalId } : {}),
    scheduleAt: null,
    startedAt: null,
    completedAt: null,
    totalCount: 0,
    sentCount: 0,
    failedCount: 0,
    skippedCount: 0,
    createdBy: input.uid,
    createdAt: now,
    updatedAt: now,
  }
}
