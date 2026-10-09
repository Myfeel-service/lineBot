import { requireCapability } from '~~/server/utils/workspace-auth'
import { getDb } from '~~/server/utils/firebase'
import { memberDocId } from '~~/server/utils/member-line-bind'

/**
 * POST /api/admin/workspaces/:workspaceId/line-notify/invite-seen
 * 首頁「要傳到你的手機嗎？」卡片出現在他眼前了（`D-119` 拍板 B，2026-10-09）。
 *
 * 為什麼要記：MYFEEL 7 位成員只綁 2 位，沒綁的 Jordan／tomoko／alice 那週都還在用後台，
 * 卻沒有人按過「先不用」——**分不出是沒看到還是看到不理**。記下來之後「設定 → LINE 通知」
 * 那一列就講得出「看過邀請（10/7）」或「還沒看過邀請」，要不要多放一個地方才有根據。
 *
 * - 只記第一次與最近一次（⛔ 不是每看一次記一筆：這是看過沒，不是瀏覽紀錄）
 * - 個人狀態、不是設定 → 不寫操作紀錄（跟「先不用」同一類）
 * - 不是成員（組織管理員、超管）沒有成員文件，卡片本來就不出現；真的打進來就回 ok:false
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'notify.self')
  const db = getDb()
  const ref = db.collection('workspaceMembers').doc(memberDocId(uid, workspaceId))
  const now = Date.now()
  const ok = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) return false
    tx.update(ref, {
      ...(snap.data()?.lineNotifyInviteFirstSeenAt ? {} : { lineNotifyInviteFirstSeenAt: now }),
      lineNotifyInviteLastSeenAt: now,
    })
    return true
  })
  return { ok }
})
