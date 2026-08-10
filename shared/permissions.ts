import type { WorkspaceMemberRole } from './types/organization'

// ═══════════════════════════════════════════════════════════════════
//  權限單一事實來源（Single Source of Truth）
//
//  前端（選單顯示 / 按鈕顯隱）與後端（API 門檻）都讀這一份，避免三處各自
//  漂移而產生「看得到卻 403」。要調整某功能的最低角色，只改這裡。
//
//  政策（2026-07 拍板）：
//    - 內容維護（知識庫、來源、資料夾、客服腳本）＝ agent 可做，讓客服自行維護
//    - 設定類（AI 設定、全量重建、成員、LINE 憑證）＝ admin
//    - 無權限的 UI 一律「直接隱藏」，不做 disable
// ═══════════════════════════════════════════════════════════════════

/** 角色權限層級：owner > admin > agent > viewer（數字越大權限越高） */
export const ROLE_LEVEL: Record<WorkspaceMemberRole, number> = {
  viewer: 1,
  agent: 2,
  admin: 3,
  owner: 4,
}

/** role 是否達到 minRole 的門檻 */
export function hasMinRole(role: WorkspaceMemberRole, minRole: WorkspaceMemberRole): boolean {
  return ROLE_LEVEL[role] >= ROLE_LEVEL[minRole]
}

/**
 * 能力 → 最低角色 對照表。
 * key 為能力代號，供前端 can()、後端 requireCapability() 共用。
 */
export const CAPABILITIES = {
  // ── 讀取（所有內部成員 viewer+）─────────────────────────────
  'ai.read': 'viewer', // 知識庫/來源/資料夾列表、AI 設定讀取、AI 表現頁
  'members.read': 'viewer', // 成員列表

  // ── 內容維護（客服 agent+）──────────────────────────────────
  'knowledge.write': 'agent', // 知識卡 新增/編輯/刪除/批量/單卡重建/預覽/正規化
  'sources.write': 'agent', // 知識來源 編輯/刪除/同步/重同步/搬移孤兒
  'folders.write': 'agent', // 資料夾 新增/編輯/刪除/排序
  'scripts.write': 'agent', // 客服腳本 新增/編輯/刪除
  'playground.use': 'agent', // 測試對話

  // ── 設定類（管理員 admin+）──────────────────────────────────
  'ai.settings.write': 'admin', // AI 設定儲存
  'usage.read': 'admin', // 計費資訊（方案、額度、超量單價）——2026-08-10 起不再擋整頁，改由 API 逐欄位擋
  'knowledge.reindexAll': 'admin', // 知識庫全量重建
  'members.manage': 'admin', // 成員 邀請/改角色/移除
  'line.manage': 'admin', // 組織與 LINE 憑證 讀取/儲存
} as const satisfies Record<string, WorkspaceMemberRole>

export type Capability = keyof typeof CAPABILITIES

/** 某角色是否具備某能力（role 為 null 視為未登入/無成員資格） */
export function can(role: WorkspaceMemberRole | null | undefined, capability: Capability): boolean {
  if (!role) return false
  return hasMinRole(role, CAPABILITIES[capability])
}
