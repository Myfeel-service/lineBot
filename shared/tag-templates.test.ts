/**
 * 標籤範本庫（D-27③；2026-08-25 依真實對話重寫，見 `C-75`）。守四件事：
 *   1. code 唯一且格式合法（後端 create 的 regex）——撞號或壞格式會讓一鍵建立整批卡住。
 *   2. 判斷條件非空且 ≤200 字（編輯器 maxlength ＝ prompt 上限，超了會被切）。
 *   3. 分類是合法值（後端白名單擋，錯了 400）。
 *   4. ⛔ **不可出現任何品類／商品名**——範本是全租戶共用的，寫死品類等於把
 *      某一家店的商品塞給所有商家看（見 memory feedback_saas_no_tenant_hardcoding）。
 *      第一版就是栽在這裡：照「家電行」刻板印象寫了「在看除濕機」，
 *      而真實資料裡除濕機只有 1 位客人提過。
 */
import { describe, it, expect } from 'vitest'
import { TAG_TEMPLATES } from './tag-templates'

const VALID_CATEGORIES = ['member_status', 'interest', 'behavior', 'activity', 'custom']

describe('TAG_TEMPLATES', () => {
  it('code 唯一且符合後端格式（英文小寫開頭，數字底線）', () => {
    expect(TAG_TEMPLATES.length).toBeGreaterThanOrEqual(5)
    const codes = TAG_TEMPLATES.map(t => t.code)
    expect(new Set(codes).size).toBe(codes.length)
    for (const code of codes) expect(code).toMatch(/^[a-z][a-z0-9_]*$/)
  })

  it('每顆都有名稱、判斷條件（≤200 字）、用途說明、合法分類', () => {
    for (const t of TAG_TEMPLATES) {
      expect(t.name.trim()).toBeTruthy()
      expect(t.criteria.trim()).toBeTruthy()
      expect(t.criteria.length).toBeLessThanOrEqual(200)
      expect(t.usage.trim()).toBeTruthy()
      expect(VALID_CATEGORIES).toContain(t.category)
      expect(t.color).toMatch(/^#[0-9A-Fa-f]{6}$/)
    }
  })

  it('條件都寫了「不算」的排除句或明確界線——只寫「什麼算」的條件容易過度貼標', () => {
    // 至少一半的範本要有排除語（不算／只問…的不算），這是寫法公式的示範作用
    const withExclusion = TAG_TEMPLATES.filter(t => t.criteria.includes('不算'))
    expect(withExclusion.length).toBeGreaterThanOrEqual(4)
  })

  /**
   * ⛔ 這條是 2026-08-25 那次錯誤的防線：範本是**全租戶共用**的，一旦寫進具體品類，
   * 賣衣服的商家打開「從範本建立」看到的就是「在看除濕機」。
   * 品類標籤要在各自的工作區自己建，不進這份共用清單。
   */
  it('⛔ 不含任何具體品類或商品名（範本全租戶共用，品類是租戶專屬的）', () => {
    const 品類詞 = [
      '除濕機', '清淨機', '耳機', '麥克風', '咖啡機', '電子鍋', '鍋具',
      '按摩', '香氛', '精油', '冷氣', '洗衣機', '手機', '筆電',
    ]
    for (const t of TAG_TEMPLATES) {
      for (const word of 品類詞) {
        expect(`${t.name} ${t.criteria} ${t.usage}`, `範本「${t.name}」不該提到具體品類「${word}」`)
          .not.toContain(word)
      }
    }
  })
})
