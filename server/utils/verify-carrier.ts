/**
 * 存發票資訊前，先跟光貿問一次「這組手機條碼真的存在嗎」。
 *
 * 為什麼不能只驗格式：`/ABC1234` 格式完全合法，但財政部那邊查無此碼——2026-08-16 實測，
 * 帶著它開立，光貿退 `3040132 載具號碼不存在`。**發票開不出來，而錢已經收了**。
 *
 * ⚠️ **查不到不等於填錯**：光貿沒設金鑰、連線失敗、被 IP 擋，都不能拿來擋客戶存檔——
 * 那會變成「光貿一出問題，全站沒人能改發票資訊」。所以只在**明確查到不存在**時才擋。
 *
 * 兩道防線的分工（缺一不可）：
 *   · 這裡＝存檔當下擋掉打錯的，客戶當場就知道
 *   · `invoice.ts` 的自動退回紙本＝萬一還是漏過去（例如存檔時光貿剛好連不上），
 *     開票時改開紙本，至少發票開得出來，不會卡在無限重試
 */
import { checkMobileBarcode, type GuangmaoInvoiceKeys } from './guangmao-invoice'

export interface CarrierVerifyOutcome {
  /** 明確查到「這組不存在」才會是 true —— 只有這時候該擋下來。 */
  rejected: boolean
  /** 給使用者看的原因（僅 rejected 時有值）。 */
  reason: string
}

const OK: CarrierVerifyOutcome = { rejected: false, reason: '' }

export async function verifyCarrierNum(
  carrierNum: string | null | undefined,
  keys: GuangmaoInvoiceKeys | null,
): Promise<CarrierVerifyOutcome> {
  const code = String(carrierNum ?? '').trim()
  if (!code || !keys) return OK

  try {
    const r = await checkMobileBarcode(code, keys)
    if (r.exists === false) {
      return {
        rejected: true,
        // 帶上光貿的原話：客戶才知道是「這組不存在」而不是我方系統壞掉
        reason: `手機條碼「${code}」在財政部查不到${r.message ? `（${r.message}）` : ''}，請確認是否打錯。存錯的話發票會開不出來。`,
      }
    }
    return OK
  }
  catch (e) {
    // 連線層炸掉也一律放行——擋住存檔的代價比放行大
    console.warn('[verify-carrier] 查證失敗，放行', (e as Error)?.message)
    return OK
  }
}
