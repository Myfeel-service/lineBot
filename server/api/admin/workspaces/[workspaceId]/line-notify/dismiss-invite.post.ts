import { requireCapability } from '~~/server/utils/workspace-auth'
import { getDb } from '~~/server/utils/firebase'
import { memberDocId } from '~~/server/utils/member-line-bind'

/**
 * POST /api/admin/workspaces/:workspaceId/line-notify/dismiss-invite
 * 首頁那張「客人要找真人時，要傳到你的手機嗎？」按了「先不用」（`D-103`⑧）：只問一次，之後不再出現。
 * 記在這位成員在這個帳號的成員文件上（同一個人在另一個帳號還是會被問一次）。
 * 這是個人偏好、不是設定，不寫操作紀錄（跟「導覽看過了」同一類）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'notify.self')
  const ref = getDb().collection('workspaceMembers').doc(memberDocId(uid, workspaceId))
  const snap = await ref.get()
  if (!snap.exists) return { ok: false }
  await ref.update({ lineNotifyInviteDismissedAt: Date.now() })
  return { ok: true }
})
