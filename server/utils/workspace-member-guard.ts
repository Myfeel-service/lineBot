import type { WorkspaceMemberRole } from '~~/shared/types/organization'

/** 管得動這個帳號的角色（成員、LINE 金鑰、帳單都要它） */
const MANAGER_ROLES: ReadonlySet<string> = new Set<WorkspaceMemberRole>(['admin', 'owner'])

/**
 * 這次改角色／移除之後，帳號裡還剩不剩「管理員或擁有者」（`G-101`②）。純函式，給兩支成員端點共用。
 *
 * 為什麼要有：組織層早就擋「不能移除最後一位管理員」，帳號層沒有——剩兩位管理員互相降級、
 * 或唯一的管理員被改成客服，帳號就沒人能再邀人、改設定，只能找超管救。
 * （正常帳號都有一位擁有者，擁有者改不掉、移不掉，所以實際會中的是**沒有擁有者那一列的舊帳號**。）
 *
 * - `members`：這個帳號**全部**的 workspaceMembers（呼叫端要在 transaction 裡讀，人數檢查才成立）
 * - `nextRole`：改成什麼；`null`＝移除
 * - 動的人本來就不是管理員／擁有者 → 不會少，回 false
 */
export function wouldLeaveNoManager(
  members: ReadonlyArray<{ id: string, role: unknown }>,
  targetDocId: string,
  nextRole: WorkspaceMemberRole | null,
): boolean {
  const target = members.find(m => m.id === targetDocId)
  if (!target || !MANAGER_ROLES.has(String(target.role))) return false
  if (nextRole && MANAGER_ROLES.has(nextRole)) return false
  return !members.some(m => m.id !== targetDocId && MANAGER_ROLES.has(String(m.role)))
}
