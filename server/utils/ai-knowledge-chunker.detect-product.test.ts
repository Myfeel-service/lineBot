/**
 * 加入資料時 AI 認的商品名收尾（`C-325`／`D-127`）：
 * 同一台換一份文件就多一種寫法＝寫法分裂的源頭；官網首頁被認成「MYFEEL全品項總覽」＝店名被當成一台商品。
 */
import { describe, it, expect } from 'vitest'
import { settleDetectedProductName } from './ai-knowledge-chunker'

const EXISTING = ['SHARP 自動調理零水鍋', '上好ㄟ抽取式除濕機']

describe('settleDetectedProductName', () => {
  it('首頁、全品項總覽、官網這類不是一台商品 → 空的', () => {
    expect(settleDetectedProductName('MYFEEL全品項總覽', EXISTING)).toBe('')
    expect(settleDetectedProductName('MYFEEL 官方網站', EXISTING)).toBe('')
    expect(settleDetectedProductName('首頁', EXISTING)).toBe('')
  })
  it('跟現有商品只差空白、大小寫 → 換成現有的寫法', () => {
    expect(settleDetectedProductName('sharp 自動調理  零水鍋', EXISTING)).toBe('SHARP 自動調理零水鍋')
  })
  it('是確認過的別名 → 換成那一台的名字', () => {
    const canonical = (n: string) => (n.includes('NWT') ? '上好ㄟ抽取式除濕機' : n)
    expect(settleDetectedProductName('NWT 威技 新一級能效 16L 高效抽取型除濕機', EXISTING, canonical)).toBe('上好ㄟ抽取式除濕機')
  })
  it('真的是新商品 → 原樣留著（交給加入畫面問「這是新商品嗎」）', () => {
    expect(settleDetectedProductName('廚餘博士 Pro', EXISTING)).toBe('廚餘博士 Pro')
  })
})
