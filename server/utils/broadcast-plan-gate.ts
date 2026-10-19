/**
 * 推播的方案閘門（`D-131`①，2026-10-19）。
 *
 * 以前只有送出端（`broadcast-send.ts`）在擋，而且擋在「已經把推播標成發送中」之後：
 * 輕量方案的人排好一則依標籤的推播，按送出才失敗；排程的話是**到了時間**才失敗，
 * 中間還會卡在「發送中」十分鐘等看門狗收殮。
 * 現在每一個「之後會送出去」的入口都先問同一支：驗證視窗、立即送出、確認排程、儲存排程中的推播。
 *
 * ⚠️ 讀不到訂閱（Firestore 故障）一律放行，跟 `assertPlanAllows` 同一個 fail-open 慣例——
 *    基礎設施出問題時不該把付費客戶擋在門外；真的不該送的，送出端還會再擋一次。
 */
import type { Firestore } from 'firebase-admin/firestore'
import { getDb } from './firebase'
import { getWorkspacePlan } from './billing'
import { broadcastPlanBlockReason, type BroadcastTier } from '~~/shared/billing/plans'

/** 這個帳號現在的推播等級；null＝讀不到訂閱（呼叫端照 fail-open 處理）。 */
export async function workspaceBroadcastTier(
  workspaceId: string,
  db: Firestore = getDb(),
): Promise<BroadcastTier | null> {
  const plan = await getWorkspacePlan(workspaceId, db)
  return plan ? plan.broadcast : null
}

/** 這個帳號發這種對象會不會被方案擋：會的話回那一句（`broadcastLockText`），不會回 null。 */
export async function broadcastPlanBlockFor(
  workspaceId: string,
  audienceType: string | null | undefined,
  db: Firestore = getDb(),
): Promise<string | null> {
  const tier = await workspaceBroadcastTier(workspaceId, db)
  return tier ? broadcastPlanBlockReason(tier, audienceType) : null
}

/** 端點用：會被擋就丟 403，訊息就是推播頁鎖住時那一句。 */
export async function assertBroadcastPlanAllows(
  workspaceId: string,
  audienceType: string | null | undefined,
  db: Firestore = getDb(),
): Promise<void> {
  const reason = await broadcastPlanBlockFor(workspaceId, audienceType, db)
  if (reason) throw createError({ statusCode: 403, statusMessage: reason })
}
