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
  /**
   * 信用卡帳單上的請款名稱（本平台＝`myfeel`，與品牌名不同）。
   * 留白則整列不出現——多租戶部署若未設定，寧可不講也不要講錯的名字。
   */
  statementName?: string
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
  // 帳單上的請款名稱與品牌不同。收據信是**離信用卡帳單最近的一份文件**——客戶月底對帳
  // 翻信箱就找得到這一行，是防爭議款最有效的一環（理由見 shared/billing/statement.ts）。
  // 折抵全額支付那期沒有向卡片請款，帳單不會出現任何一筆 → 講了只會造成混淆，故不放。
  if (!fullyCovered && p.statementName) rows.push(['信用卡帳單顯示', p.statementName])

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
    ...(!fullyCovered && p.statementName ? [`信用卡帳單顯示：${p.statementName}`] : []),
  ].join('\n')
  return { subject, html, text }
}

// ── 2. 扣款失敗 ─────────────────────────────────────────────
// `B-16`（2026-10-20）：以前只寫「以免方案到期後被降回免費層」——哪一天沒講，客人不知道要多急。
// 日期由 shared/billing/dunning.ts 的 graceDeadline 算，跟帳單頁黃色警示、實際降級同一把尺。
export function chargeFailedEmail(p: {
  brandName: string
  workspaceName: string
  planName: string
  manageUrl: string
  /** 寬限期最後一天（`10 月 23 日` 這種講法，呼叫端用 monthDayText 轉好） */
  lastDayText: string
  /** 這天起降回免費方案 */
  downgradeOnText: string
}): EmailContent {
  // ⛔ 刻意不把金流回的原文放進信裡：那串有時是我們自己的問題（例如 PAYUNi 回「不提供此IP幕後交易，<我們的 IP>」），
  //    寫進信裡會把內部 IP 寄給客人、還叫他換卡。真實原因在帳單頁與超管扣款失敗清單看得到。
  const subject = `[${p.brandName}] 自動扣款失敗，${p.lastDayText}前請換一張卡`
  const lines = [
    `「${p.workspaceName}」的 ${p.planName}方案這期自動扣款沒有成功（常見原因是信用卡過期或額度不足）。`,
    `服務照常可以用，我們每天會再試一次。到 ${p.lastDayText}還沒扣款成功，${p.downgradeOnText}起會降回免費方案。`,
  ]
  const body = lines.map(paragraph).join('') + button('換一張卡付款', p.manageUrl)
  const html = shell(p.brandName, '自動扣款失敗', body)
  const text = ['自動扣款失敗', ...lines, '', `換一張卡付款：${p.manageUrl}`].join('\n')
  return { subject, html, text }
}

// ── 2.5 已降回免費方案（寬限期滿還沒扣到）────────────────────
// `B-16`：以前降級之後什麼都不寄，客人是發現 AI 沒在回才知道。
// ⛔ 口徑要準：服務沒有停，是變成免費方案（每期 N 則 AI 回覆，數字由呼叫端讀方案表，不寫死）；
//    用完的後果跟額度信、AdminQuotaBanner 同一句（自動回應照常，需要 AI 回答的轉真人）。
export function downgradedEmail(p: {
  brandName: string
  workspaceName: string
  /** 降級前的方案 */
  planName: string
  /** 降級那天（`10 月 24 日`） */
  onText: string
  /** 免費方案每期 AI 回覆則數 */
  freeQuota: number
  manageUrl: string
}): EmailContent {
  const subject = `[${p.brandName}] 「${p.workspaceName}」已降回免費方案`
  const lines = [
    `「${p.workspaceName}」的 ${p.planName}方案自動扣款一直沒有成功，${p.onText}起已降回免費方案。我們不會再向這張卡扣款。`,
    `免費方案每期有 ${p.freeQuota.toLocaleString('en-US')} 則 AI 回覆；用完後需要 AI 回答的問題會轉給真人客服，自動回應不受影響。`,
    `想恢復 ${p.planName}方案，到後台重新訂閱就好。`,
  ]
  const body = lines.map(paragraph).join('') + button('重新訂閱', p.manageUrl)
  const html = shell(p.brandName, '已降回免費方案', body)
  const text = ['已降回免費方案', ...lines, '', `重新訂閱：${p.manageUrl}`].join('\n')
  return { subject, html, text }
}

