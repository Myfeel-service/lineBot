/**
 * 泡泡裡的數字要跟確認卡對得上（`C-192` 第二輪）。
 *
 * 真實案例：使用者連調兩次提醒時間、一次確定都沒按，第二次的泡泡卻說
 * 「從 30 分鐘調整為 5 分鐘」——30 是它自己上一次提議、使用者沒答應的數字，
 * 而卡片上寫的是「等超過 60 分鐘就提醒 ── 現在」。
 */
import { describe, expect, it } from 'vitest'
import { numbersWithoutSource } from './agent-reply-numbers'

/** 提醒時間那張卡（現況 60、要改成 5） */
const SLA_CARD = [
  '我會改「客人被轉給真人之後，等多久還沒人回就提醒客服」。',
  '等超過 60 分鐘就提醒', '現在',
  '等超過 5 分鐘就提醒', '改成',
  '這只影響你們這邊收到的提醒，客人不會收到任何東西。',
  '確定改提醒時間',
]

/** 服務時間那張卡：卡片寫 24 小時制，模型常講成「晚上 11 點」 */
const HOURS_CARD = [
  '我會把服務時間改成下面這樣（勿擾時段就是服務時間以外的那段）。',
  '週一至週五 10:00–19:00', '現在（勿擾：19:00–10:00，以及週六、週日整天）',
  '週一至週五 09:00–23:00', '改成（勿擾：23:00–09:00，以及週六、週日整天）',
  '確定改時間',
]

describe('泡泡的數字有沒有出處', () => {
  it('🔴 實測踩到的那句：說「從 30 分鐘」，但卡片上的現況是 60', () => {
    expect(numbersWithoutSource('我會將提醒時間從 30 分鐘調整為 5 分鐘。', SLA_CARD)).toEqual([30])
  })

  it('照著卡片講就放行', () => {
    expect(numbersWithoutSource('我會把提醒時間從 60 分鐘改成 5 分鐘。', SLA_CARD)).toEqual([])
  })

  it('沒提到任何數字也放行（大多數提議都是這樣）', () => {
    expect(numbersWithoutSource('我會把「新增備註」這條自動回應停用。', SLA_CARD)).toEqual([])
  })

  it('⛔ 換算成白話的鐘點是好事，不可以擋：卡片 23:00 ↔ 泡泡「晚上 11 點」', () => {
    expect(numbersWithoutSource('我會將勿擾時段調整為晚上 11 點到早上 9 點。', HOURS_CARD)).toEqual([])
  })

  it('中文數字的鐘點也認得：「晚上十一點到早上九點」', () => {
    expect(numbersWithoutSource('勿擾時段改成晚上十一點到早上九點。', HOURS_CARD)).toEqual([])
  })

  it('🔴 但換算過頭就要擋：卡片沒有 8 點這回事', () => {
    expect(numbersWithoutSource('我會將勿擾時段調整為晚上 11 點到早上 8 點。', HOURS_CARD)).toEqual([8])
  })

  it('卡片上的內容原樣覆述不會被誤擋（推播草稿那種長文）', () => {
    const card = ['我會建一則推播草稿「中秋節公休通知」。', '親愛的顧客您好，9/28 至 10/1 公休。', '全部好友', '目前大約 6860 人（全部好友）']
    expect(numbersWithoutSource('我會建一則名為「中秋節公休通知」的草稿，內容是 9/28 至 10/1 公休。', card)).toEqual([])
  })

  it('🔴 中文數字寫的也要抓：「從三十分鐘調整為五分鐘」卡片上根本沒有 30', () => {
    expect(numbersWithoutSource('我會將提醒時間從三十分鐘調整為五分鐘。', SLA_CARD)).toEqual([30])
  })

  it('⛔ 中文數字要帶單位才算，否則「一次只能處理一個」會被誤判', () => {
    expect(numbersWithoutSource('我一次只能處理一個敏感詞的移除。', SLA_CARD)).toEqual([])
  })

  it('中文數字照著卡片講就放行', () => {
    expect(numbersWithoutSource('我會把提醒時間從六十分鐘改成五分鐘。', SLA_CARD)).toEqual([])
  })

  it('全形數字也算得出來', () => {
    expect(numbersWithoutSource('改成 ３０ 分鐘', SLA_CARD)).toEqual([30])
  })
})
