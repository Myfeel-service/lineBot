/**
 * 客人只丟訂單資料、沒說要做什麼 → 先問他想詢問什麼（`D-133`）。
 * 句子都是正式站真的出現過的形狀（編號、姓名、電話已換掉或照當時格式）。
 */
import { describe, expect, it } from 'vitest'
import {
  ORDER_INFO_ASK_TTL_MS,
  ORDER_INFO_HUMAN_OPTION,
  ORDER_INFO_MODIFY_OPTION,
  ORDER_INFO_SHIP_OPTION,
  isOrderInfoOnly,
  orderInfoAskOptions,
  shouldAskOrderIntent,
  type OrderInfoRecentMessage,
} from './order-info-only'
import { isShipTimingQuestion } from './ship-timing-question'
import { HUMAN_REQUEST_TEXTS } from './types/ai-script'

/** 10/09 客人「白」打的那一則（三行） */
const BAI = 'M20261007002452KOYK訂單編號\n名字白坤永\n電話0982085948'

describe('只有資料、沒有問題', () => {
  it('10/09 客人「白」那則（編號＋姓名＋電話，三行）→ 是', () => {
    expect(isOrderInfoOnly(BAI)).toBe(true)
  })

  it('只貼一串訂單編號 → 是', () => {
    expect(isOrderInfoOnly('M20261007002452KOYK')).toBe(true)
  })

  it('加了客氣話（麻煩了／謝謝）還是沒講要做什麼 → 是', () => {
    expect(isOrderInfoOnly('訂單編號：M20261006142003LDEW 王小明 0912345678 麻煩了 謝謝')).toBe(true)
  })

  it.each([
    ['問出貨時間', '訂單編號：M20261006142003LDEW，請問何時才能出貨？'],
    ['要改地址', 'M20261006142003LDEW 地址要改成台北市信義路'],
    ['要取消', 'M20261006142003LDEW 取消'],
    ['還沒收到', 'M20261006142003LDEW 王小明 還沒收到貨'],
    ['問句沒有問號', 'M20261006142003LDEW 想確認一下出貨'],
  ])('有講要做什麼（%s）→ 不是，照舊走流程或 AI', (_why, text) => {
    expect(isOrderInfoOnly(text)).toBe(false)
  })

  it('沒有訂單編號這種長代碼（只有電話、姓名）→ 不是：可能是預約、會員資料，不能確定是訂單的事', () => {
    expect(isOrderInfoOnly('王小明 0912345678')).toBe(false)
  })

  it('型號（數字少）、日期不算訂單編號', () => {
    expect(isOrderInfoOnly('AP-08SPFG')).toBe(false)
    expect(isOrderInfoOnly('2026-10-07')).toBe(false)
  })
})

describe('按鈕送出的字要讓後面的分流認得', () => {
  it('「什麼時候出貨」那顆＝出貨時程題（C-343）；⛔ 寫成「出貨進度」就不算', () => {
    expect(isShipTimingQuestion(ORDER_INFO_SHIP_OPTION.text)).toBe(true)
    expect(isShipTimingQuestion('想查出貨進度')).toBe(false)
  })

  it('「找真人」那顆送出的是轉真人攔截認得的字（⛔ 不是只有二次確認才認得的「轉接專員」）', () => {
    expect(HUMAN_REQUEST_TEXTS.has(ORDER_INFO_HUMAN_OPTION.text)).toBe(true)
  })

  it('三顆按鈕送出的字自己都不會再被當成「只丟資料」', () => {
    for (const o of [ORDER_INFO_SHIP_OPTION, ORDER_INFO_MODIFY_OPTION, ORDER_INFO_HUMAN_OPTION]) {
      expect(isOrderInfoOnly(o.text)).toBe(false)
      expect(o.label.length).toBeLessThanOrEqual(20) // LINE 快速回覆按鈕字數上限
    }
  })

  it('做服務／教課的店不放「什麼時候出貨」', () => {
    expect(orderInfoAskOptions(true).map(o => o.label)).toEqual(['什麼時候出貨', '修改訂單資料', '🙋 找真人'])
    expect(orderInfoAskOptions(false).map(o => o.label)).toEqual(['修改訂單資料', '🙋 找真人'])
  })
})

