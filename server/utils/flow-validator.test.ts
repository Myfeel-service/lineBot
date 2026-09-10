import { describe, expect, it } from 'vitest'
import { assertValidFlowMessages } from './flow-validator'

/**
 * `H-27`：文字掛按鈕時 LINE 只收 160 字，超過的部分送出時被切掉。
 * 這裡釘住「存檔就擋下來」——⛔ 不能只靠前端 `maxlength`，那只擋當下打的字，
 * 先貼長文再加按鈕就整條繞過去（正式資料 5 則模組就是這樣存進去的）。
 */
const LONG = '飛'.repeat(200)
const BUTTON = { type: 'uri', label: '點我看更多', uri: 'https://example.com' }

function save(messages: unknown[]) {
  return () => assertValidFlowMessages(messages)
}

describe('文字長度守門（存檔端）', () => {
  it('長文＋按鈕 → 擋下來，並說得出現在幾字、要刪幾字', () => {
    expect(save([{ type: 'text', text: LONG, buttons: [BUTTON] }]))
      .toThrowError(/目前 200 字.*請刪掉 40 字/)
  })

  it('同一段長文，把按鈕拿掉就存得起來（上限是被按鈕帶下來的）', () => {
    expect(save([{ type: 'text', text: LONG, buttons: [] }])).not.toThrow()
    expect(save([{ type: 'text', text: LONG }])).not.toThrow()
  })

  it('160 字整＋按鈕可以存（差一個字就是誤擋，行銷會被卡在門外）', () => {
    expect(save([{ type: 'text', text: '飛'.repeat(160), buttons: [BUTTON] }])).not.toThrow()
  })

  it('161 字＋按鈕擋下來', () => {
    expect(save([{ type: 'text', text: '飛'.repeat(161), buttons: [BUTTON] }])).toThrow()
  })

  it('純文字超過 5000 字也要擋（原本這條路一樣是無聲截斷）', () => {
    expect(save([{ type: 'text', text: 'a'.repeat(5001) }])).toThrowError(/5000/)
  })

  it('emoji 佔兩格，跟 LINE 的算法一致（159 個字＋一顆 emoji＝161 格，要擋）', () => {
    expect(save([{ type: 'text', text: '飛'.repeat(159) + '🎊', buttons: [BUTTON] }])).toThrow()
    expect(save([{ type: 'text', text: '飛'.repeat(158) + '🎊', buttons: [BUTTON] }])).not.toThrow()
  })
})

describe('原本就有的檢查沒有被我改壞', () => {
  it('空白文字仍然擋', () => {
    expect(save([{ type: 'text', text: '   ' }])).toThrowError(/不可為空/)
  })

  it('按鈕沒填標題仍然擋', () => {
    expect(save([{ type: 'text', text: '嗨', buttons: [{ type: 'uri', uri: 'https://a.b' }] }]))
      .toThrowError(/請輸入按鈕標題/)
  })

  it('按鈕超過 4 顆仍然擋，而且先報按鈕數不報字數（訊息長度沒問題時不該亂扯）', () => {
    expect(save([{ type: 'text', text: '嗨', buttons: Array(5).fill(BUTTON) }]))
      .toThrowError(/按鈕最多 4 個/)
  })

  it('正常的一則照樣過', () => {
    expect(save([{ type: 'text', text: '嗨，這是一則正常的訊息', buttons: [BUTTON] }])).not.toThrow()
  })
})
