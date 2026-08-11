/**
 * 交易通知信的內文模板（**純函式、無伺服器相依**，可單元測試）。
 * 每個函式回傳 { subject, html, text }：HTML 走 email client 相容的 inline 樣式、
 * text 是純文字 fallback。動態值一律經 escapeHtml 跳脫。
 */

export interface EmailContent {
  subject: string
  html: string
  text: string
}

/** 跳脫 HTML 特殊字元（workspace 名稱等動態值可能含 < > & 等）。 */
export function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function money(n: number): string {
  return `NT$${Math.round(n).toLocaleString('en-US')}`
}

function shell(brandName: string, title: string, bodyHtml: string): string {
  return `<div style="font-family:-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1f2328;line-height:1.6;">`
    + `<div style="font-weight:700;font-size:18px;margin-bottom:16px;">${escapeHtml(brandName)}</div>`
    + `<h1 style="font-size:20px;margin:0 0 16px;">${escapeHtml(title)}</h1>`
    + bodyHtml
    + `<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">`
    + `<div style="font-size:12px;color:#8a9099;">這是系統自動發送的通知信，請勿直接回覆。若有問題，請登入後台或與我們聯繫。</div>`
    + `</div>`
}

function table(rows: Array<[string, string]>): string {
  const trs = rows.map(([k, v]) =>
    `<tr><td style="padding:6px 0;color:#6b7280;">${escapeHtml(k)}</td>`
    + `<td style="padding:6px 0;text-align:right;font-weight:600;">${escapeHtml(v)}</td></tr>`,
  ).join('')
  return `<table style="width:100%;border-collapse:collapse;font-size:14px;">${trs}</table>`
}

function paragraph(text: string): string {
  return `<p style="font-size:14px;margin:0 0 12px;">${escapeHtml(text)}</p>`
}

function button(label: string, url: string): string {
  return `<p style="margin:20px 0;"><a href="${escapeHtml(url)}" style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:600;font-size:14px;">${escapeHtml(label)}</a></p>`
}

// ── 1. 付款成功收據 ─────────────────────────────────────────
export function receiptEmail(p: {
  brandName: string
  workspaceName: string
  planName: string
  /** 實際向信用卡請款的金額（已扣折抵）。 */
  amount: number
  periodStart: string | null
  periodEnd: string | null
  invoiceNumber?: string | null
  recurring: boolean
  /**
   * 本期用掉的折抵金額。> 0 時收據會攤成「方案月費 − 折抵 = 實收」三行。
   *
   * ⚠️ 不攤開的話,客戶只會看到一個比方案定價少的數字而不知道為什麼——那是最典型的客服來電。
   *    折抵剛好蓋滿整期時（amount = 0）更要講清楚:那期**完全沒有向信用卡請款**,
   *    標題也不能寫「付款成功」（沒有付款這件事發生）。
   */
  creditApplied?: number
}): EmailContent {
  const period = p.periodStart && p.periodEnd ? `${p.periodStart} ～ ${p.periodEnd}` : '—'
  const credit = Math.max(0, Math.round(p.creditApplied ?? 0))
  // 折抵全額吸收 → 這期沒有任何信用卡交易,措辭要跟著改
  const fullyCovered = credit > 0 && p.amount <= 0

  const rows: Array<[string, string]> = [
    ['官方帳號', p.workspaceName],
    ['方案', p.planName],
  ]
  if (credit > 0) {
    rows.push(['方案月費（含稅）', money(p.amount + credit)])
    rows.push(['折抵', `− ${money(credit)}`])
  }
  rows.push([credit > 0 ? '本次實收（含稅）' : '金額（含稅）', money(p.amount)])
  rows.push(['本期', period])
  if (p.invoiceNumber) rows.push(['電子發票號碼', p.invoiceNumber])
  rows.push(['付款方式', fullyCovered ? '折抵餘額支付（未扣卡）' : (p.recurring ? '信用卡自動續訂' : '單次付款')])

  const note = fullyCovered
    ? '本期費用已由你的折抵餘額全額支付，這次沒有向信用卡請款。折抵用完後會恢復正常扣款。'
    : (p.recurring
        ? '已開啟自動續訂，下期將於本期結束後自動扣款；隨時可在後台「訂閱與付款」取消。'
        : '感謝你的購買。')

  const title = fullyCovered ? '本期已續訂' : '付款成功'
  const subject = fullyCovered
    ? `[${p.brandName}] 本期已續訂（由折抵支付）— ${p.planName}方案`
    : `[${p.brandName}] 付款成功通知 — ${p.planName}方案`
  const html = shell(p.brandName, title, paragraph(note) + table(rows))
  const text = [
    title,
    note,
    '',
    `官方帳號：${p.workspaceName}`,
    `方案：${p.planName}`,
    ...(credit > 0 ? [`方案月費（含稅）：${money(p.amount + credit)}`, `折抵：− ${money(credit)}`] : []),
    `${credit > 0 ? '本次實收（含稅）' : '金額（含稅）'}：${money(p.amount)}`,
    `本期：${period}`,
    ...(p.invoiceNumber ? [`電子發票號碼：${p.invoiceNumber}`] : []),
    `付款方式：${fullyCovered ? '折抵餘額支付（未扣卡）' : (p.recurring ? '信用卡自動續訂' : '單次付款')}`,
  ].join('\n')
  return { subject, html, text }
}

