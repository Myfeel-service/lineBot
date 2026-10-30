import { describe, expect, it } from 'vitest'
import { fillCurrentProductText, fillSheetCurrentProduct, usesCurrentProductDeep, type SheetCurrentProduct } from './sheet-current-product'
import {
  SHEET_CURRENT_ROW,
  SHEET_FIELD_IMAGE,
  SHEET_FIELD_NAME,
  buildSheetLabelRegistry,
  sheetFieldLabel,
  sheetFieldRefFromLabel,
  sheetFieldToken,
} from './sheet-field'
import { toDisplayText, toStoredText } from './variable-tokens'

/**
 * `C-437` 商品資訊範本：一份回覆給所有商品，客人點了哪個商品就填那個商品的格子。
 * 釘五件事：
 *   ① 膠囊叫「出貨時間・這個商品」「商品名・這個商品」，存的格式跟膠囊換得回來
 *   ② ⭐ 空白的格子：那一行整行不顯示，連著的空行收成一行；其他行一字不改
 *   ③ 網址按鈕：取格子裡第一個 https 網址；取不到＝那顆按鈕不顯示
 *   ④ 這個商品沒有圖＝改回不帶圖（標題一起拿掉）；整則被拿光＝不送
 *   ⑤ 沒有「這個商品」（不是從目錄點進來的）＝那幾行都不顯示；⛔ 列名寫死的格子不動
 */

const at = (field: string) => sheetFieldToken({ row: SHEET_CURRENT_ROW, field })
const NAME = at(SHEET_FIELD_NAME)
const IMAGE = at(SHEET_FIELD_IMAGE)
const SHIP = at('出貨時間')
const EXTRA = at('額外資訊')
const PAGE = at('商品頁面')
const FAQ = at('常見問答頁')

const GIARETTI: SheetCurrentProduct = {
  title: 'Giaretti 珈樂堤 GL-5680',
  imageUrl: 'https://storage.googleapis.com/b/uploads/ws/sheet-products/g.jpg',
  values: {
    出貨時間: '依原廠公告：\n第一批 10 月底，\n10/7 起第二批 11 月底。',
    商品頁面: '以下提供商品頁面連結供您參考： https://www.myfeel-tw.com/projects/GL-5680',
  },
}

const template = () => ({
  type: 'text',
  imageUrl: IMAGE,
  imageWidth: 1200,
  imageHeight: 675,
  title: NAME,
  text: `出貨時間：${SHIP}\n\n${EXTRA}\n\n有其他問題直接留言給我們`,
  buttons: [
    { type: 'uri', label: '查看商品頁', uri: PAGE },
    { type: 'uri', label: '常見問答', uri: FAQ },
  ],
})

describe('① 膠囊', () => {
  it('叫「出貨時間・這個商品」「商品名・這個商品」，換得回存的格式', () => {
    expect(sheetFieldLabel({ row: SHEET_CURRENT_ROW, field: '出貨時間' })).toBe('出貨時間・這個商品')
    expect(sheetFieldLabel({ row: SHEET_CURRENT_ROW, field: SHEET_FIELD_NAME })).toBe('商品名・這個商品')
    expect(sheetFieldRefFromLabel('出貨時間・這個商品')).toEqual({ row: SHEET_CURRENT_ROW, field: '出貨時間' })
    expect(sheetFieldRefFromLabel('商品名・這個商品')).toEqual({ row: SHEET_CURRENT_ROW, field: SHEET_FIELD_NAME })
  })

  it('輸入框來回換：存的 → 膠囊 → 存的一字不差（含對照表有登記別的商品時）', () => {
    const stored = `${NAME} 預計 ${SHIP} 出貨`
    const labels = buildSheetLabelRegistry([{ row: 'Giaretti 珈樂堤 GL-5680', field: '出貨時間' }])
    for (const reg of [null, labels]) {
      expect(toStoredText(toDisplayText(stored, 'send', reg), 'send', [], reg)).toBe(stored)
    }
  })
})

describe('② 空白的格子整行不顯示', () => {
  it('⭐ 額外資訊空白：那一行拿掉，前後的空行收成一行；其他行一字不改', () => {
    const [out] = fillSheetCurrentProduct([template()], GIARETTI)
    expect(out.text).toBe('出貨時間：依原廠公告：\n第一批 10 月底，\n10/7 起第二批 11 月底。\n\n有其他問題直接留言給我們')
    expect(out.title).toBe('Giaretti 珈樂堤 GL-5680')
  })

  it('有寫就照放（多行的格子整段放進去）', () => {
    const p = { ...GIARETTI, values: { ...GIARETTI.values, 額外資訊: '贈品送完為止' } }
    expect(fillSheetCurrentProduct([template()], p)[0].text)
      .toBe('出貨時間：依原廠公告：\n第一批 10 月底，\n10/7 起第二批 11 月底。\n\n贈品送完為止\n\n有其他問題直接留言給我們')
  })

  it('只有空白字元也算空白', () => {
    expect(fillCurrentProductText(`A\n出貨：${SHIP}\nB`, { ...GIARETTI, values: { 出貨時間: '  ' } })).toBe('A\nB')
  })

  it('對照組：沒拿掉任何一行時，原本的空行照留', () => {
    expect(fillCurrentProductText(`${NAME}\n\n\n\n結尾`, GIARETTI)).toBe('Giaretti 珈樂堤 GL-5680\n\n\n\n結尾')
  })
})

