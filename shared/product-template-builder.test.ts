import { describe, expect, it } from 'vitest'
import { buildProductTemplateMessages, productTemplateName, PRODUCT_TEMPLATE_CLOSING } from './product-template-builder'
import { CARD_BODY_MAX, cardMessageError, cardMessageSizeError } from './card-message'
import { fillSheetCurrentProduct, usesCurrentProductDeep } from './sheet-current-product'
import { assertValidFlowMessages } from '../server/utils/flow-validator'

/** MYFEEL 那份試算表 10-31 換完之後的欄名（第一欄「專案」＝商品名不在裡面） */
const MYFEEL = ['出貨時間', '商品頁面', '額外資訊1', '額外資訊2', '額外資訊3', '常見問答頁']
const build = (headers: string[], extra: { catalogModuleId?: string, liveAgentModuleId?: string } = { liveAgentModuleId: 'live' }) =>
  buildProductTemplateMessages({ headers, ...extra })

describe('`C-453`④ 幫我做一份商品資訊範本', () => {
  it('⭐ 照欄名排：每一欄一段、商品頁跟常見問答做成按鈕不放內文；存檔檢查、卡片檢查都過', () => {
    const { messages: msgs, omitted } = build(MYFEEL, { catalogModuleId: 'cat-1', liveAgentModuleId: 'live' })
    const card = msgs[0].columns[0]
    expect(omitted).toEqual([])
    expect(card.text).toContain('出貨時間：{{sheet:%40|')
    expect(card.text).toContain('額外資訊3：')
    expect(card.text).not.toContain('商品頁面')
    expect(card.text).not.toContain('常見問答頁')
    expect(card.actions.map((a: any) => [a.label, a.style])).toEqual([['查看商品頁', 'primary'], ['常見問答', 'link']])
    expect(msgs[1].quickReplies.map((q: any) => [q.action.label, q.action.moduleId])).toEqual([['看其他商品', 'cat-1'], ['真人客服', 'live']])
    expect(() => assertValidFlowMessages(msgs)).not.toThrow()
    expect(cardMessageError(msgs[0]) || cardMessageSizeError(msgs[0])).toBe('')
    // 用到「這個商品」＝商品目錄那邊不會再講「每個商品點了都收到一樣的內容」
    expect(usesCurrentProductDeep(msgs)).toBe(true)
  })

  it('填進一個商品：空白的那幾欄整段不出現、沒有常見問答網址就沒那顆按鈕、不留下任何格子代碼', () => {
    const { messages } = build(MYFEEL)
    const filled = fillSheetCurrentProduct(messages, {
      title: 'YiMi 宜米 製冰咖啡速熱飲水機 YC-2',
      imageUrl: 'https://s/yimi.jpg',
      values: { 出貨時間: '預計 11 月中下旬出貨', 商品頁面: '以下提供商品頁面連結供您參考：\nhttps://www.myfeel-tw.com/projects/Yimi-YC-2' },
    })
    const card = filled[0].columns[0]
    expect(card.title).toBe('YiMi 宜米 製冰咖啡速熱飲水機 YC-2')
    expect(card.imageUrl).toBe('https://s/yimi.jpg')
    expect(card.text).toBe('{{displayName}}您好，\n\n出貨時間：預計 11 月中下旬出貨')
    expect(card.actions.map((a: any) => [a.label, a.uri])).toEqual([['查看商品頁', 'https://www.myfeel-tw.com/projects/Yimi-YC-2']])
    expect(filled[1].text).toBe(PRODUCT_TEMPLATE_CLOSING)
    expect(JSON.stringify(filled)).not.toContain('{{sheet:')
  })

  it('code review 第 2 條：欄位多到內文放不下——照順序放到上限為止、講出沒放的是哪幾欄，⛔ 不建一份存不了的範本', () => {
    const many = Array.from({ length: 30 }, (_, i) => `規格欄位${i + 1}`)
    const { messages, omitted } = build(many)
    expect(omitted.length).toBeGreaterThan(0)
    expect(omitted[0]).toBe(`規格欄位${30 - omitted.length + 1}`)
    expect(String(messages[0].columns[0].text).length).toBeLessThanOrEqual(CARD_BODY_MAX)
    expect(() => assertValidFlowMessages(messages)).not.toThrow()
  })

  it('認不出商品頁那一欄（叫「官網」）：不做「查看商品頁」按鈕，那一欄照一般欄位放內文', () => {
    const { messages } = build(['出貨時間', '官網'])
    expect(messages[0].columns[0].actions).toEqual([])
    expect(messages[0].columns[0].text).toContain('官網：')
  })

  it('「放進LINE目錄」那一欄不放（打勾給系統看的，不是給客人看的）', () => {
    expect(build(['出貨時間', '放進LINE目錄']).messages[0].columns[0].text).not.toContain('放進LINE目錄')
  })

  it('目錄還沒存檔（沒有 id）：快速回覆只有「真人客服」；找不到真人客服模組就不放那顆（code review 第 14 條）', () => {
    expect(build(MYFEEL).messages[1].quickReplies.map((q: any) => q.action.label)).toEqual(['真人客服'])
    expect(build(MYFEEL, { catalogModuleId: 'cat-1' }).messages[1].quickReplies.map((q: any) => q.action.label)).toEqual(['看其他商品'])
  })

  it('一顆快速回覆都沒有：收尾那則不放（空的快速回覆存不了），範本照樣存得了', () => {
    const { messages } = build(MYFEEL, {})
    expect(messages).toHaveLength(1)
    expect(() => assertValidFlowMessages(messages)).not.toThrow()
  })

  it('名字撞到加序號', () => {
    expect(productTemplateName([])).toBe('商品資訊範本')
    expect(productTemplateName(['商品資訊範本', '商品資訊範本 2'])).toBe('商品資訊範本 3')
  })
})
