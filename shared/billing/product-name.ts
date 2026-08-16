// ═══════════════════════════════════════════════════════════════════
//  商品名稱（單一事實來源）
//
//  信用卡收單的風控會拿三處互相核對：**官網商品資訊 / 付款頁商品描述 / 電子發票品名**。
//  2026-08-16 逐字比對發現三處各寫各的（官網「LINE MiniMe AI CRM 與客服系統」、
//  付款頁「MiniMe 輕量方案(1 個月)」、發票「MiniMe 輕量方案 訂閱服務」）——
//  對不起來，而且 nuxt.config 自己的註解還寫著「必須逐字一致」。
//
//  ── 定的規則：主體逐字一致，括號各自補充 ────────────────────────────
//  三處開頭都是**已向金流申報的商品名稱**（serviceFullName），核對的人一眼對得起來；
//  括號裡才放各自需要的交易條件（付款頁要講扣款方式、發票要講服務期間）——
//  那是交易條件不是商品，不需要也不應該一致。
//
//  ⚠️ 申報名稱本身不可隨意更動：改了要向 PAYUNi 重新報備。
//  ⚠️ 發票品名**開出去就改不掉**（光貿與財政部都不允許事後更正品名），
//     所以這裡的格式要一次定對。
// ═══════════════════════════════════════════════════════════════════

/** 商品主體＝向金流申報的商品名稱；未設定時退回品牌名，永遠不會是空字串。 */
function subject(serviceFullName: string, brandName: string): string {
  return String(serviceFullName || '').trim() || String(brandName || '').trim() || 'MiniMe'
}

/**
 * PAYUNi 付款頁的商品描述（`ProdDesc`）。
 * 客戶在付款頁與信用卡帳單明細上看到的就是這一行。
 */
export function checkoutProductName(p: {
  serviceFullName: string
  brandName: string
  planName: string
  /** 是否為「首刷並建立每月自動扣款約定」——要在名稱裡講清楚，這是同意的一部分。 */
  recurring: boolean
}): string {
  const tail = p.recurring ? '每月自動扣款' : '1 個月'
  return `${subject(p.serviceFullName, p.brandName)}｜${p.planName}方案（${tail}）`
}

/**
 * 電子發票品名。
 * 一律寫服務期間（1 個月），**不寫「每月自動扣款」**——發票是「這一期」的憑證，
 * 每期各開一張，把扣款方式寫進品名會讓每張發票看起來像在收未來的錢。
 */
export function invoiceProductName(p: {
  serviceFullName: string
  brandName: string
  planName: string
}): string {
  return `${subject(p.serviceFullName, p.brandName)}｜${p.planName}方案（1 個月）`
}
