import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireActiveOrgAdmin } from '~~/server/utils/workspace-auth'
import { normalizeInvoiceProfile } from '~~/server/utils/invoice-profile'
import { invoiceKeysFromConfig } from '~~/server/utils/invoice'
import { verifyCarrierNum } from '~~/server/utils/verify-carrier'

/**
 * POST /api/admin/org/:orgId/invoice-profile — 組織層級的發票資訊（**預設值**）。
 *
 * 統一編號與公司抬頭幾乎一定是組織層級的東西：一家公司開 3 個官方帳號，
 * 不會想填 3 次統編。所以填一次在這裡，底下所有 OA 自動沿用；
 * 個別 OA 要開不同抬頭時才去帳單頁覆寫。
 */
export default defineEventHandler(async (event) => {
  const orgId = event.context.params?.orgId
  if (!orgId) throw createError({ statusCode: 400, statusMessage: 'orgId is required' })

  await requireActiveOrgAdmin(event, orgId)
  const profile = normalizeInvoiceProfile(await readBody(event))

  // 與 OA 層那支同一道防線：手機條碼要跟光貿查證存不存在（存錯＝發票永遠開不出來）。
  // 這裡是組織層預設值，一填影響底下所有 OA，更不能讓錯的號碼進來。
  const verdict = await verifyCarrierNum(
    profile.carrierNum,
    invoiceKeysFromConfig(useRuntimeConfig(event) as unknown as Record<string, unknown>),
  )
  if (verdict.rejected) throw createError({ statusCode: 400, statusMessage: verdict.reason })

  const db = getDb()
  const ref = db.collection('organizations').doc(orgId)
  // update() 打在不存在的文件上會丟 NOT_FOUND（前端只看得到一句 500「儲存失敗」）
  if (!(await ref.get()).exists) {
    throw createError({ statusCode: 404, statusMessage: '找不到此組織' })
  }

  await ref.update({
    invoiceProfile: profile,
    updatedAt: FieldValue.serverTimestamp(),
  })

  return { ok: true, profile }
})
