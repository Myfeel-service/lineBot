import { describe, expect, it } from 'vitest'
import { tokenizeForTyping } from './bubble-typing'

/**
 * 只測切字（純函式）。拆 DOM 那半段沒有 jsdom 可測（vitest 這個專案跑 node 環境），
 * 改用瀏覽器實測：泡泡拆字前後的**盒模型尺寸必須一模一樣**，否則就是斷行被改掉了。
 */
describe('tokenizeForTyping', () => {
  it('中文一個字一顆', () => {
    expect(tokenizeForTyping('免費完成')).toEqual(['免', '費', '完', '成'])
  })

  it('拉丁字母與數字連在一起算一顆（拆開會在字母中間斷行）', () => {
    expect(tokenizeForTyping('多一個 MiniMe')).toEqual(['多', '一', '個', ' ', 'MiniMe'])
    expect(tokenizeForTyping('只要 60 秒')).toEqual(['只', '要', ' ', '60', ' ', '秒'])
  })

  it('價格整串不拆（NT$399 斷成 NT$／399 兩行就毀了）', () => {
    expect(tokenizeForTyping('NT$1,499')).toEqual(['NT$1,499'])
    expect(tokenizeForTyping('一個月 NT$399 起')).toEqual(['一', '個', '月', ' ', 'NT$399', ' ', '起'])
  })

  it('中文標點自成一顆', () => {
    expect(tokenizeForTyping('卡在這四關。')).toEqual(['卡', '在', '這', '四', '關', '。'])
  })

  it('空白自成一顆，不會被吃掉——拼回去要跟原文一模一樣', () => {
    for (const text of ['多一個 MiniMe，等於多了半個客服、半個行銷。', '只要 60 秒，免費完成上線設定。', '  前後留白  ']) {
      expect(tokenizeForTyping(text).join('')).toBe(text)
    }
  })

  it('空字串不會回傳 [null] 之類的東西', () => {
    expect(tokenizeForTyping('')).toEqual([])
  })
})
