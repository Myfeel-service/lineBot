/**
 * 統計端點要從 `conversationSessions` 撈哪幾個欄位（Firestore `.select()` 投影）。
 *
 * 為什麼要投影：對話場文件很肥（含結束快照、最後一則訊息預覽、各種時間戳），
 * 但統計只用得到其中幾格。MYFEEL 近 30 天有 2,002 場、近 90 天 4,335 場，
 * 整份搬回來 vs 只搬這幾欄，同一支查詢實測 2.5 秒 → 1.5 秒（90 天 3.2 → 2.1 秒）。
 *
 * ⚠️ 投影**不會**讓讀取筆數變少（Firestore 照文件數計費），省的是延遲與跨雲流量。
 *    要連筆數一起省得做每日預聚合（見 `docs/STATUS.md` 的 `E-22`）。
 *
 * ⛔ 動統計算式時**這裡要跟著動**：讀了沒投影的欄位不會報錯，只會拿到 `undefined`——
 *    數字靜靜地算錯（「沒人回」全部歸零那種）。`kpi.get.test.ts` / `trend.get.test.ts`
 *    的假 Firestore 會照這份清單裁切欄位，漏了就會紅。
 */

/** 兩支統計端點共用的最小集合 */
const SESSION_STATS_BASE = [
  'openedAt', // 分桶、排序
  'initialHandler', // 第一句話誰回的
  'hasHandoff', // 有沒有轉真人
  'status', // 結案率
  'origin', // ↓ isPreInboundFollowSession：活動／加好友出生、客人沒開口的場不進統計
  'hasInbound',
] as const

/** 趨勢圖：只要分桶與四個分類 */
export const TREND_SESSION_FIELDS: string[] = [...SESSION_STATS_BASE]

/** KPI 卡：多了「點名是哪幾位客人」與「轉真人等了多久」 */
export const KPI_SESSION_FIELDS: string[] = [
  ...SESSION_STATS_BASE,
  'userId', // 沒人回／等太久的名單樣本要補客人名字
  'handoffRequestedAt', // ↓ SLA：等待 = 真人第一次回 − 轉真人時間
  'humanFirstRepliedAt',
]
