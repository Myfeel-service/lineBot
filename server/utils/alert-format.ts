/**
 * 異常中心的文案整形（純函式，給 GET /api/admin/alerts 用）。
 *
 * 這些字串會直接出現在使用者眼前的小卡上，所以「截斷」要截在人看得懂的地方。
 * 抽出來獨立測試：之前吃過「標籤截成殘句」的虧。
 */

/**
 * 把後端存的失敗原因整理成一句人看得懂的話。
 *
 * 實務上的原始值長這樣：
 *   `自動檢查失敗：Google Sheets API 錯誤 503：{\n  "error": {\n    "code": 503…`
 * 直接 slice 會截在 JSON 中間變成殘句，所以先砍掉附帶的 JSON／堆疊，只留前面那句人話。
 */
export function cleanReason(raw: unknown, maxLen = 80): string {
  let text = String(raw ?? '').replace(/\s+/g, ' ').trim()
  // 原因後面常黏著原始 JSON 回應；前面已經有人話就把 JSON 砍掉
  // （門檻 10：整串就是 JSON 時不要砍成空字串，那樣等於什麼都沒說）
  const brace = text.search(/[{[]/)
  if (brace > 10)
    text = text.slice(0, brace).trim()
  text = text.replace(/[：:，,。\s]+$/, '')
  return text.length > maxLen ? `${text.slice(0, maxLen).trim()}…` : text
}

/** 小時數講人話：不到 1 小時講分鐘，超過講小時（不要出現「等了 0 小時」） */
export function humanizeHours(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0)
    return '不到 1 分鐘'
  if (hours < 1)
    return `${Math.max(1, Math.round(hours * 60))} 分鐘`
  return `${Math.round(hours)} 小時`
}
