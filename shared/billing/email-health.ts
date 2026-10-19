// ═══════════════════════════════════════════════════════════════════
//  寄信設定壞了沒（純函式，超管異常總覽＋側欄點共用；`B-50`）
//
//  所有帳務信（收據、扣款失敗、續扣提醒、額度、綁卡提醒、已降回免費）都走同一個寄信出口，
//  它設計成「寄失敗不拖累金流」→ 壞掉時金流一切正常、只有信沒寄出去，以前沒有任何地方看得到。
// ═══════════════════════════════════════════════════════════════════

/** 端點回給前端的寄信狀態（server/utils/email.ts readEmailDeliveryHealth ＋付款開關）。 */
export interface EmailHealthInput {
  configured: boolean
  from: string
  region: string
  /** 付款有沒有開。沒開就沒有帳務信要寄，沒設定不算壞 */
  paymentEnabled: boolean
  lastSuccessAt: number | null
  lastSuccessSubject: string | null
  lastFailureAt: number | null
  lastFailureSubject: string | null
  lastFailureError: string | null
}

export type EmailHealthState = 'ok' | 'broken' | 'unsent' | 'off'

/**
 * - broken：付款開著卻沒設定齊（每封帳務信都寄不出去），或最近一次寄信是失敗的
 * - unsent：設定齊了、但從沒寄出過（不知道通不通——按「寄一封測試信給我」）
 * - off：付款沒開、也沒設定（本機／還沒上線）→ 不亮點
 * - ok：最近一次寄信是成功的
 *
 * 「最近一次」比的是時間：成功之後又失敗＝壞了；失敗之後又成功＝好了（重試寄出去了）。
 */
export function emailHealthState(h: EmailHealthInput): EmailHealthState {
  if (!h.configured) return h.paymentEnabled ? 'broken' : 'off'
  if (h.lastFailureAt && (!h.lastSuccessAt || h.lastFailureAt > h.lastSuccessAt)) return 'broken'
  if (!h.lastSuccessAt) return 'unsent'
  return 'ok'
}
