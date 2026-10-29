import { describe, expect, it } from 'vitest'
import { diffSheetCardFields, quotedValueIn, replaceQuotedInMessages, replaceQuotedText } from './sheet-stale'
import { sheetFieldToken } from './sheet-field'

/**
 * `C-429`：試算表改了、模組還寫著改之前的原字。只認一字不差（空白不算）——⛔ 不用相似度猜。
 * 例子照 MYFEEL Giaretti 出貨進度那個模組真的字（2026-10-29 唯讀抄的）。
 */
const HEADERS = ['出貨時間', '商品頁面']
const OLD_SHIP = '依原廠公告：\n商品將於 10 月底 依照訂單順序陸續出貨，實際到貨時間仍需以廠商實際出貨日為準。'
const NEW_SHIP = '依原廠公告：\n第一批商品將於 10 月底 依照訂單順序陸續出貨，\n10/7號開始的訂單為第二批出貨，將於 11 月底 依照訂單順序陸續出貨，\n實際到貨時間仍需以廠商實際出貨日為準。'
const MODULE_TEXT = `{{displayName}}您好，\n\n${OLD_SHIP}\n\n感謝您的耐心等候。`

describe('哪幾格變了', () => {
  it('出貨時間改了、商品頁沒改：只列出貨時間', () => {
    const before = `出貨時間：${OLD_SHIP}\n商品頁面：https://a.example`
    const after = `出貨時間：${NEW_SHIP}\n商品頁面：https://a.example`
    expect(diffSheetCardFields('Giaretti', before, after, HEADERS, HEADERS)).toEqual([
      { row: 'Giaretti', field: '出貨時間', oldValue: OLD_SHIP, newValue: NEW_SHIP },
    ])
  })

  it('只差空白、換行＝沒改；舊的那格太短（不到 8 個字）不列——「現貨」這種到處都有', () => {
    expect(diffSheetCardFields('A', '出貨時間：現貨出貨', '出貨時間：預購', HEADERS, HEADERS)).toEqual([])
    expect(diffSheetCardFields('A', `出貨時間：${OLD_SHIP}`, `出貨時間：${OLD_SHIP.replace('\n', '')}`, HEADERS, HEADERS)).toEqual([])
  })

  it('還不知道欄名（上線前建的表）＝不列，不猜', () => {
    expect(diffSheetCardFields('A', `出貨時間：${OLD_SHIP}`, `出貨時間：${NEW_SHIP}`, null, undefined)).toEqual([])
  })
})

describe('模組有沒有還寫著舊字', () => {
  it('⭐ 一字不差（換行、空白不算）就算', () => {
    const msgs = [{ type: 'image' }, { type: 'quickReply', text: MODULE_TEXT.replace(/\n/g, ' ') }]
    expect(quotedValueIn(msgs, [OLD_SHIP])).toBe(OLD_SHIP)
  })

  it('⛔ 差一個字就不算（不用相似度猜）', () => {
    expect(quotedValueIn([{ text: MODULE_TEXT.replace('10 月底', '11 月底') }], [OLD_SHIP])).toBeNull()
  })

  it('⛔ 存檔時記的 sheetSnapshots 不算（那是試算表的字，不是店家手打的）', () => {
    expect(quotedValueIn([{ text: sheetFieldToken({ row: 'G', field: '出貨時間' }), sheetSnapshots: { x: OLD_SHIP } }], [OLD_SHIP])).toBeNull()
  })
})

describe('換成跟試算表同步', () => {
  it('⭐ 那段舊字（含中間的換行）換成膠囊，前後的字照舊', () => {
    const token = sheetFieldToken({ row: 'Giaretti', field: '出貨時間' })
    const r = replaceQuotedText(MODULE_TEXT, OLD_SHIP, token)
    expect(r.count).toBe(1)
    expect(r.text).toBe(`{{displayName}}您好，\n\n${token}\n\n感謝您的耐心等候。`)
  })

  it('原文多了空格換行也換得到；沒有就不動', () => {
    expect(replaceQuotedText('甲 依原廠公告： 商品將於 10 月底\n依照訂單順序陸續出貨，實際到貨時間仍需以廠商實際出貨日為準。乙', OLD_SHIP, 'X')).toEqual({ text: '甲 X乙', count: 1 })
    expect(replaceQuotedText('沒有那段', OLD_SHIP, 'X')).toEqual({ text: '沒有那段', count: 0 })
  })

  it('整個模組：每一段字都換（含按鈕）、⛔ 不動 sheetSnapshots，回傳換了幾處', () => {
    const msgs = [{ type: 'quickReply', text: MODULE_TEXT, quickReplies: [{ action: { label: '真人客服' } }] }, { type: 'text', text: OLD_SHIP, sheetSnapshots: { k: OLD_SHIP } }]
    const r = replaceQuotedInMessages(msgs, [OLD_SHIP], { row: 'Giaretti', field: '出貨時間' })
    expect(r.count).toBe(2)
    expect(r.messages[1]!.sheetSnapshots).toEqual({ k: OLD_SHIP })
    expect(quotedValueIn(r.messages, [OLD_SHIP])).toBeNull()
    expect(msgs[0]!.text).toBe(MODULE_TEXT) // 不就地改
  })
})
