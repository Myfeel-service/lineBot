/**
 * 超管「扣款失敗」清單的讀取（`B-43`②，2026-10-20）。
 *
 * 為什麼要有：扣款失敗以前只有**客戶**收得到（失敗信、帳單頁黃色警示、店家 LINE 紅色異常），
 * 我們自己完全不知道。第一位付費客戶的首次續扣是 IP 白名單唯一的驗證機會（`B-4`）——
 * 白名單錯的話客人會收到「你的卡扣款失敗」，其實是我們的問題，我們卻要等客人來問才知道。
 *
 * 兩個查詢都是單一欄位條件（Firestore 自動索引，不用另外部署）：
 *   ① 還在寬限期的：`subscription.status == past_due`（續扣排程用的同一個條件）
 *   ② 近 14 天因扣不到款降回免費的：`subscription.nonPaymentDowngrade.on >= 14 天前`
 * 查詢失敗會 throw——呼叫端要回 null（「這次查不到」），⛔ 不可以當成「沒有人扣款失敗」。
 */
import type { Firestore } from 'firebase-admin/firestore'
import { addDays } from '~~/shared/time'
import { buildDunningRow, RECENT_DOWNGRADE_DAYS, sortDunningRows, type DunningRow } from '~~/shared/billing/dunning'
import type { WorkspaceDoc } from '~~/shared/types/organization'

export async function readDunningRows(db: Firestore, today: string): Promise<DunningRow[]> {
  const [pastDue, downgraded] = await Promise.all([
    db.collection('workspaces').where('subscription.status', '==', 'past_due').get(),
    db.collection('workspaces')
      .where('subscription.nonPaymentDowngrade.on', '>=', addDays(today, -RECENT_DOWNGRADE_DAYS))
      .get(),
  ])
  const seen = new Set<string>()
  const rows: DunningRow[] = []
  for (const doc of [...pastDue.docs, ...downgraded.docs]) {
    if (seen.has(doc.id)) continue
    seen.add(doc.id)
    const ws = doc.data() as WorkspaceDoc
    const row = buildDunningRow(doc.id, String(ws.name ?? '').trim() || doc.id, ws.subscription, today)
    if (row) rows.push(row)
  }
  return sortDunningRows(rows)
}
