import { parseFirestoreDate } from './firestore-date'

/**
 * 帳號成員邀請（workspaceInvites）的有效期（2026-09-29 拍板：30 天沒人接受就過期，`G-107`⑥）。
 *
 * 為什麼要過期：原本邀請永遠有效——發錯人、對方離職、信箱換手，那張邀請都一直等著，
 * 誰之後拿那個信箱登入就直接變成員；而且待處理的邀請一直佔一個席次。
 *
 * ⚠️ 過期的邀請**不刪**：留著讓成員頁顯示「已過期」，管理員決定重發還是移除（靜靜刪掉＝對方來問時沒人答得出為什麼進不來）。
 */
export const WORKSPACE_INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000

interface InviteTimes { expiresAt?: unknown, createdAt?: unknown }

/**
 * 邀請什麼時候過期（毫秒）。新邀請建立時就存 `expiresAt`；舊邀請沒有這格，照 `createdAt` + 30 天算。
 * 兩個都讀不出來回 null。
 */
export function inviteExpiresAtMs(inv: InviteTimes | null | undefined): number | null {
  const exp = Number(inv?.expiresAt)
  if (Number.isFinite(exp) && exp > 0) return exp
  const created = parseFirestoreDate(inv?.createdAt)
  return created ? created.getTime() + WORKSPACE_INVITE_TTL_MS : null
}

/**
 * 過期了沒。
 * ⛔ 讀不出時間一律當過期（判不出來走保守側）：這張邀請是「拿那個信箱登入就能進帳號」的憑證，
 *    來路不明的不放行；真的是要的人，管理員在成員頁按一次重新邀請就好。
 */
export function isInviteExpired(inv: InviteTimes | null | undefined, nowMs = Date.now()): boolean {
  const at = inviteExpiresAtMs(inv)
  return at === null || at <= nowMs
}
