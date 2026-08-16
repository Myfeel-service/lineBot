import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { normalizeInvoiceProfile } from '~~/server/utils/invoice-profile'
import { invoiceKeysFromConfig } from '~~/server/utils/invoice'
import { verifyCarrierNum } from '~~/server/utils/verify-carrier'
import { hasInvoiceProfile } from '~~/shared/types/organization'

/**
 * POST /api/payment/invoice-profile — 儲存**這個官方帳號專屬**的發票資訊。
 *
 * 一般情況不需要用到——統編與抬頭是組織層級的（見 /api/admin/org/:orgId/invoice-profile），
 * 這裡只給「同一家公司底下不同 OA 要開不同抬頭」的情況（例：代理商幫不同客戶各開一個 OA）。
 *
 * 全部欄位留空 = 清掉覆寫、回去沿用組織的預設值。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'admin')
  const profile = normalizeInvoiceProfile(await readBody(event))

  // 手機條碼要跟光貿查證「存不存在」——格式檢查驗不出來，而存錯的代價是那筆訂單的
  // 發票永遠開不出來（見 server/utils/verify-carrier.ts）。查不到一律放行，只擋確定錯的。
  const verdict = await verifyCarrierNum(
    profile.carrierNum,
    invoiceKeysFromConfig(useRuntimeConfig(event) as unknown as Record<string, unknown>),
  )
  if (verdict.rejected) throw createError({ statusCode: 400, statusMessage: verdict.reason })

  await getDb().collection('workspaces').doc(workspaceId).update({
    // 全空 → 刪掉欄位而不是存一份空白 profile，否則 resolveInvoiceProfile 判斷不出
    // 「沒填」與「刻意填空」的差別，組織的預設值就再也回不來了。
    invoiceProfile: hasInvoiceProfile(profile) ? profile : FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
  })

  return { ok: true, profile, inherited: !hasInvoiceProfile(profile) }
})
