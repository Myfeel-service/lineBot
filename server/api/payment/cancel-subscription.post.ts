import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { getWorkspaceSubscription, invalidateWorkspaceSubscriptionCache } from '~~/server/utils/billing'

/**
 * POST /api/payment/cancel-subscription
 * body: { workspaceId }
 *
 * 取消自動續訂。**期末生效**——這是訂閱制的標準做法:客戶已經付了這一期的錢,
 * 服務要用到期末,不是按下去就斷。
 *
 * ── 為什麼不需要呼叫金流 ────────────────────────────────────────────────
 * PAYUNi 是 Token 模型:每期扣款由**我方排程主動發動**（chargeDueRecurring），
 * 排程看到 `cancelAtPeriodEnd` 就不扣 → **只寫我方資料庫就已經真的停掉扣款**,
 * 而且失敗方向安全（寫失敗 = 沒取消成功,客戶再按一次即可）。
 *
 * 對比藍新（已移除）:那是金流按自己的排程扣款,不主動終止委託就會出現
 * 「我方標記已取消、金流還在扣」的爭議款,所以當初必須先打 AlterStatus 成功才寫 DB。
 * 換成 PAYUNi 之後那個風險結構性地消失了——這是 Token 模型的好處,不是省略步驟。
 *
 * ⚠️ Token 刻意**保留**:客戶反悔要恢復訂閱、以及日後向 PAYUNi 解除約定
 *    （`credit_bind_cancel`,端點形式待確認,見 docs/PAYUNI-RECURRING-DESIGN.md §2）都需要它。
 *    留著不會自己扣款——沒有任何排程會扣 `cancelAtPeriodEnd` 的訂閱。
 *
 * ⚠️ 只要還有約定卡就允許取消,不看 autoRenew。寬限期滿被降回免費層的帳號 autoRenew
 *    已經是 false,但卡還綁著,那正是客戶最想按這顆按鈕的時刻。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'admin')

  const db = getDb()
  const sub = await getWorkspaceSubscription(workspaceId, db)
  if (!sub?.payuniCardToken) {
    throw createError({ statusCode: 400, statusMessage: '此帳號目前沒有自動扣款委託' })
  }

  // ⚠️ **只動這三個欄位**（點狀路徑）,不回寫整個 subscription。續扣排程可能正在同一份
  //    訂閱上寫結果（開通、扣折抵餘額）,整包回寫會把它抹掉。
  //    期末就要降級了,還留著「下期改成 X 方案」只會讓期末行為變成兩個互相矛盾的指示 → 一起清掉。
  await db.collection('workspaces').doc(workspaceId).update({
    'subscription.autoRenew': false,
    'subscription.cancelAtPeriodEnd': true,
    'subscription.pendingPlanId': FieldValue.delete(),
    'updatedAt': FieldValue.serverTimestamp(),
  })
  invalidateWorkspaceSubscriptionCache(workspaceId)

  console.log('[payment] 已取消自動續訂', workspaceId, '本期至', sub.currentPeriodEnd)
  return { ok: true, activeUntil: sub.currentPeriodEnd }
})
