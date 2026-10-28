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

/**
 * `C-398`（`D-153` ⑵）：卡片訊息（以前叫輪播訊息）內文 300→1000，整組太大存檔就擋
 * （LINE 輪播整組 50 KB，超過會把整個請求退回）。
 */
describe('卡片訊息', () => {
  const col = (over: Record<string, unknown> = {}) => ({
    imageUrl: 'https://a.example.com/hero.jpg', title: '新品', text: '內文', action: { type: 'none' },
    actions: [{ type: 'uri', label: '去看看', uri: 'https://a.example.com', style: 'primary' }], ...over,
  })
  const cardMsg = (columns: unknown[]) => [{ type: 'flexImageCarousel', enableImage: true, columns }]

  it('內文 1000 字可以存、1001 字擋（說得出目前幾字）', () => {
    expect(save(cardMsg([col({ text: '飛'.repeat(1000) })]))).not.toThrow()
    expect(save(cardMsg([col({ text: '飛'.repeat(1001) })]))).toThrowError(/卡片訊息：內文最多 1000 字（目前 1001 字）/)
  })

  it('超過舊上限 300 字的內文現在存得進去', () => {
    expect(save(cardMsg([col({ text: '飛'.repeat(301) })]))).not.toThrow()
  })

  it('十張都塞滿 1000 字＋長網址：整組太大，存檔擋下並講怎麼辦', () => {
    const longUri = `https://a.example.com/${'x'.repeat(600)}`
    const full = col({ text: '飛'.repeat(1000), actions: Array(3).fill({ type: 'uri', label: '按', uri: longUri }) })
    expect(save(cardMsg(Array(10).fill(full)))).toThrowError(/LINE 收不下.*減少張數/)
  })

  it('`H-43`：開了貼標的「傳送文字」太長（LINE 放不下）存檔就擋，並指出是哪一顆', () => {
    const tag = '002555ba-3b6a-4908-a3ea-2703aa0b36c0'
    const btn = (text: string) => ({ type: 'message', label: '我要參加', text, tagging: { enabled: true, addTagIds: [tag] } })
    expect(save(cardMsg([col({ actions: [btn('我'.repeat(250))] })]))).toThrowError(/按鈕「我要參加」：開了貼標的「傳送文字」最多約/)
    expect(save([{ type: 'text', text: '嗨', buttons: [btn('我'.repeat(250))] }])).toThrowError(/最多約/)
    // 以前大約 20 個中文字就會整則被退，現在放得下
    expect(save([{ type: 'text', text: '嗨', buttons: [btn('我'.repeat(100))] }])).not.toThrow()
  })

  it('錯誤訊息用新名字（「卡片訊息」「張卡」），舊版範本輪播叫「輪播（舊）」', () => {
    expect(save(cardMsg([]))).toThrowError(/卡片訊息：至少要有 1 張卡/)
    expect(save([{ type: 'carousel', columns: [] }])).toThrowError(/輪播（舊）：至少要有 1 個欄位/)
  })
})
