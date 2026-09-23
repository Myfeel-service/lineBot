/**
 * 「這次不做」的讀寫（`C-236`）。
 *
 * 擺法：頂層集合 `marketingCalendarSkips`、doc id = workspaceId，一份文件一個 map。
 * ⛔ 刻意**不**做成一筆一份文件：這東西最多幾十筆、而且每次開卡都要整份讀，
 *   拆成子集合只是把一次讀取變成 N 次。
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import { normalizeSkipMap, pruneSkipMap, type MarketingSkipMap } from '~~/shared/marketing-skips'

export const MARKETING_SKIPS_COLLECTION = 'marketingCalendarSkips'

/** 讀。沒有文件就回空 map（不是 null）——呼叫端不用到處判 null。 */
export async function getMarketingSkips(db: Firestore, workspaceId: string): Promise<MarketingSkipMap> {
  const snap = await db.collection(MARKETING_SKIPS_COLLECTION).doc(workspaceId).get()
  if (!snap.exists) return {}
  return normalizeSkipMap((snap.data() as { skips?: unknown } | undefined)?.skips)
}

/**
 * 收起來 / 放回來。
 *
 * ⛔ 整包覆寫 `skips`，**不要**用 `merge` 逐鍵更新：放回來時要真的把那個 key 拿掉，
 *   merge 的話它會留在資料庫裡（跟 `store-profile.ts` 那份欄位同一個教訓）。
 */
export async function setMarketingSkip(
  db: Firestore,
  workspaceId: string,
  festivalId: string,
  skip: boolean,
): Promise<MarketingSkipMap> {
  const ref = db.collection(MARKETING_SKIPS_COLLECTION).doc(workspaceId)
  const current = await getMarketingSkips(db, workspaceId)
  const next = { ...current }
  if (skip) next[festivalId] = Date.now()
  else delete next[festivalId]

  const pruned = pruneSkipMap(next)
  await ref.set({ workspaceId, skips: pruned, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  return pruned
}
