import { createHash } from 'node:crypto'

/**
 * LINE multicast 自訂彙總單位名稱（customAggregationUnits）。
 * LINE 限制長度 **1～30** 字元；以 campaignId 雜湊成固定長度，同一推播可查 insight。
 *
 * attempt＝第幾次發送（重設為草稿再發一次會 +1）。**第 1 次刻意維持原本的雜湊值**，
 * 既有推播的開封／點擊查得到；第 2 次以後換一個單位，否則同一則推播重發後
 * LINE 會把兩次的開封數加在一起（點擊率可能超過 100%）。
 */
export function broadcastAggregationUnit(campaignId: string, attempt = 1): string {
  const suffix = attempt > 1 ? `#${attempt}` : ''
  const h = createHash('sha256')
    .update(`line-broadcast-unit:${String(campaignId || '')}${suffix}`)
    .digest('hex')
    .slice(0, 28)
  return `bc${h}` // 2 + 28 = 30
}
