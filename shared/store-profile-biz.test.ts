import { describe, expect, it } from 'vitest'
import {
  INDUSTRY_BIZ_TYPE,
  STORE_BIZ_WORDING,
  storeBizTypeOf,
  storeProfileLabelFor,
  welcomeAskFor,
} from './store-profile-biz'
import { STORE_PROFILE_FIELDS } from './types/store-profile'

const industryDef = STORE_PROFILE_FIELDS.find(f => f.id === 'industry')!

describe('店家的型（`D-99`／`C-250`）', () => {
  it('產業別那一題的每個選項都對得到一型（⛔ 選項改字時這張表要一起改）', () => {
    for (const o of industryDef.options ?? []) {
      expect(INDUSTRY_BIZ_TYPE[o], o).toBeDefined()
    }
  })

  it('⛔ 產業別選項不再有「其他」（它存得下去、會被原樣插進草稿）', () => {
    expect(industryDef.options).not.toContain('其他')
  })

  it('⛔ 自己打的、舊資料的「其他」、空的——一律中性型，不猜成賣東西', () => {
    expect(storeBizTypeOf('手工皂與香氛的工作室')).toBe('neutral')
    expect(storeBizTypeOf('其他')).toBe('neutral')
    expect(storeBizTypeOf('')).toBe('neutral')
    expect(storeBizTypeOf(undefined)).toBe('neutral')
  })

  it('三型各自對得到', () => {
    expect(storeBizTypeOf('零售／電商')).toBe('goods')
    expect(storeBizTypeOf('醫療／健康')).toBe('service')
    expect(storeBizTypeOf('教育／課程')).toBe('class')
  })

  it('⛔ 不是賣東西的型，問法裡沒有「賣」「買」（牙醫被問「主要賣什麼」就是這條要擋的）', () => {
    for (const t of ['service', 'class', 'neutral'] as const) {
      const w = STORE_BIZ_WORDING[t]
      expect(w.productsQuestion, t).not.toContain('賣')
      expect(w.channelQuestion, t).not.toContain('買')
      expect(w.tryQuestion, t).not.toContain('賣')
    }
  })

  it('輪廓卡欄位名照型換；不在換名清單裡的欄位維持原名', () => {
    expect(storeProfileLabelFor('products', '主打商品', '醫療／健康')).toBe('主要服務')
    expect(storeProfileLabelFor('priceRange', '價格帶', '教育／課程')).toBe('學費區間')
    expect(storeProfileLabelFor('channel', '銷售方式', '醫療／健康')).toBe('接觸方式')
    expect(storeProfileLabelFor('products', '主打商品', '零售／電商')).toBe('主打商品')
    expect(storeProfileLabelFor('customers', '主要客群', '醫療／健康')).toBe('主要客群')
  })

  it('歡迎訊息「可以問什麼」：賣東西的照銷售方式換，其他型用自己那一句', () => {
    expect(welcomeAskFor('零售／電商', '預約制')).toContain('預約時段')
    expect(welcomeAskFor('零售／電商', '實體店面')).toContain('營業時間')
    expect(welcomeAskFor('零售／電商', '網購為主')).toContain('出貨')
    expect(welcomeAskFor('醫療／健康', '實體＋網購')).not.toContain('出貨')
    expect(welcomeAskFor('教育／課程', '網購為主')).toContain('報名')
  })
})

describe('按鈕題的出口（`D-89`）', () => {
  it('⛔ 每一題按鈕題都要有「都不是，我自己講」的追問與輸入提示', () => {
    for (const def of STORE_PROFILE_FIELDS.filter(f => f.options?.length)) {
      expect(def.freeAsk, def.id).toBeTruthy()
      expect(def.freePlaceholder, def.id).toBeTruthy()
    }
  })
})
