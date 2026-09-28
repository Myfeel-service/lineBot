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
  // 成員列表（含每位成員的 LINE id、邀請人）。2026-09-29 `D-111` 拍板從 viewer 收到 admin：
  // 唯一用到它的「成員管理」頁本來就只給管理員進，觀察者打 API 卻拿得到。
  'members.read': 'admin',

  // ── 內容維護（客服 agent+）──────────────────────────────────
  'knowledge.write': 'agent', // 知識卡 新增/編輯/刪除/批量/單卡重建/預覽/正規化
  'sources.write': 'agent', // 知識來源 編輯/刪除/同步/重同步/搬移孤兒
  'folders.write': 'agent', // 資料夾 新增/編輯/刪除/排序
  'scripts.write': 'agent', // 客服腳本 新增/編輯/刪除
  'playground.use': 'agent', // 測試對話
  // 2026-09-16：推播頁的端點本來就是 agent 級，但能力表一直沒有這一項——
  // 小幫手要掛「建推播草稿」時才發現門檻只存在於端點裡。⛔發送不在這裡（紅線，永遠留人按）。
  'broadcast.write': 'agent', // 建立／編輯推播**草稿**
  // 2026-09-29 `G-106`：以下幾項是全站權限盤點時補的——這些功能的端點一直各自寫死 'agent'，
  // 表裡卻沒有它們，前端也只能用 canOperate 猜。門檻照現況（`D-110` 拍板：客服照樣能發推播、
  // 換圖文選單、刪使用中的東西），補進來是為了讓前後端讀同一份，不是改規則。
  'broadcast.send': 'agent', // 正式發送／排程／取消／重發（⛔ 仍是「永遠留人按」的紅線，小幫手不代按）
  'conversations.reply': 'agent', // 回覆客人、送客服預存、接手／交還／結束、釘選／待跟進、指派、標答錯
  'customers.write': 'agent', // 幫客人貼標／拆標、客人備註、採用 AI 標籤建議、從 LINE 同步好友
  'tags.write': 'agent', // 標籤 新增／編輯／停用、AI 發現的採用／合併／忽略
  'presets.write': 'agent', // 客服預存 新增／編輯／刪除
  'marketing.write': 'agent', // 機器人模組、活動、圖文選單、圖文訊息、行銷月曆
  // 2026-09-27 `D-103` 第 3 題拍板：客服可以把**自己的**手機加進 LINE 通知、自己退出
  // （「設定 → LINE 通知」那一頁與首頁那張卡）。⛔ 只能動自己那一列；動別人、改「什麼時候通知」是 notify.manage。
  // 觀察者不收：他不處理客人，找真人的通知對他沒有下一步。
  'notify.self': 'agent',

  // ── 設定類（管理員 admin+）──────────────────────────────────
  'ai.settings.write': 'admin', // AI 設定儲存
  'usage.read': 'admin', // 計費資訊（方案、額度、超量單價）——2026-08-10 起不再擋整頁，改由 API 逐欄位擋
  // 操作紀錄（誰把什麼改成什麼，含小幫手代辦的每一筆）。放 admin 的理由：
  // 紀錄裡看得到設定的前後值與是誰動的，等級比照「能改設定的人才看得到改了什麼」。
  'audit.read': 'admin',
  'knowledge.reindexAll': 'admin', // 知識庫全量重建
  'members.manage': 'admin', // 成員 邀請/改角色/移除
  'line.manage': 'admin', // 組織與 LINE 憑證 讀取/儲存
  'billing.manage': 'admin', // 訂閱、付款、發票（2026-09-29 `G-106` 補：`payment/*` 原本寫死 'admin'）
  // LINE 通知：改「什麼時候通知」、開關／解除別人、幫別人產綁定連結（`D-103`）。
  // ⛔ 不綁 AI 設定的權限與 ai-feature：純真人客服的帳號一樣要收找真人與每日摘要。
  'notify.manage': 'admin',
} as const satisfies Record<string, WorkspaceMemberRole>

export type Capability = keyof typeof CAPABILITIES

/** 某角色是否具備某能力（role 為 null 視為未登入/無成員資格） */
export function can(role: WorkspaceMemberRole | null | undefined, capability: Capability): boolean {
  if (!role) return false
  return hasMinRole(role, CAPABILITIES[capability])
}
