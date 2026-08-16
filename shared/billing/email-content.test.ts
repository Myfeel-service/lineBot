import { describe, it, expect } from 'vitest'
import {
  escapeHtml,
  receiptEmail,
  chargeFailedEmail,
  renewalReminderEmail,
  quotaEmail,
} from './email-content'

describe('escapeHtml', () => {
  it('跳脫 HTML 特殊字元', () => {
    expect(escapeHtml('<script>&"\'')).toBe('&lt;script&gt;&amp;&quot;&#39;')
  })
  it('null/undefined 回空字串', () => {
    expect(escapeHtml(undefined as unknown as string)).toBe('')
  })
})

describe('receiptEmail', () => {
  const base = {
    brandName: 'MYFEEL',
    workspaceName: '小福商店',
    planName: '成長',
    amount: 1990,
    periodStart: '2026-07-20',
    periodEnd: '2026-08-19',
    recurring: true,
  }

  it('含方案、金額（千分位）、本期、自動續訂', () => {
    const { subject, html, text } = receiptEmail(base)
    expect(subject).toContain('付款成功')
    expect(subject).toContain('成長')
    expect(html).toContain('NT$1,990')
    expect(html).toContain('2026-07-20')
    expect(html).toContain('信用卡自動續訂')
    expect(text).toContain('NT$1,990')
    expect(text).toContain('信用卡自動續訂')
  })

  it('有發票號碼時才顯示發票欄', () => {
    expect(receiptEmail({ ...base, invoiceNumber: 'AB12345678' }).html).toContain('AB12345678')
    expect(receiptEmail(base).html).not.toContain('電子發票號碼')
  })

  // 收據信是離信用卡帳單最近的一份文件：帳單上的請款名稱（myfeel）與品牌（MiniMe）不同，
  // 客戶月底對帳靠這一行對得起來，不然就是打去銀行辦爭議（爭議款我方自負）。
  it('有請款名稱時，收據信要寫出帳單會顯示什麼', () => {
    const { html, text } = receiptEmail({ ...base, statementName: 'myfeel' })
    expect(html).toContain('信用卡帳單顯示')
    expect(html).toContain('myfeel')
    expect(text).toContain('信用卡帳單顯示：myfeel')
  })

  it('沒設請款名稱就整列不出現（寧可不講，也不要講錯的名字）', () => {
    expect(receiptEmail(base).html).not.toContain('信用卡帳單顯示')
  })

  // 折抵蓋滿整期＝那期完全沒有向卡片請款，帳單不會出現任何一筆 → 講了只會造成混淆
  it('折抵全額支付那期不提帳單名稱', () => {
    const { html } = receiptEmail({ ...base, amount: 0, creditApplied: 1990, statementName: 'myfeel' })
    expect(html).not.toContain('信用卡帳單顯示')
  })

  it('單次付款顯示為單次付款', () => {
    const { html } = receiptEmail({ ...base, recurring: false })
    expect(html).toContain('單次付款')
    expect(html).not.toContain('信用卡自動續訂')
  })

  it('workspace 名稱經過 HTML 跳脫（防注入）', () => {
    const { html } = receiptEmail({ ...base, workspaceName: '<b>x</b>' })
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(html).not.toContain('<b>x</b>')
  })
})

describe('chargeFailedEmail', () => {
  it('主旨提到更新付款方式，內文帶管理連結', () => {
    const { subject, html, text } = chargeFailedEmail({
      brandName: 'MYFEEL', workspaceName: '小福商店', planName: '成長',
      manageUrl: 'https://app.example.com/admin/ws1/settings/billing',
    })
    expect(subject).toContain('扣款失敗')
    expect(html).toContain('https://app.example.com/admin/ws1/settings/billing')
    expect(text).toContain('https://app.example.com/admin/ws1/settings/billing')
  })
})

describe('renewalReminderEmail', () => {
  it('主旨含扣款日與方案，內文含金額', () => {
    const { subject, html } = renewalReminderEmail({
      brandName: 'MYFEEL', workspaceName: '小福商店', planName: '成長',
      amount: 1990, chargeDate: '2026-08-19',
      manageUrl: 'https://app.example.com/b',
    })
    expect(subject).toContain('2026-08-19')
    expect(subject).toContain('成長')
    expect(html).toContain('NT$1,990')
  })
})

describe('quotaEmail', () => {
  const base = {
    brandName: 'MYFEEL', workspaceName: '小福商店', planName: '免費',
    used: 200, quota: 200, manageUrl: 'https://app.example.com/b',
  }
  it('over：主旨為已用完、內文提到暫停自動回覆', () => {
    const { subject, html } = quotaEmail({ ...base, kind: 'over' })
    expect(subject).toContain('已用完')
    expect(html).toContain('暫停自動回覆')
    expect(html).toContain('200 / 200 則')
  })
  it('near：主旨為即將用完', () => {
    const { subject } = quotaEmail({ ...base, used: 170, kind: 'near' })
    expect(subject).toContain('即將用完')
  })
})

describe('receiptEmail — 折抵（客戶最容易來電問的地方）', () => {
  const base = {
    brandName: 'MiniMe', workspaceName: '測試 OA', planName: '輕量',
    periodStart: '2026-08-28', periodEnd: '2026-09-27', recurring: true,
  }

  it('部分折抵 → 攤成「方案月費 − 折抵 = 本次實收」三行', () => {
    // 只寫「NT$299」而不解釋為什麼比 399 少,就是一通客服電話
    const c = receiptEmail({ ...base, amount: 299, creditApplied: 100 })
    expect(c.text).toContain('方案月費（含稅）：NT$399')
    expect(c.text).toContain('折抵：− NT$100')
    expect(c.text).toContain('本次實收（含稅）：NT$299')
    expect(c.subject).toContain('付款成功') // 有真的扣到錢
    expect(c.text).toContain('付款方式：信用卡自動續訂')
  })

  it('折抵蓋滿整期 → 標題改「本期已續訂」,**不能**寫成「付款成功 NT$0」', () => {
    const c = receiptEmail({ ...base, amount: 0, creditApplied: 399 })
    expect(c.subject).toContain('本期已續訂')
    expect(c.subject).toContain('由折抵支付')
    expect(c.subject).not.toContain('付款成功')
    expect(c.text).toContain('本期已續訂')
    expect(c.text).toContain('付款方式：折抵餘額支付（未扣卡）')
    expect(c.text).toContain('這次沒有向信用卡請款')
    expect(c.text).toContain('方案月費（含稅）：NT$399')
    expect(c.text).toContain('本次實收（含稅）：NT$0')
  })

  it('沒有折抵 → 維持原本樣子（不多出折抵欄）', () => {
    const c = receiptEmail({ ...base, amount: 399, creditApplied: 0 })
    expect(c.text).toContain('金額（含稅）：NT$399')
    expect(c.text).not.toContain('折抵')
    expect(c.subject).toContain('付款成功')
  })

  it('creditApplied 未提供時視為 0（相容既有呼叫端）', () => {
    const c = receiptEmail({ ...base, amount: 399 })
    expect(c.text).not.toContain('折抵')
  })

  it('折抵金額是小數/負數不會算出怪數字', () => {
    expect(receiptEmail({ ...base, amount: 399, creditApplied: -50 }).text).not.toContain('折抵')
    expect(receiptEmail({ ...base, amount: 299, creditApplied: 100.6 }).text).toContain('折抵：− NT$101')
  })
})
