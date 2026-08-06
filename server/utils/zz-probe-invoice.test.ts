/**
 * ⚠️ 臨時實測探針(跑完即刪,不是單元測試):
 * 用光貿公開測試帳號真打「開立 → 作廢」與「開立 → 折讓 ×2」。
 * 放在 repo 內是為了借 vitest 的 `~~` alias 解析(guangmao-invoice.ts 有 alias import)。
 */
import { writeFileSync } from 'node:fs'
import { describe, it } from 'vitest'
import { issueInvoice, voidInvoice, issueAllowance, isInvoiceConfigured } from './guangmao-invoice'

const OUT = '/private/tmp/claude-501/-Users-kevin-Documents-Github-linebot/41c1c86c-aaad-4887-8763-087afc5aa6a2/scratchpad/invoice-result.json'
const log: unknown[] = []
const rec = (label: string, data: unknown) => { log.push({ label, data }); writeFileSync(OUT, JSON.stringify(log, null, 2)) }

const keys = {
  sellerUBN: String(process.env.GUANGMAO_INVOICE_SELLER_UBN || ''),
  appKey: String(process.env.GUANGMAO_INVOICE_APP_KEY || ''),
  apiUrl: String(process.env.GUANGMAO_INVOICE_API_URL || ''),
}

describe('光貿發票實測', () => {
  it('開立/作廢/折讓', async () => {
    rec('設定', { ok: isInvoiceConfigured(keys), ubn: keys.sellerUBN })
    const stamp = String(Date.now()).slice(-9)
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')

    const b2c = await issueInvoice({
      merchantOrderNo: `INVT${stamp}A`,
      totalAmt: 399,
      itemName: 'MiniMe 標準版 月租',
      profile: { carrierNum: null, loveCode: null, buyerUBN: null, buyerName: null, buyerEmail: null },
      fallbackBuyerName: '測試帳號',
    }, keys)
    rec('① B2C 開立 399', b2c)

    if (b2c.ok && b2c.invoiceNumber) {
      const v = await voidInvoice({ invoiceNumber: b2c.invoiceNumber, invoiceDate: today, reason: '測試作廢' }, keys)
      rec('② 作廢 ' + b2c.invoiceNumber, v)
    }

    const b2b = await issueInvoice({
      merchantOrderNo: `INVT${stamp}B`,
      totalAmt: 799,
      itemName: 'MiniMe 進階版 月租',
      profile: { buyerUBN: '83610942', buyerName: '麥菲爾股份有限公司', buyerEmail: 'service@myfeel-tw.com', carrierNum: null, loveCode: null },
      fallbackBuyerName: '測試帳號',
    }, keys)
    rec('③ B2B 開立 799', b2b)

    if (b2b.ok && b2b.invoiceNumber) {
      for (const n of [1, 2]) {
        const a = await issueAllowance({
          invoiceNumber: b2b.invoiceNumber,
          invoiceDate: today,
          itemName: 'MiniMe 進階版 月租',
          totalAmt: 100,
          allowanceNumber: `AL${stamp}${n}`,
          allowanceDate: today,
          buyerName: b2b.buyerName || '麥菲爾股份有限公司',
          buyerIdentifier: b2b.buyerIdentifier || '83610942',
        }, keys)
        rec('折讓 100 第' + n + '次', a)
      }
    }
  }, 120_000)
})
