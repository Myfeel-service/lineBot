import { requireSuperAdmin, trustedEmail } from '~~/server/utils/workspace-auth'
import { isEmailConfigured, readEmailDeliveryHealth, sendEmail } from '~~/server/utils/email'
import { clearSuperAlertsCache } from '~~/server/utils/super-alerts-cache'
import { testEmail } from '~~/shared/billing/email-content'
import type { EmailHealthInput } from '~~/shared/billing/email-health'
import { taipeiDateTime } from '~~/shared/time'

/**
 * POST /api/admin/super/test-email — 寄一封測試信給**按的那位超管自己**（`B-50`，2026-10-20）。
 *
 * 為什麼：寄信設定壞掉時金流一切正常、只有帳務信寄不出去（寄信層設計成不拖累金流），
 * 以前唯一的證據是 08-17 那封收據信。這顆按鈕讓「現在寄不寄得出去」一按就知道。
 *
 * ⛔ 收件人只能是登入者本人、而且信箱要驗證過（trustedEmail）——不收任何 body 參數，
 *    這支不能被拿來寄信給別人。寄的結果照樣記進寄信紀錄（sendEmail 統一記），
 *    回傳最新的寄信狀態讓畫面就地更新（⛔ 不叫前端 force 重查整頁：那會把全部帳號的異常重新探測一輪）。
 */
export default defineEventHandler(async (event) => {
  const { token } = await requireSuperAdmin(event)
  const to = trustedEmail(token)
  if (!to) throw createError({ statusCode: 400, statusMessage: '你的登入信箱沒有驗證過，寄不了測試信' })

  const config = useRuntimeConfig(event)
  const pub = (config.public ?? {}) as Record<string, unknown>
  const health = async (): Promise<EmailHealthInput | null> =>
    readEmailDeliveryHealth()
      .then(h => ({ ...h, paymentEnabled: Boolean(pub.paymentEnabled) }))
      .catch(() => null)

  if (!isEmailConfigured())
    return { ok: false as const, to, error: '寄信設定不齊（EMAIL_FROM 或區域沒設），信一封都寄不出去', health: await health() }

  const brandName = String(pub.brandName ?? '').trim() || 'MiniMe'
  const from = String((config as Record<string, unknown>).emailFrom ?? '').trim()
  const r = await sendEmail({ to, ...testEmail({ brandName, sentAtText: taipeiDateTime(Date.now()), from }) })
  // 寄信紀錄剛更新 → 清掉異常總覽的 5 分鐘快取，之後的重新整理才不會拿到舊的那份
  clearSuperAlertsCache()
  return r.ok
    ? { ok: true as const, to, health: await health() }
    : { ok: false as const, to, error: r.error || '寄不出去（原因不明，看主機日誌）', health: await health() }
})
