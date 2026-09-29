import { getDoc } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import type { BroadcastDoc } from '~~/shared/types/tag-broadcast'
import { can } from '~~/shared/permissions'

/**
 * GET /api/broadcast/:id
 * 取得推播詳情（含 messages 快照，供後台還原訊息內容）
 *
 * Query:
 * - withAudienceIds=1：一併回傳 audienceSnapshot.resolvedUserIds（可能很大，僅除錯／稽核用）
 *   **只給管理員**（`D-111` 2026-09-29 拍板，門檻跟操作紀錄 `audit.read` 一樣）：那是這則推播的完整收件名單
 *   （每位客人的 LINE id），原本觀察者帶這個參數就拿得到。前端沒有任何地方帶它；其他角色帶了
 *   照樣回一般內容（⛔ 不回 403：推播詳情本身他看得到，只是不給名單）。
 *
 * 預設會省略 resolvedUserIds，避免單次回應過大。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, role } = await requireCapability(event, 'workspace.read')

  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id is required' })

  const query = getQuery(event)
  const withAudienceIds = (query.withAudienceIds === '1' || query.withAudienceIds === 'true') && can(role, 'audit.read')

  const doc = await getDoc<BroadcastDoc>('broadcasts', id)
  if (!doc || doc.workspaceId !== workspaceId) throw createError({ statusCode: 404, statusMessage: 'Broadcast not found' })

  if (withAudienceIds) return doc

  const snap = doc.audienceSnapshot
  return {
    ...doc,
    audienceSnapshot: {
      filter: snap?.filter ?? null,
      estimatedCount: snap?.estimatedCount ?? 0,
      resolvedUserIds: [],
    },
  }
})
