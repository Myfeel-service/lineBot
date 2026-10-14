import { describe, expect, it } from 'vitest'
import { defaultAnsweredQueries, syncTickedQuestions } from './kb-suggestion-answered'

/**
 * 「這一條回答了哪幾題？」的預設勾選與「客人可能怎麼問」連動（`C-311`）。
 * 正式站「小滑手」那組：四題是同一個產品的不同問題，以前寫一條、按採用就整組消失。
 */
const ORIGIN = '請問一下小滑手咖啡機是哪一國做的？'
const ESPRESSO = '小滑手只能沖義式咖啡嗎？'
const FROTH = '小滑手咖啡機 能萃取咖啡液的同時打奶泡嗎'
const SIZE = '小滑手咖啡機 寬/深/高各多少'
const GROUP = [ORIGIN, ESPRESSO, FROTH, SIZE]

describe('defaultAnsweredQueries（預設勾哪幾題）', () => {
  it('認不出草稿是寫給哪一題的 → 只勾第一題（代表句），⛔ 不全勾', () => {
    expect(defaultAnsweredQueries(GROUP, ['小滑手是哪裡做的', '小滑手產地'])).toEqual([ORIGIN])
    expect(defaultAnsweredQueries(GROUP, null)).toEqual([ORIGIN])
  })

  it('AI 擬的問法原封不動用了某幾題 → 勾那幾題（空白、標點、全半形問號不算差別）', () => {
    expect(defaultAnsweredQueries(GROUP, ['小滑手只能沖義式咖啡嗎?', '小滑手咖啡機寬/深/高各多少'])).toEqual([ESPRESSO, SIZE])
  })

  it('問法認不出來、但 AI 擬的標題就是其中一題 → 勾那一題（正式站小滑手那組：標題＝「只能沖義式嗎」）', () => {
    expect(defaultAnsweredQueries(GROUP, null, '小滑手只能沖義式咖啡嗎？')).toEqual([ESPRESSO])
    expect(defaultAnsweredQueries(GROUP, [], ' 小滑手只能沖義式咖啡嗎 ')).toEqual([ESPRESSO])
    // 標題不是任何一題（AI 自己起的名字）→ 照舊勾第一題
    expect(defaultAnsweredQueries(GROUP, null, '小滑手的產地')).toEqual([ORIGIN])
    // 問法認得出來時以問法為準
    expect(defaultAnsweredQueries(GROUP, ['小滑手咖啡機寬/深/高各多少'], '小滑手只能沖義式咖啡嗎？')).toEqual([SIZE])
  })

  it('沒有題目 → 不勾', () => {
    expect(defaultAnsweredQueries([], ['x'])).toEqual([])
  })
})

describe('syncTickedQuestions（勾選一變，「客人可能怎麼問」跟著變）', () => {
  const AI = ['小滑手哪裡製造', '小滑手產地', '小滑手是台灣做的嗎']

  it('開視窗：AI 擬的 3 條已滿 → 預設勾的那題換掉最後一條 AI 擬的', () => {
    expect(syncTickedQuestions(AI, [], [ORIGIN])).toEqual(['小滑手哪裡製造', '小滑手產地', ORIGIN])
  })

  it('沒有草稿：問法只放勾的題目，⛔ 沒勾的客人原句不會跑進來', () => {
    expect(syncTickedQuestions([], [], [ORIGIN])).toEqual([ORIGIN])
  })

  it('再勾一題：換掉下一條 AI 擬的，已經勾的那題不會被換掉', () => {
    const opened = syncTickedQuestions(AI, [], [ORIGIN])
    expect(syncTickedQuestions(opened, [ORIGIN], [ORIGIN, SIZE])).toEqual(['小滑手哪裡製造', SIZE, ORIGIN])
  })

  it('取消勾：那題從問法拿掉（留著＝這一條宣稱回答了他說沒回答的題目）', () => {
    expect(syncTickedQuestions(['小滑手哪裡製造', SIZE, ORIGIN], [ORIGIN, SIZE], [ORIGIN])).toEqual(['小滑手哪裡製造', ORIGIN])
  })

  it('三條都是勾的題目 → 再勾的不再塞（最多 3 條），也不擠掉已勾的', () => {
    expect(syncTickedQuestions([ORIGIN, ESPRESSO, FROTH], [ORIGIN, ESPRESSO, FROTH], GROUP)).toEqual([ORIGIN, ESPRESSO, FROTH])
  })

  it('他自己從下拉拿掉的勾選題目，勾別題時不會被塞回來', () => {
    // ORIGIN 還勾著、但他把它從問法刪了；這次只新勾 SIZE
    expect(syncTickedQuestions(['小滑手哪裡製造'], [ORIGIN], [ORIGIN, SIZE])).toEqual(['小滑手哪裡製造', SIZE])
  })
})
