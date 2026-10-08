/**
 * 成員名單的排序（`D-117`，2026-10-08）：「成員管理」「LINE 通知」兩頁同一個順序。
 *
 * 為什麼要有：成員管理原本完全沒排（照資料庫文件順序，擁有者排第 4），
 * LINE 通知照角色排但同角色之間沒排——同一群人在兩頁順序不一樣，對照著看要一個個找。
 *
 * 順序：自己（那一列有只給自己的按鈕）→ 擁有者 → 管理員 → 客服 → 觀察者 → 同角色照 Email。
 */
export const MEMBER_ROLE_ORDER: Record<string, number> = { owner: 0, admin: 1, agent: 2, viewer: 3 }

export interface MemberSortKey {
  isSelf?: boolean
  role?: string | null
  email?: string | null
}

export function compareMembersForList(a: MemberSortKey, b: MemberSortKey): number {
  if (Boolean(a.isSelf) !== Boolean(b.isSelf)) return a.isSelf ? -1 : 1
  const ra = MEMBER_ROLE_ORDER[String(a.role ?? '')] ?? 9
  const rb = MEMBER_ROLE_ORDER[String(b.role ?? '')] ?? 9
  if (ra !== rb) return ra - rb
  return String(a.email ?? '').toLowerCase().localeCompare(String(b.email ?? '').toLowerCase())
}
