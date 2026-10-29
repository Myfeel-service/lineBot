import { describe, expect, it } from 'vitest'
import {
  replaceSheetFieldTokens,
  sheetCardField,
  sheetFieldLabel,
  sheetFieldRefFromLabel,
  sheetFieldToken,
  sheetFieldTokensIn,
} from './sheet-field'
import { toDisplayText, toStoredText, VAR_TOKEN_EDGE, variableSegments, variableTokenRanges } from './variable-tokens'

/**
 * `C-423`：機器人模組帶出「試算表上某個商品的某一格」。
 * 卡片內文照 MYFEEL「客服（商品資訊）」那份試算表真的長相（2026-10-29 唯讀抄下來）。
 */
const HEADERS = ['出貨時間', '商品頁面', '額外資訊1', '額外資訊2']
const GIARETTI = [
  '出貨時間：依原廠公告：',
  '第一批商品將於 10 月底 依照訂單順序陸續出貨，',
  '10/7號開始的訂單為第二批出貨，將於 11 月底 依照訂單順序陸續出貨，',
  '實際到貨時間仍需以廠商實際出貨日為準。',
  '商品頁面：您好，',
  '',
  '以下提供商品頁面連結供您參考：',
  'https://www.myfeel-tw.com/projects/GL-5680',
].join('\n')

describe('從卡片切出某一欄', () => {
  it('⭐ 值跨好幾行、裡面自己也有「依原廠公告：」——切到下一個真的欄名為止', () => {
    expect(sheetCardField(GIARETTI, HEADERS, '出貨時間')).toBe([
      '依原廠公告：',
      '第一批商品將於 10 月底 依照訂單順序陸續出貨，',
      '10/7號開始的訂單為第二批出貨，將於 11 月底 依照訂單順序陸續出貨，',
      '實際到貨時間仍需以廠商實際出貨日為準。',
    ].join('\n'))
  })

  it('中間的空白行留著（店家排版用的），頭尾的不留', () => {
    expect(sheetCardField(GIARETTI, HEADERS, '商品頁面')).toBe('您好，\n\n以下提供商品頁面連結供您參考：\nhttps://www.myfeel-tw.com/projects/GL-5680')
  })

  it('「額外資訊1」不會被當成「額外資訊」那一欄的內容（長的欄名先比）', () => {
    const content = '額外資訊：A\n額外資訊1：B'
    expect(sheetCardField(content, ['額外資訊', '額外資訊1'], '額外資訊')).toBe('A')
    expect(sheetCardField(content, ['額外資訊', '額外資訊1'], '額外資訊1')).toBe('B')
  })

  it('這一列那一欄沒填（內文裡沒有那一行）＝null，不是空字串', () => {
    expect(sheetCardField(GIARETTI, HEADERS, '額外資訊1')).toBeNull()
  })

  it('表上沒有這一欄＝null', () => {
    expect(sheetCardField(GIARETTI, HEADERS, '價格')).toBeNull()
  })

  it('兩欄表（只有一個欄名）：整段就是那一欄', () => {
    expect(sheetCardField('7 個工作天內入帳', ['回答'], '回答')).toBe('7 個工作天內入帳')
  })
})

describe('存的格式 ↔ 膠囊', () => {
  const ref = { row: 'Giaretti 珈樂堤《小滑手》全自動義式咖啡機 GL-5680', field: '出貨時間' }

  it('列名稱裡有 | 或 } 也不會切錯', () => {
    const odd = { row: '上好ㄟ抽取式除濕機｜NWT|16L}}', field: '出貨時間' }
    expect(sheetFieldTokensIn(`前${sheetFieldToken(odd)}後`)).toEqual([{ token: sheetFieldToken(odd), ref: odd }])
  })

  it('膠囊上寫「列・欄」，換回來一樣；列名稱裡有「・」照樣切對（取最後一個）', () => {
    expect(sheetFieldLabel(ref)).toBe('Giaretti 珈樂堤《小滑手》全自動義式咖啡機 GL-5680・出貨時間')
    expect(sheetFieldRefFromLabel(sheetFieldLabel({ row: 'A・B 款', field: '出貨時間' }))).toEqual({ row: 'A・B 款', field: '出貨時間' })
    expect(sheetFieldRefFromLabel('沒有分隔')).toBeNull()
  })

  it('⭐ 輸入框來回換一次回到原樣（跟 LINE 名稱同一套），LINE 名稱不受影響', () => {
    const stored = `{{displayName}}您好，\n${sheetFieldToken(ref)}\n感謝您的耐心等候。`
    const display = toDisplayText(stored, 'send')
    expect(display).toContain(`${VAR_TOKEN_EDGE}${sheetFieldLabel(ref)}${VAR_TOKEN_EDGE}`)
    expect(display).not.toContain('{{')
    expect(toStoredText(display, 'send')).toBe(stored)
  })

  it('膠囊一顆是一個整體（游標跳過、退格整顆刪）', () => {
    const display = toDisplayText(`出貨：${sheetFieldToken(ref)}`, 'send')
    const ranges = variableTokenRanges(display, 'send')
    expect(ranges).toHaveLength(1)
    expect(ranges[0]!.key).toBe(sheetFieldToken(ref))
    expect(display.slice(ranges[0]!.start, ranges[0]!.end)).toBe(`${VAR_TOKEN_EDGE}${sheetFieldLabel(ref)}${VAR_TOKEN_EDGE}`)
  })

  it('自動回應（script）不認：那邊送出端換不掉，不可以畫成膠囊', () => {
    const stored = `出貨：${sheetFieldToken(ref)}`
    expect(toDisplayText(stored, 'script')).toBe(stored)
  })

  it('小幫手確認卡看到的也是「列・欄」，不是一串標記', () => {
    expect(variableSegments(`出貨：${sheetFieldToken(ref)}`, 'send')).toEqual([
      { text: '出貨：' },
      { text: sheetFieldLabel(ref), key: sheetFieldToken(ref) },
    ])
  })

  it('換字：每個標記都交給 replacer', () => {
    const out = replaceSheetFieldTokens(`A${sheetFieldToken(ref)}B${sheetFieldToken({ row: 'X', field: 'Y' })}`, r => `[${r.field}]`)
    expect(out).toBe('A[出貨時間]B[Y]')
  })
})