// ── 2. 扣款失敗 ─────────────────────────────────────────────
export function chargeFailedEmail(p: {
  brandName: string
  workspaceName: string
  planName: string
  manageUrl: string
}): EmailContent {
  const subject = `[${p.brandName}] 自動扣款失敗，請更新付款方式`
  const body
    = paragraph(`「${p.workspaceName}」的 ${p.planName}方案本期自動扣款失敗（常見原因是信用卡過期或額度不足）。`)
    + paragraph('服務目前仍在寬限期內可正常使用。請盡快更新付款方式，以免方案到期後被降回免費層。')
    + button('前往更新付款方式', p.manageUrl)
  const html = shell(p.brandName, '自動扣款失敗', body)
  const text = [
    '自動扣款失敗',
    `「${p.workspaceName}」的 ${p.planName}方案本期自動扣款失敗（常見原因是信用卡過期或額度不足）。`,
    '服務目前仍在寬限期內可正常使用。請盡快更新付款方式，以免方案到期後被降回免費層。',
    '',
    `更新付款方式：${p.manageUrl}`,
  ].join('\n')
  return { subject, html, text }
}

// ── 3. 續扣前提醒 ───────────────────────────────────────────
export function renewalReminderEmail(p: {
  brandName: string
  workspaceName: string
  planName: string
  amount: number
  chargeDate: string
  manageUrl: string
}): EmailContent {
  const subject = `[${p.brandName}] ${p.planName}方案將於 ${p.chargeDate} 自動續扣`
  const body
    = paragraph(`提醒你：「${p.workspaceName}」的 ${p.planName}方案將於 ${p.chargeDate} 自動續扣 ${money(p.amount)}（含稅）。`)
    + paragraph('若要繼續使用，你不需要做任何事。若要取消自動續訂，請於扣款日前到後台「訂閱與付款」操作。')
    + button('管理訂閱', p.manageUrl)
  const html = shell(p.brandName, '自動續扣提醒', body)
  const text = [
    '自動續扣提醒',
    `「${p.workspaceName}」的 ${p.planName}方案將於 ${p.chargeDate} 自動續扣 ${money(p.amount)}（含稅）。`,
    '若要繼續使用，你不需要做任何事。若要取消自動續訂，請於扣款日前到後台「訂閱與付款」操作。',
    '',
    `管理訂閱：${p.manageUrl}`,
  ].join('\n')
  return { subject, html, text }
}

// ── 4. 額度快用完 / 已用完 ──────────────────────────────────
export function quotaEmail(p: {
  brandName: string
  workspaceName: string
  planName: string
  used: number
  quota: number
  kind: 'near' | 'over'
  manageUrl: string
}): EmailContent {
  // ⛔「本期」不是「本月」：呼叫端餵的 used 來自 getQuotaAnswered(currentPeriodStart)＝
  //    訂閱錨定週期的計數器，跟日曆月不是同一把尺。原本標題寫「本月」、內文卻寫
  //    「直到下一期額度重置」——同一封信自己打架，收信的是付錢的客戶。
  const usage = `${p.used.toLocaleString('en-US')} / ${p.quota.toLocaleString('en-US')} 則`
  if (p.kind === 'over') {
    const subject = `[${p.brandName}] 本期 AI 回覆額度已用完`
    const body
      = paragraph(`「${p.workspaceName}」本期的 AI 回覆額度已用完（${usage}）。`)
      + paragraph('AI 已暫停自動回覆，之後的訊息會轉由真人客服處理，直到下一期額度重置或你升級方案。')
      + button('升級方案', p.manageUrl)
    return {
      subject,
      html: shell(p.brandName, 'AI 回覆額度已用完', body),
      text: ['AI 回覆額度已用完', `「${p.workspaceName}」本期的 AI 回覆額度已用完（${usage}）。`, 'AI 已暫停自動回覆，之後的訊息會轉由真人客服處理，直到下一期額度重置或你升級方案。', '', `升級方案：${p.manageUrl}`].join('\n'),
    }
  }
  const subject = `[${p.brandName}] 本期 AI 回覆額度即將用完`
  const body
    = paragraph(`「${p.workspaceName}」本期的 AI 回覆額度即將用完（已用 ${usage}）。`)
    + paragraph('額度用完後 AI 會暫停自動回覆、改由真人處理。若預期用量會超過，建議提前升級方案。')
    + button('查看方案', p.manageUrl)
  return {
    subject,
    html: shell(p.brandName, 'AI 回覆額度即將用完', body),
    text: ['AI 回覆額度即將用完', `「${p.workspaceName}」本期的 AI 回覆額度即將用完（已用 ${usage}）。`, '額度用完後 AI 會暫停自動回覆、改由真人處理。若預期用量會超過，建議提前升級方案。', '', `查看方案：${p.manageUrl}`].join('\n'),
  }
}