describe('要不要問：已經知道他要做什麼的時候不問', () => {
  const NOW = Date.parse('2026-10-09T02:37:10Z')
  const S = 1000
  const ask = (recent: OrderInfoRecentMessage[], lastAskAtMs: number | null = null, text = BAI) =>
    shouldAskOrderIntent({ text, recent, nowMs: NOW, lastAskAtMs })

  /** 10/09 那場：先點「出貨進度查詢 → 電淨艙」、機器人回「10 月底出貨」，45 秒後打資料（新的在前，含這一則本身） */
  const BAI_RECENT: OrderInfoRecentMessage[] = [
    { direction: 'incoming', messageType: 'text', text: BAI, timestampMs: NOW },
    { direction: 'outgoing', messageType: 'text', text: '白您好，\n\n依原廠公告：\n商品將於 10 月底 依照訂單順序陸續出貨', timestampMs: NOW - 45 * S },
    { direction: 'incoming', messageType: 'customer_action', text: '客人點了「客服 - 出貨進度查詢 - 電淨艙 奇美 靜電集塵空氣清淨機 AP-08SPFG」', timestampMs: NOW - 48 * S },
    { direction: 'outgoing', messageType: 'flex', text: '白您好，由於平台商品項目較多，煩請提供您欲詢問的商品名稱或相關資訊。', timestampMs: NOW - 51 * S },
  ]

  it('10/09 那場 → 問', () => {
    expect(ask(BAI_RECENT)).toBe(true)
  })

  it('2 小時內問過了 → 不再問（他又丟一次資料，不要一直問）', () => {
    expect(ask(BAI_RECENT, NOW - 30 * 60 * S)).toBe(false)
    expect(ask(BAI_RECENT, NOW - ORDER_INFO_ASK_TTL_MS - S)).toBe(true)
  })

  it('上一句就是在跟他要資料（「請問您的訂單編號是？」）→ 不問，這筆是答案', () => {
    expect(ask([
      { direction: 'incoming', messageType: 'text', text: BAI, timestampMs: NOW },
      { direction: 'outgoing', messageType: 'text', text: '您好,請問您的訂單編號是？', timestampMs: NOW - 5 * 60 * S },
    ])).toBe(false)
  })

  it('真人問「煩請提供您的訂單資訊」、客人隔天才貼上來 → 還是在回答，不問（正式站常見）', () => {
    expect(ask([
      { direction: 'incoming', messageType: 'text', text: BAI, timestampMs: NOW },
      { direction: 'outgoing', messageType: 'text', text: '您好， 煩請提供您的訂單資訊以便我們協助查詢： 1. 訂單編號 2. 姓名', timestampMs: NOW - 20 * 60 * 60 * S },
    ])).toBe(false)
  })

  it('流程說「訂單編號格式好像不太對,請再確認一次喔！」→ 這筆是重給的答案，不問', () => {
    expect(ask([
      { direction: 'incoming', messageType: 'text', text: 'M20261007002452KOYK', timestampMs: NOW },
      { direction: 'outgoing', messageType: 'text', text: '訂單編號格式好像不太對,請再確認一次喔！', timestampMs: NOW - 30 * S },
    ], null, 'M20261007002452KOYK')).toBe(false)
  })

  it('要資料那句是三天多以前的 → 算新的一件事，問', () => {
    expect(ask([
      { direction: 'incoming', messageType: 'text', text: BAI, timestampMs: NOW },
      { direction: 'outgoing', messageType: 'text', text: '您好,請問您的訂單編號是？', timestampMs: NOW - 73 * 60 * 60 * S },
    ])).toBe(true)
  })

  it('他自己 10 分鐘內打過「我要改地址」→ 不問，這筆是在補充那件事', () => {
    expect(ask([
      { direction: 'incoming', messageType: 'text', text: BAI, timestampMs: NOW },
      { direction: 'outgoing', messageType: 'text', text: '好的，我們會協助您', timestampMs: NOW - 60 * S },
      { direction: 'incoming', messageType: 'text', text: '我要改地址', timestampMs: NOW - 90 * S },
    ])).toBe(false)
  })

  it('他前面只說「你好」→ 還是沒講要做什麼，問', () => {
    expect(ask([
      { direction: 'incoming', messageType: 'text', text: BAI, timestampMs: NOW },
      { direction: 'incoming', messageType: 'text', text: '你好', timestampMs: NOW - 20 * S },
    ])).toBe(true)
  })

  it('這一句本身有意圖 → 不問（不靠前文）', () => {
    expect(ask(BAI_RECENT, null, 'M20261007002452KOYK 請問何時出貨')).toBe(false)
  })
})
