import { describe, expect, it } from 'vitest'
import { isRiskyTriggerKeyword, riskyTriggerKeywords } from './script-trigger-keywords'

describe('會惹禍的觸發關鍵字', () => {
  it('單一個字要抓出來（中文一個字幾乎一定誤中：「單」會命中「單身」「單車」）', () => {
    expect(isRiskyTriggerKeyword('單')).toBe(true)
    expect(isRiskyTriggerKeyword('退')).toBe(true)
    // 兩個字以上的具體詞不算
    expect(isRiskyTriggerKeyword('退貨')).toBe(false)
  })

  it('高頻通用詞要抓出來——這是 C-25 那場「觸發詞劫持正常訊息」的原型', () => {
    expect(isRiskyTriggerKeyword('問題')).toBe(true)
    expect(isRiskyTriggerKeyword('客服')).toBe(true)
    expect(isRiskyTriggerKeyword('你好')).toBe(true)
  })

  it('英文大小寫不影響判斷（使用者會打 Hi、HELLO）', () => {
    expect(isRiskyTriggerKeyword('Hi')).toBe(true)
    expect(isRiskyTriggerKeyword('HELLO')).toBe(true)
    expect(isRiskyTriggerKeyword('OK')).toBe(true)
  })

  it('空白與空字串不算問題（那是還沒填，不是填錯）', () => {
    expect(isRiskyTriggerKeyword('')).toBe(false)
    expect(isRiskyTriggerKeyword('   ')).toBe(false)
  })

  it('一整組裡只回有問題的那幾個，順序照原輸入、重複只回一次', () => {
    expect(riskyTriggerKeywords(['退換貨', '問題', '退費', '問題', '單'])).toEqual(['問題', '單'])
  })

  it('全部都是好關鍵字時回空陣列（畫面才不會出現空的警告框）', () => {
    expect(riskyTriggerKeywords(['退換貨', '訂單查詢', '維修保固'])).toEqual([])
  })

  it('前後空白會被吃掉：使用者用逗號分隔打字一定會留空白', () => {
    expect(riskyTriggerKeywords([' 問題 '])).toEqual(['問題'])
  })
})
