import { describe, expect, it } from 'vitest'
import { isShipTimingQuestion, isSingleProductContext } from './ship-timing-question'

describe('isSingleProductContext：只認得出一個商品才算', () => {
  it('一台＝是；沒有、兩台以上（「咖啡機」對到小滑手和 iBarista）＝不是', () => {
    expect(isSingleProductContext({ products: new Set(['chimei 電淨艙']) })).toBe(true)
    expect(isSingleProductContext({ products: new Set(['小滑手', 'ibarista']) })).toBe(false)
    expect(isSingleProductContext({ products: new Set() })).toBe(false)
    expect(isSingleProductContext(null)).toBe(false)
  })
})

/**
 * 句子全部取自 MYFEEL 正式站 2026-08-07～10-18「查詢訂單」流程被觸發的那一句（唯讀盤點，`C-343`）。
 * 認得出來的會繞過流程交給 AI 答出貨時程；認不出來的照舊。
 */
describe('isShipTimingQuestion：純粹問「什麼時候出貨」', () => {
  it.each([
    '訂單編號：M20261006142003LDEW，奇美電淨艙雙入組，請問何時才能出貨？',
    '請問這個什麼時候會寄貨？',
    '請問7/31購買的BOYA mini什麼時候會發貨呢？ 訂單編號：M20260731154815HRYK',
    '請問有購買的咖啡機何時會出貨',
    '訂單品項：\nKIESLECT小耳記-超早鳥單入組\n訂單編號：M20260905100035ZPGM\n\n詢問出貨日期',
    '咖啡機訂單編號M20261011191817ADNO\n請問什麼時候會出貨，謝謝',
    '請問9/7有訂 清淨方 max. 機種。想請問什麼時候出貨？',
    '訂單查詢M20261002143835LF7Z\n\n請問大約出貨日期',
  ])('會認：%s', (text) => {
    expect(isShipTimingQuestion(text)).toBe(true)
  })

  it.each([
    // 延遲／抱怨＝這一筆可能出狀況，要人查
    '都10月了,還沒出貨！請問要等到什麼時候？？？？？？',
    '我有訂麥克風2週了\n怎麼還沒收到貨',
    '8/16下單boya\n有看到是現貨會在週五出貨\n至今未收到商品',
    '我訂了珈樂堤小滑手 10/4的訂單\n訂購時網站上顯示10底前陸續出貨 現在變成11月底照訂單順序出貨 這是怎麼回事？',
    '請問～\n10月底？\n正確到底是何時？\n請儘速回覆',
    // 問的是時程，但其實是帳號／通知出了狀況
    '您好。我之前在平台下單超早鳥，昨日上帳號要查詢商品何時出貨，可是竟然找不到購買紀錄？',
    '我有訂購Boya mini2麥可風，已經週六了，請問何時會收到？而且沒有通知出貨，只有銀行有付款ㄊㄨ',
    // 同一句要改單／取消／延後：走它自己的流程
    '我有參加乾淨方Max的預購 但我沒有注意到出貨時間可能我不在台灣 是否可以延後這筆訂單出貨時間',
    '還沒出貨的話可以取消嗎？出貨大概什麼時候',
    // 不是在問時程
    '請問出貨進度',
    '我要查訂單',
    '請問要怎麼取消訂單',
    'M20261007002452KOYK訂單編號\n名字白坤永\n電話0982085948',
  ])('不認：%s', (text) => {
    expect(isShipTimingQuestion(text)).toBe(false)
  })
})