describe('③ 網址按鈕', () => {
  it('取格子裡第一個 https 網址（「商品頁面」那格是一句話＋網址）', () => {
    const [out] = fillSheetCurrentProduct([template()], GIARETTI)
    expect(out.buttons).toEqual([{ type: 'uri', label: '查看商品頁', uri: 'https://www.myfeel-tw.com/projects/GL-5680' }])
  })

  it('⛔ 常見問答頁空白：那顆按鈕不顯示（LINE 不收空網址）', () => {
    const [out] = fillSheetCurrentProduct([template()], GIARETTI)
    expect(out.buttons.map((b: any) => b.label)).toEqual(['查看商品頁'])
  })

  it('⛔ 格子有字但沒有網址：一樣不顯示', () => {
    const p = { ...GIARETTI, values: { ...GIARETTI.values, 常見問答頁: '整理中' } }
    expect(fillSheetCurrentProduct([template()], p)[0].buttons).toHaveLength(1)
  })

  it('`C-438` code review：⛔ 按鈕上的字、按了代送的字用了這個商品的格子、填出來是空的＝那顆按鈕拿掉（留空字串 LINE 整則退回）', () => {
    const msg = {
      type: 'text',
      text: '看看下面',
      buttons: [
        { type: 'module', label: `看${NAME}`, moduleId: 'm1' },
        { type: 'message', label: '問型號', text: at('型號') },
        { type: 'message', label: '找真人', text: '找真人' },
      ],
      quickReplies: [{ label: EXTRA, action: { type: 'message', text: '好' } }, { label: '其他問題', action: { type: 'message', text: '其他' } }],
    }
    // 沒有商品：商品名那顆、型號那顆、額外資訊那個快速回覆都拿掉；其他照舊
    const [none] = fillSheetCurrentProduct([msg], null)
    expect(none.buttons.map((b: any) => b.label)).toEqual(['找真人'])
    expect(none.quickReplies.map((q: any) => q.label)).toEqual(['其他問題'])
    // 有商品、有寫：照填
    const [filled] = fillSheetCurrentProduct([msg], { ...GIARETTI, values: { ...GIARETTI.values, 型號: 'GL-5680', 額外資訊: '贈品' } })
    expect(filled.buttons.map((b: any) => b.label)).toEqual([`看${GIARETTI.title}`, '問型號', '找真人'])
    expect(filled.buttons[1].text).toBe('GL-5680')
    expect(filled.quickReplies.map((q: any) => q.label)).toEqual(['贈品', '其他問題'])
  })

  it('對照組：自己打的網址、送模組的按鈕照舊', () => {
    const msg = { type: 'text', text: SHIP, buttons: [{ type: 'uri', label: '官網', uri: 'https://myfeel-tw.com' }, { type: 'module', label: '找真人', moduleId: 'm1' }] }
    expect(fillSheetCurrentProduct([{ ...msg, text: `出貨：${SHIP}\n其他問題按下面` }], { ...GIARETTI, values: {} })[0].buttons).toEqual(msg.buttons)
  })
})

describe('④ 圖、整則被拿光', () => {
  it('有圖：換成這個商品的圖，量好的比例照留', () => {
    const [out] = fillSheetCurrentProduct([template()], GIARETTI)
    expect(out).toMatchObject({ imageUrl: GIARETTI.imageUrl, imageWidth: 1200, imageHeight: 675 })
  })

  it('這個商品沒有圖：改回不帶圖，標題、比例一起拿掉（沒圖的文字不畫標題）', () => {
    const [out] = fillSheetCurrentProduct([template()], { ...GIARETTI, imageUrl: '' })
    expect(out).not.toHaveProperty('imageUrl')
    expect(out).not.toHaveProperty('title')
    expect(out).not.toHaveProperty('imageWidth')
    expect(out.text).toContain('出貨時間：依原廠公告')
  })

  it('⛔ 整則只有空白的格子、沒圖沒按鈕：這一則不送，其他則照送', () => {
    const out = fillSheetCurrentProduct([{ type: 'text', text: EXTRA }, { type: 'text', text: '固定的那一則' }], GIARETTI)
    expect(out).toEqual([{ type: 'text', text: '固定的那一則' }])
  })
})

describe('⑤ 沒有「這個商品」、列名寫死的', () => {
  it('不是從目錄點進來的：用到這個商品的行都不顯示、網址按鈕拿掉、不帶圖', () => {
    const [out] = fillSheetCurrentProduct([template()], null)
    expect(out.text).toBe('有其他問題直接留言給我們')
    expect(out.buttons).toEqual([])
    expect(out).not.toHaveProperty('imageUrl')
  })

  it('⛔ 列名寫死的格子不動（交給 C-423 那套，換不到用存檔當時的）', () => {
    const fixed = sheetFieldToken({ row: 'KIESLECT 小耳記', field: '出貨時間' })
    expect(fillCurrentProductText(`小耳記：${fixed}\n這台：${SHIP}`, GIARETTI)).toBe(`小耳記：${fixed}\n這台：依原廠公告：\n第一批 10 月底，\n10/7 起第二批 11 月底。`)
  })

  it('沒用到的訊息：原物件照回（不多做事）', () => {
    const msg = { type: 'text', text: '你好' }
    expect(fillSheetCurrentProduct([msg], GIARETTI)[0]).toBe(msg)
    expect(usesCurrentProductDeep([msg])).toBe(false)
    expect(usesCurrentProductDeep([template()])).toBe(true)
  })
})
