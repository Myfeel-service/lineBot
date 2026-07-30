import { FieldValue } from 'firebase-admin/firestore'
import { requireSuperAdmin } from '~~/server/utils/workspace-auth'
import { getDb } from '~~/server/utils/firebase'
import { invalidateWorkspaceSubscriptionCache } from '~~/server/utils/billing'
import type { WorkspaceDoc } from '~~/shared/types/organization'

/**
 * POST /api/admin/super/grant-credit — 給某個帳號一筆「可折抵下期扣款」的餘額。僅 super admin。
 * body: { workspaceId, amount, reason }   amount 可為負數（沖銷開錯的折抵）
 *
 * 用途:升級／異動的差額、服務補償等**改成折抵下期而不退現金**（老闆 2026-07-29 拍板）。
 *
 * 為什麼是折抵而不是退款——**稅務乾淨**:
 *   · 折抵 = 「下期少收錢」→ 下期發票直接開少收後的實收金額,原發票完全不動、不用折讓。
 *   · 退現金 = 要動退款 API + 對原發票作廢／折讓,兩套稅務動作,而且跨月就只能走折讓。
 *   （真的要退現金是另一條路,不要跟這裡混用——見 docs/PAYUNI-RECURRING-DESIGN.md §7.7）
 *
 * ⚠️ 這支**只加減數字、不碰金流**。折抵在下一期續扣時才被使用（見 shared/billing/recurring.ts）;
 *    若折抵 ≥ 月費,那期就完全不向信用卡請款、也不開發票（那筆錢先前已收過並已開票）。
 */
export default defineEventHandler(async (event) => {
  const { uid } = await requireSuperAdmin(event)

  const body = await readBody(event)
  const workspaceId = String(body?.workspaceId || '').trim()
  const amount = Math.round(Number(body?.amount))
  const reason = String(body?.reason || '').trim()
  if (!workspaceId) throw createError({ statusCode: 400, statusMessage: '缺少帳號 ID' })
  if (!Number.isFinite(amount) || amount === 0) throw createError({ statusCode: 400, statusMessage: '折抵金額需為非零整數' })
  if (!reason) throw createError({ statusCode: 400, statusMessage: '請填寫原因（會留在稽核紀錄）' })

  const db = getDb()
  const wsRef = db.collection('workspaces').doc(workspaceId)

  // transaction：兩個超管同時開折抵時不能覆蓋彼此（後寫的會吃掉前一筆）。
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(wsRef)
    if (!snap.exists) throw createError({ statusCode: 404, statusMessage: '找不到此帳號' })
    const ws = snap.data() as WorkspaceDoc
    const sub = ws.subscription
    if (!sub) throw createError({ statusCode: 400, statusMessage: '此帳號沒有訂閱,無法開折抵' })

    const before = Math.max(0, Math.floor(sub.creditBalance ?? 0))
    // 餘額不進負數:沖銷只能沖到 0,不會變成「客戶欠我們錢」那種收不回來又難解釋的狀態。
    const after = Math.max(0, before + amount)
    const next = { ...sub }
    if (after > 0) next.creditBalance = after
    else delete next.creditBalance

    tx.update(wsRef, { subscription: next, updatedAt: FieldValue.serverTimestamp() })
    // 稽核紀錄另存一筆（訂閱上只留餘額,誰在什麼時候給了多少要能查）
    tx.create(db.collection('billingCredits').doc(), {
      workspaceId,
      organizationId: ws.organizationId ?? null,
      amount,
      balanceBefore: before,
      balanceAfter: after,
      reason,
      grantedBy: uid,
      createdAt: FieldValue.serverTimestamp(),
    })
    return { before, after }
  })

  invalidateWorkspaceSubscriptionCache(workspaceId)
  console.log('[payment] 開折抵', workspaceId, `${result.before} → ${result.after}`, `(${amount > 0 ? '+' : ''}${amount})`, reason)
  return { ok: true, ...result }
})
