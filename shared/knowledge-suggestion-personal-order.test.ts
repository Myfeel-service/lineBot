/**
 * 「查他自己那一筆」的問題不列進「AI 建議補的知識」（`C-318`）。
 * 例句都是正式站（MYFEEL）客人的原話；要擋的、不能擋的兩串都要過——擋錯的代價是一個真缺口從此看不到。
 */
import { describe, expect, it } from 'vitest'
import { isPersonalOrderGroup, isPersonalOrderQuery } from './knowledge-suggestion-personal-order'

/** 要真人去查那一筆，補知識答不了 */
const PERSONAL = [
  '請問這張訂單的付款狀態是？',
  '請問這張訂單的付款完成了嗎？',
  '您好請問有消息嗎？從一開始反應到現在都過半年了', // 訂單出貨進度，催單
  '請問這筆訂單什麼時候會出貨？',
  '我的訂單為什麼被取消了？',
  '已申請退貨，咖啡機貴公司也已收回，請問是否已退款',
  '我的包裹到哪了',
  '怎麼還沒收到貨',
  '請問退款進度',
  '單號 A12345 寄出了嗎',
]

/** 一般的商品／規則問題：補一條就答得出來，⛔ 不能擋 */
const GENERAL = [
  '請問這個方案還有名額嗎？',
  '收到鍋子有瑕疵，很多白色掉漆', // 退換貨規則是通用的
  '早鳥價8990元還有嗎？',
  '怎麼購買',
  '請問這筆訂單可以取消嗎？', // 怎麼取消寫得出一條
  '請問我要如何知道我的發票號碼去登記退稅。',
  '請問 奇美電淨艙 下訂後 什麼時候可以出貨？', // 還沒下單，問的是一般出貨時程
  '請問下訂後多久會收到？',
  '7月底已經請貨運收回，何時會退款給我呢？', // 退款排程寫得出一條
  '鍋子底部有刮傷可以退貨嗎？',
  '我買的鍋子有瑕疵怎麼退', // 有「我買的」，但問的是規則
  '我買的除濕機燈號狀態一直閃', // 有「我買的」＋「狀態」，講的是機器不是訂單
  '請問出貨進度？', // 募資常見，答案是一則公告
  '請問新品有消息嗎？', // 沒講等了多久，不是催單
  '如果還沒收到貨可以退款嗎', // 假設語氣＝問規則
  '請問訂單進度要去哪裡查',
  '請問有實體店 試喝看看嗎？',
  '小滑手咖啡機有保固嗎',
]

describe('isPersonalOrderQuery', () => {
  it.each(PERSONAL)('擋：%s', (q) => {
    expect(isPersonalOrderQuery(q)).toBe(true)
  })
  it.each(GENERAL)('不擋：%s', (q) => {
    expect(isPersonalOrderQuery(q)).toBe(false)
  })
  it('空的、只有空白的不算', () => {
    expect(isPersonalOrderQuery('')).toBe(false)
    expect(isPersonalOrderQuery('   ')).toBe(false)
    expect(isPersonalOrderQuery(undefined as unknown as string)).toBe(false)
  })
})

describe('isPersonalOrderGroup：超過一半的題目是查單才整組不列', () => {
  it('全部是查單 → 不列', () => {
    expect(isPersonalOrderGroup(['請問這張訂單的付款狀態是？', '請問這張訂單的付款完成了嗎？'])).toBe(true)
  })
  it('剛好一半 → 照列（拿不準就列）', () => {
    expect(isPersonalOrderGroup(['請問這張訂單的付款狀態是？', '請問可以用網路銀行轉帳嗎？'])).toBe(false)
  })
  it('一題查單混兩題一般問題 → 照列（照題數算，不照次數）', () => {
    expect(isPersonalOrderGroup(['我的包裹到哪了', '早鳥價8990元還有嗎？', '怎麼購買'])).toBe(false)
  })
  it('三題裡兩題查單 → 不列', () => {
    expect(isPersonalOrderGroup(['我的包裹到哪了', '怎麼還沒收到貨', '怎麼購買'])).toBe(true)
  })
  it('沒有題目 → 照列', () => {
    expect(isPersonalOrderGroup([])).toBe(false)
    expect(isPersonalOrderGroup(undefined)).toBe(false)
  })
})
