import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { confirmPhoneFollower, phoneTestSince } from '~~/server/utils/onboarding-phone-test'
import { addToHandoffNotify, bindMemberLineUser, type AddToNotifyResult } from '~~/server/utils/member-line-bind'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * POST /api/admin/onboarding/bind-self  body: { lineUserId, lookbackMs }（往回看多久；舊分頁送的 since 仍收）
 *
 * 開帳「用手機測試」按了「是我」（`C-250`③）：
 *   ① 伺服器**再驗一次**這個人真的是這段時間內新加好友／剛傳訊息的（⛔ 不信任前端給的 id）
 *   ② 把這支 LINE 綁到按的人身上（跟「成員管理」的綁定碼同一套規則：同一個 LINE 不掛兩位成員）
 *   ③ **加進通知名單**——客人要找你本人、每天早上的摘要，才真的會傳到這支手機
 *      （原本綁定不會加，綁定成功的回覆還叫他自己去加）。⛔ 只有真的綁到成員身上才加（`G-107`⑪）
 *   ④ 這一下算「收到第一則」（加好友原本不算）
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireWorkspaceAccess(event, 'admin')
  const body = await readBody<{ lineUserId?: unknown, lookbackMs?: unknown, since?: unknown }>(event)
  const lineUserId = String(body?.lineUserId ?? '').trim()
  if (!/^U[0-9a-f]{32}$/i.test(lineUserId)) throw createError({ statusCode: 400, statusMessage: '這不是一個 LINE 帳號' })
  const db = getDb()

  const who = await confirmPhoneFollower(workspaceId, lineUserId, phoneTestSince(body ?? {}), db)
  if (!who) {
    // ⛔ 講得出為什麼、下一步是什麼（不是一句「失敗」）
    throw createError({ statusCode: 409, statusMessage: '這個 LINE 帳號不是剛剛加好友的那一位——再用手機加一次好友、或傳一句話試試' })
  }

  const memberBound = await bindMemberLineUser(workspaceId, uid, who).catch((e) => {
    console.error('[bind-self] 綁成員失敗：', e)
    // ⛔ 綁不上就不要當成沒事往下走（原本吞掉後照樣加進名單）；講得出下一步，前端會繼續等他再傳一句
    throw createError({ statusCode: 500, statusMessage: '這支手機沒有綁成功——用手機再傳一句話給官方帳號試一次' })
  })
  /*
   * `D-103`「名單只收綁好的成員」（`G-107`⑪）：沒有成員文件的人（組織管理員、超管）綁不了，
   * 原本照樣加進名單＝名單上多一支對不上任何成員的手機，成員頁拿不掉、改角色也管不到它。
   * 現在不加，回 `not-member` 讓畫面照實講「沒加進去」。
   */
  const notify: AddToNotifyResult | 'not-member' = memberBound
    ? await addToHandoffNotify(workspaceId, who.lineUserId, who.displayName)
    : 'not-member'

  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'member.lineBindSelf',
    targetId: who.lineUserId,
    after: { lineDisplayName: who.displayName, via: who.via, memberBound, notify },
  }, db)

  return { ...who, memberBound, notify }
})
