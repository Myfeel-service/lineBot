/**
 * 好友統計報告的「產生－存檔－沿用」（`D-28` 鐵律①，`D-155` 改版後照舊）。
 *
 * 沿用 `takeoverSummary` 的形狀：**按需產生、產生完存起來、下次直接沿用**。
 * ⛔ 不是每次開頁重算——一份報告約一萬次 Firestore 讀取＋約 31 次問 LINE，
 *   掛在開頁上就是 08-11 讀取費暴衝重演。
 *
 * 擺法：頂層集合 `tagReports`、doc id = workspaceId，只留**最新一份**。
 * ⛔ 刻意不存歷史版本：「最近 30 天 vs 前 30 天」每次產生都從原始資料重算，用不到舊報告。
 *
 * `D-155` 起不再叫 LLM：舊版的「一句話總結」只拿得到標籤維護的數字，四點有三點在叫人多建標籤。
 * 「接下來該做什麼」改成畫面照 `shared/friend-report-advice.ts` 的規則從數字算出來。
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import { computeFriendReport } from '~~/server/utils/friend-report-compute'
import { isCurrentReportPayload, type TagReportDoc } from '~~/shared/tag-report'

export const TAG_REPORT_COLLECTION = 'tagReports'

/**
 * 讀最近一份報告；沒有就回 `null`（＝還沒產生過，⛔ 不是「沒有資料」）。
 * `D-155` 以前存的舊形狀回 `legacy: true`、`payload: null`——畫面要請他重新產生，⛔ 不可以畫成空的。
 */
export async function getTagReport(db: Firestore, workspaceId: string): Promise<TagReportDoc | null> {
  const snap = await db.collection(TAG_REPORT_COLLECTION).doc(workspaceId).get()
  if (!snap.exists) return null
  const d = snap.data() as { generatedAtMs?: unknown, generatedBy?: unknown, payload?: unknown } | undefined
  if (!d?.payload || !d.generatedAtMs) return null
  const current = isCurrentReportPayload(d.payload)
  return {
    generatedAtMs: Number(d.generatedAtMs),
    generatedBy: String(d.generatedBy ?? ''),
    payload: current ? d.payload as TagReportDoc['payload'] : null,
    legacy: !current,
  }
}

/**
 * 產生一份新的報告並存檔。
 *
 * ⛔ **冷卻由呼叫端（端點）判斷**，這支一被呼叫就是真的要算——
 *   把閘門放在這裡會讓「強制重算」之類的需求偷偷繞過去。
 */
export async function generateTagReport(
  db: Firestore,
  workspaceId: string,
  generatedBy: string,
): Promise<TagReportDoc> {
  const payload = await computeFriendReport(db, workspaceId)
  const generatedAtMs = Date.now()
  // ⚠️ 用 set 整份蓋掉：舊版存的 summary／summarySkip 不留著，免得之後有人以為那還是現役欄位
  await db.collection(TAG_REPORT_COLLECTION).doc(workspaceId).set({
    generatedAtMs,
    generatedBy,
    payload,
    workspaceId,
    updatedAt: FieldValue.serverTimestamp(),
  })
  return { generatedAtMs, generatedBy, payload, legacy: false }
}