// ── 2.6 寄信設定的測試信（超管自己按的，`B-50`）────────────────
// 只寄給按的那位超管：收得到＝寄件網域、SES 權限、寄件人設定都還活著。
export function testEmail(p: { brandName: string, sentAtText: string, from: string }): EmailContent {
  const subject = `[${p.brandName}] 寄信測試（${p.sentAtText}）`
  const lines = [
    `這是一封測試信，${p.sentAtText}從後台「異常總覽」寄出。收得到就代表帳務信（收據、扣款失敗、續扣提醒）寄得出去。`,
    `寄件人：${p.from}`,
  ]
  return {
    subject,
    html: shell(p.brandName, '寄信測試', lines.map(paragraph).join('')),
    text: ['寄信測試', ...lines].join('\n'),
  }
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

// ── 3.5 付款成功但約定卡沒綁成 ──────────────────────────────
// 2026-08-28 老闆拍板補的出口：這個狀態原本沒有任何主動通知（沒 LINE、沒 email），
// 而後果是「付了錢的客戶下期不會被扣款、會被靜默降回免費層」。每筆訂單只寄一次
// （冪等標記在訂單 doc 上，見 billing-emails.ts）。
// ⛔口徑要準：錢**收到了**、服務**正常**，壞的只有「下期的自動扣款」。寫成「付款有問題」
// 會嚇到人打電話來問這期是不是沒付成。
export function rebindCardEmail(p: {
  brandName: string
  workspaceName: string
  planName: string
  manageUrl: string
}): EmailContent {
  const subject = `[${p.brandName}] 付款已收到，但自動扣款尚未設定完成`
  const body
    = paragraph(`「${p.workspaceName}」的 ${p.planName}方案本期款項已收到，服務正常運作中。`)
    + paragraph('不過這次付款的信用卡沒有完成自動扣款的約定設定——下期不會自動扣款，方案到期後會被降回免費層。到後台重新設定一次付款方式，就會綁定完成。')
    + button('前往重新設定付款方式', p.manageUrl)
  const html = shell(p.brandName, '自動扣款尚未設定完成', body)
  const text = [
    '自動扣款尚未設定完成',
    `「${p.workspaceName}」的 ${p.planName}方案本期款項已收到，服務正常運作中。`,
    '不過這次付款的信用卡沒有完成自動扣款的約定設定——下期不會自動扣款，方案到期後會被降回免費層。到後台重新設定一次付款方式，就會綁定完成。',
    '',
    `重新設定付款方式：${p.manageUrl}`,
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
  // ⛔ 用完的後果要跟後台橫幅（AdminQuotaBanner）同一句：**自動回應照常**，只有需要 AI 回答的才轉真人。
  //    寫成「之後的訊息會轉由真人客服處理」＝誇大成全部轉真人，客戶一用就知道不是那樣（2026-10-17 全站對過）。
  if (p.kind === 'over') {
    const subject = `[${p.brandName}] 本期 AI 回覆額度已用完`
    const consequence = 'AI 已停止自動回覆。自動回應仍正常運作，但需要 AI 回答的問題現在都會轉給真人客服，直到下一期額度重置或你升級方案。'
    const body
      = paragraph(`「${p.workspaceName}」本期的 AI 回覆額度已用完（${usage}）。`)
      + paragraph(consequence)
      + button('升級方案', p.manageUrl)
    return {
      subject,
      html: shell(p.brandName, 'AI 回覆額度已用完', body),
      text: ['AI 回覆額度已用完', `「${p.workspaceName}」本期的 AI 回覆額度已用完（${usage}）。`, consequence, '', `升級方案：${p.manageUrl}`].join('\n'),
    }
  }
  const subject = `[${p.brandName}] 本期 AI 回覆額度即將用完`
  const consequence = '用完後需要 AI 回答的問題會改為轉給真人客服（自動回應不受影響）。若預期用量會超過，建議提前升級方案。'
  const body
    = paragraph(`「${p.workspaceName}」本期的 AI 回覆額度即將用完（已用 ${usage}）。`)
    + paragraph(consequence)
    + button('查看方案', p.manageUrl)
  return {
    subject,
    html: shell(p.brandName, 'AI 回覆額度即將用完', body),
    text: ['AI 回覆額度即將用完', `「${p.workspaceName}」本期的 AI 回覆額度即將用完（已用 ${usage}）。`, consequence, '', `查看方案：${p.manageUrl}`].join('\n'),
  }
}
