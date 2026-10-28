import { describe, expect, it } from 'vitest'
import { assertValidFlowMessages } from './flow-validator'

/**
 * 文字長度存檔就擋下來（`H-27`）——⛔ 不能只靠前端 `maxlength`，那只擋當下打的字。
 * `C-397`：掛按鈕的改走卡片送，上限跟純文字一樣 5000（以前按鈕範本只收 160）。
 */
const BUTTON = { type: 'uri', label: '點我看更多', uri: 'https://example.com' }

function save(messages: unknown[]) {
  return () => assertValidFlowMessages(messages)
}

describe('文字長度守門（存檔端）', () => {
  it('`C-397`：以前 160 字就擋的長文＋按鈕，現在存得起來', () => {
    expect(save([{ type: 'text', text: '飛'.repeat(161), buttons: [BUTTON] }])).not.toThrow()
    expect(save([{ type: 'text', text: '飛'.repeat(276), buttons: [BUTTON] }])).not.toThrow()
  })

  it('5000 字整＋按鈕可以存（差一個字就是誤擋）', () => {
    expect(save([{ type: 'text', text: '飛'.repeat(5000), buttons: [BUTTON] }])).not.toThrow()
  })

  it('5001 字有沒有按鈕都擋，並說得出現在幾字、要刪幾字', () => {
    expect(save([{ type: 'text', text: '飛'.repeat(5001), buttons: [BUTTON] }]))
      .toThrowError(/最多 5000 字.*目前 5001 字.*請刪掉 1 字/)
    expect(save([{ type: 'text', text: 'a'.repeat(5001) }])).toThrowError(/5000/)
  })

  it('錯誤句不再叫人「把按鈕移除」——那條出路已經不存在', () => {
    expect(save([{ type: 'text', text: '飛'.repeat(5001), buttons: [BUTTON] }])).not.toThrowError(/按鈕/)
  })

  it('emoji 佔兩格，跟 LINE 的算法一致（4999 個字＋一顆 emoji＝5001 格，要擋）', () => {
    expect(save([{ type: 'text', text: '飛'.repeat(4999) + '🎊', buttons: [BUTTON] }])).toThrow()
    expect(save([{ type: 'text', text: '飛'.repeat(4998) + '🎊', buttons: [BUTTON] }])).not.toThrow()
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
