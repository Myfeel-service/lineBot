import { findWorkspacesByLiffChannelId } from './line-workspace-credentials'
import { liffChannelIdFromLiffId } from './liff-token'

/**
 * 從 LIFF 的 Login channel ID 反查是哪個租戶。
 *
 * `/api/liff/config`（活動頁載入設定）與 `/api/liff/lead-error`（活動頁回報失敗）
 * 問的是同一個問題，⛔ 兩邊各寫一份遲早會漂：撞號時一邊猜、一邊不猜，就會出現
 * 「設定讀不到但失敗紀錄記到別家帳號」。
 *
 * ⛔ 撞號（兩個租戶共用同一個 Login channel）一律回空、不猜：猜錯會讓客人去別的
 * Login channel 登入，拿到別的 provider scope 下的 userId，貼標貼到不存在的人身上。
 */
export async function resolveWorkspaceIdByLiffChannelId(liffClientIdRaw: string): Promise<{
  workspaceId: string
  defaultLiffId: string
}> {
  const liffClientId = String(liffClientIdRaw || '').trim()
  if (!/^\d+$/.test(liffClientId)) return { workspaceId: '', defaultLiffId: '' }

  // 前綴範圍查詢最多讀 2 筆（見 findWorkspacesByLiffChannelId）；再用同一支解析函式復核，
  // 免得「前綴相同但格式不是 {id}-{suffix}」的資料被當成命中
  const matches = (await findWorkspacesByLiffChannelId(liffClientId))
    .filter(r => liffChannelIdFromLiffId(r.credentials.defaultLiffId) === liffClientId)

  const only = matches.length === 1 ? matches[0] : undefined
  if (only) return { workspaceId: only.workspaceId, defaultLiffId: only.credentials.defaultLiffId }

  if (matches.length > 1) {
    console.warn(
      '[liff] liffClientId matches multiple workspaces, refusing to guess:',
      liffClientId,
      matches.map(m => m.workspaceId),
    )
  }
  return { workspaceId: '', defaultLiffId: '' }
}
