import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { ASSIGNABLE_MEMBER_ROLES, changeWorkspaceMemberRole } from '~~/server/utils/workspace-member-role'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * PUT /api/admin/workspaces/:workspaceId/members/:uid
 * 更改成員角色。需 admin 以上角色。
 * 擁有者的角色**只有組織管理員與超管**能改（`G-96` 2026-09-29 拍板）：原本誰都改不掉、錯誤訊息
 * 叫人去「轉移所有權」，全站卻沒有這個功能——離職的擁有者只能到 Firestore 主控台手動刪。
 * 帳號管理員照樣動不了擁有者。⛔ 誰都不能把人**改成**擁有者（ASSIGNABLE_MEMBER_ROLES 沒有 owner）。
 *
 * 護欄（`G-101`②，比照組織層的移除管理員）：
 *   ① **不能改自己**——手滑把自己改成觀察者會立刻被踢出設定頁，而且沒有權限再改回來
 *   ② **不能讓帳號變成零管理員**——人數檢查跟寫入在同一個 transaction 裡，
 *      否則剩兩位管理員互相降級同時發生時，兩邊都讀到「還有另一位」、都通過
 * 降成觀察者時順手從 LINE 通知名單拿掉（`G-101`④）：觀察者不收通知（`C-271`⑬）。
 * ②與通知名單那段在 `changeWorkspaceMemberRole`（操作紀錄的「還原」也走同一支，`D-156`）。
 *
 * Body: { role: 'admin' | 'agent' | 'viewer' }
 */
export default defineEventHandler(async (event) => {
  // withOrgAdmin：要靠 isOrgAdmin 判斷能不能動擁有者，沒帶的話直接管理員那條路不會去查組織身分
  const { workspaceId, uid, isSuperAdmin, isOrgAdmin } = await requireCapability(event, 'members.manage', { withOrgAdmin: true })
  const canTouchOwner = isOrgAdmin || isSuperAdmin

  const targetUid = event.context.params?.uid
  if (!targetUid) throw createError({ statusCode: 400, statusMessage: 'uid is required' })

  const body = await readBody(event)
  const { role } = body

  if (!ASSIGNABLE_MEMBER_ROLES.includes(role)) {
    throw createError({ statusCode: 400, statusMessage: `role must be one of: ${ASSIGNABLE_MEMBER_ROLES.join(', ')}` })
  }

  // 超管不受「不能改自己」限制：他的權限不是靠這筆成員文件來的，改了也不會把自己鎖在門外
  if (targetUid === uid && !isSuperAdmin) {
    throw createError({ statusCode: 400, statusMessage: '不能改自己的角色。請由其他管理員操作' })
  }

  const db = getDb()
  const { before, notifyRemoved } = await changeWorkspaceMemberRole(db, { workspaceId, targetUid, role, canTouchOwner })

  // 誰把誰改成什麼權限，是出事時第一個要查的東西
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'members/role.put',
    targetId: targetUid,
    before: { role: before },
    after: { role },
    ...(notifyRemoved ? { note: '改成觀察者，順手把他從 LINE 通知名單移掉了' } : {}),
  })

  return { id: `${targetUid}_${workspaceId}`, uid: targetUid, workspaceId, role }
})
