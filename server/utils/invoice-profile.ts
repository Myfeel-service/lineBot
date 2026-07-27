/**
 * 電子發票「與供應商無關」的共用層：
 *   1. 買受人資訊(統編／抬頭／載具／捐贈碼)的格式驗證與正規化——這些是**財政部標準**,
 *      不管接哪一家加值中心(光貿 Amego、ezPay…)規則都一樣。
 *   2. 開立發票的**契約型別**(IssueInvoiceInput / IssueInvoiceResult)——供應商層要遵守
 *      這組介面,通用流程層(invoice.ts)只依賴這組介面,換供應商時流程層不用動。
 *
 * 供應商專屬的加解密與 API 呼叫放在各自的 provider 檔(見 guangmao-invoice.ts)。
 */
import type { InvoiceProfile } from '~~/shared/types/organization'

// ── 開立發票的契約型別(所有 provider 共用) ─────────────────────────────

export interface IssueInvoiceInput {
  merchantOrderNo: string
  /** 含稅總額 = 實際請款金額 */
  totalAmt: number
  itemName: string
  profile: InvoiceProfile
  /** B2C 未填抬頭時的預設買受人名稱(用帳號名稱)。 */
  fallbackBuyerName: string
}

export interface IssueInvoiceResult {
  ok: boolean
  /** provider 回傳的狀態碼字串(成功或錯誤碼);記進 invoices 供人工排查。 */
  status: string
  message: string
  /** 發票號碼(開立成功才有)。 */
  invoiceNumber?: string
  /** 發票隨機碼(對獎用)。 */
  randomNum?: string
  /** 開立時間(provider 回傳字串)。 */
  createTime?: string
  /** provider 專屬交易序號(ezPay=InvoiceTransNo);光貿沒有則留空。 */
  invoiceTransNo?: string
  /** 回應驗簽是否通過;false = 回應可疑,仍記錄但標記。provider 不支援則留空。 */
  checkCodeValid?: boolean
}

// ── 格式驗證(財政部標準,存檔時就擋掉) ──────────────────────────────

/** 手機條碼載具格式：/ + 7 碼(大寫英數與 + - .)。 */
export function isValidCarrierNum(v: string): boolean {
  return /^\/[0-9A-Z+\-.]{7}$/.test(String(v || '').trim().toUpperCase())
}

/** 捐贈碼：3–7 碼純數字。 */
export function isValidLoveCode(v: string): boolean {
  return /^\d{3,7}$/.test(String(v || '').trim())
}

/** 統一編號：8 碼純數字。 */
export function isValidUBN(v: string): boolean {
  return /^\d{8}$/.test(String(v || '').trim())
}

/**
 * 驗證並正規化使用者填的發票資訊。組織層與 OA 層共用同一份規則。
 *
 * 在**存檔時**就擋掉格式錯誤,而不是等 provider 退件——發票是在「付款成功之後」才開的,
 * 那時客戶早就離開頁面了,退件他不會知道,只會過幾天發現沒收到發票。
 *
 * 格式不合直接丟 createError(呼叫端是 API handler)。
 */
export function normalizeInvoiceProfile(body: Record<string, unknown> | null | undefined): InvoiceProfile {
  const ubn = String(body?.buyerUBN || '').trim()
  const buyerName = String(body?.buyerName || '').trim()
  const buyerEmail = String(body?.buyerEmail || '').trim()
  const carrierNum = String(body?.carrierNum || '').trim().toUpperCase()
  const loveCode = String(body?.loveCode || '').trim()

  if (ubn && !isValidUBN(ubn)) {
    throw createError({ statusCode: 400, statusMessage: '統一編號需為 8 碼數字' })
  }
  if (buyerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail)) {
    throw createError({ statusCode: 400, statusMessage: 'Email 格式不正確' })
  }

  const profile: InvoiceProfile = {
    buyerUBN: ubn || null,
    buyerName: buyerName || null,
    buyerEmail: buyerEmail || null,
    carrierNum: null,
    loveCode: null,
  }

  if (ubn) {
    // B2B：公司報帳一律開可列印的發票,載具／捐贈碼不適用(帶了也會被退)
    if (!buyerName) {
      throw createError({ statusCode: 400, statusMessage: '有統一編號時必須填公司抬頭' })
    }
    return profile
  }

  if (carrierNum && loveCode) {
    throw createError({ statusCode: 400, statusMessage: '載具與捐贈碼只能擇一' })
  }
  if (carrierNum && !isValidCarrierNum(carrierNum)) {
    throw createError({ statusCode: 400, statusMessage: '手機條碼載具格式錯誤(斜線 + 7 碼大寫英數)' })
  }
  if (loveCode && !isValidLoveCode(loveCode)) {
    throw createError({ statusCode: 400, statusMessage: '捐贈碼需為 3–7 碼數字' })
  }
  profile.carrierNum = carrierNum || null
  profile.loveCode = loveCode || null
  return profile
}
