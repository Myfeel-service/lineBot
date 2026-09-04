import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import { addTagsToUser } from './tagging'
import { recordTagSuggestionEvents } from './tag-suggestion-log'
import { AI_TAG_SUGGEST_SOURCE_REF } from './ai-tag-suggest'
import type { UserTagSuggestionDoc } from '~~/shared/types/tag-broadcast'

/**
 * 「採用／忽略一條 AI 貼標建議」的唯一寫入點（`D-61` 抽出來的）。
 *
 * 為什麼要抽：這件事現在有兩個入口——客人單頁一位一位按（`users/[id]/tag-suggestions`）、
 * 標籤頁一次審一整顆（`tag/[id]/pending`）。兩邊各寫一份的話，
 * 「忽略要記進永不再提」「採用要記底帳」「只動還在待審的那幾條」這三條規則遲早只改到一邊，
 * 而成效底帳算錯是**事後補不回來**的（見 tag-suggestion-log.ts 檔頭）。
 */

export type ReviewOutcome =
  /** 真的處理掉了 */
  | 'done'
  /** 這位客人根本沒有收件匣文件（或不是這個工作區的） */
  | 'not_found'
  /** 文件在、但這幾顆已經不在待審裡了（兩個人同時開著同一位，後按的那位） */
  | 'already_handled'

export async function reviewSuggestions(
  db: Firestore,
  opts: {
    workspaceId: string
    /** users 主鍵：`${workspaceId}_${lineUserId}` */
    userDocId: string
    tagIds: string[]
    action: 'apply' | 'dismiss'
    /** 按下去的人；排程／系統寫的一律 null */
    operatorId?: string | null
  },
): Promise<{ outcome: ReviewOutcome, processed: string[] }> {
  const { workspaceId, userDocId, tagIds, action } = opts
  const sugRef = db.collection('userTagSuggestions').doc(userDocId)
  const sugSnap = await sugRef.get()
  const sugDoc = sugSnap.data() as UserTagSuggestionDoc | undefined
  if (!sugSnap.exists || sugDoc?.workspaceId !== workspaceId) {
    return { outcome: 'not_found', processed: [] }
  }

  const pending = Array.isArray(sugDoc.pending) ? sugDoc.pending : []
  // ⛔ 只動「還在待審裡」的：兩個客服同時開著同一位時，後按的那位不該重複貼標
  const target = tagIds.filter(id => pending.some(p => p.tagId === id))
  if (!target.length) return { outcome: 'already_handled', processed: [] }

  if (action === 'apply') {
    await addTagsToUser(userDocId, target, 'ai', AI_TAG_SUGGEST_SOURCE_REF, workspaceId)
  }

  /**
   * 成效底帳（`D-42`）：**採用率的分子與分母都在這裡產生**，忽略尤其重要——
   * 忽略只會寫進 `dismissedTagIds`（沒有時間、又跟手動移除混在一起），
   * 不記在這裡就永遠算不出「這顆標籤 AI 判得準不準」。
   * ⛔ 記的是 target（真的還在待審、這次被處理掉的），不是呼叫端送來的 tagIds。
   */
  await recordTagSuggestionEvents(
    db, workspaceId,
    action === 'apply' ? 'applied' : 'dismissed',
    userDocId, target, { operatorId: opts.operatorId ?? null },
  )

  const dismissedTagIds = Array.isArray(sugDoc.dismissedTagIds) ? sugDoc.dismissedTagIds : []
  const remaining = pending.filter(p => !target.includes(p.tagId))
  await sugRef.set({
    pending: remaining,
    hasPending: remaining.length > 0, // pending 的鏡像（列表等值查詢用）
    dismissedTagIds: action === 'dismiss'
      ? [...new Set([...dismissedTagIds, ...target])]
      : dismissedTagIds,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true })

  return { outcome: 'done', processed: target }
}
