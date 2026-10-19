import type { SuperAlertsOverviewPayload } from '~~/shared/types/super-alerts'

/**
 * 超管「全站異常總覽」整包結果的記憶體快取（原本是 alerts-overview.get.ts 裡的一個變數）。
 *
 * 搬出來是為了讓別支端點清得掉：超管在那頁按「處理好了」之後（`D-136`），
 * 5 分鐘內的重新整理不該又把那一筆從快取裡拿回來（`/code-review` 10-19）。
 */
const PAYLOAD_CACHE_TTL_MS = 5 * 60_000

let cache: { at: number, payload: SuperAlertsOverviewPayload } | null = null

export function readSuperAlertsCache(): SuperAlertsOverviewPayload | null {
  return cache && Date.now() - cache.at < PAYLOAD_CACHE_TTL_MS ? cache.payload : null
}

export function writeSuperAlertsCache(payload: SuperAlertsOverviewPayload): void {
  cache = { at: Date.now(), payload }
}

export function clearSuperAlertsCache(): void {
  cache = null
}
