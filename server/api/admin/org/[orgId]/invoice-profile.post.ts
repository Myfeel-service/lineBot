import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireActiveOrgAdmin } from '~~/server/utils/workspace-auth'
import { normalizeInvoiceProfile } from '~~/server/utils/invoice-profile'
import { invoiceKeysFromConfig } from '~~/server/utils/invoice'
import { verifyCarrierNum } from '~~/server/utils/verify-carrier'
import { writeAuditLog } from '~~/server/utils/audit-log'

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

  const { uid } = await requireActiveOrgAdmin(event, orgId)
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

  /*
   * 稽核（`C-254`）。⚠️ 這是**組織層**的動作，沒有單一官方帳號可以掛，
   * 所以 `workspaceId` 留空、改帶 `orgId`——它不會出現在某個帳號的「操作紀錄」頁，
   * 要在平台稽核頁（超管）才看得到。⛔ 不要為了讓它現身而隨便塞一個 workspaceId。
   * 這一格一改，底下所有官方帳號的發票抬頭預設值都跟著變。
   */
  await writeAuditLog({
    workspaceId: '',
    orgId,
    uid,
    actor: 'human',
    action: 'org.invoiceProfile',
    // ⛔ 只記抬頭與統編：載具號碼、捐贈碼、Email 是個資，稽核不該多存一份
    after: { title: String(profile.buyerName ?? ''), taxId: String(profile.buyerUBN ?? '') },
    note: '改了組織的發票抬頭預設值，底下沒有另外設定的官方帳號都會跟著用這一份',
  }, db)

  return { ok: true, profile }
})
