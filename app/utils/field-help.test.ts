import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FIELD_HELP } from './field-help'

/**
 * 「教我怎麼用」彈窗的守門（`C-448` 加了成果圖＋一步一張圖之後補）。
 *
 * ① 圖要真的在 `public/`：成果圖載不到只是一塊空白、輪播載不到會**安靜地少一步**（AgentStepCarousel 濾掉載不到的），
 *    打錯檔名不會有任何東西變紅。
 * ② 步驟至少兩步、圖說不自己標號（規矩同開通引導的輪播，見 onboarding-carousels.test.ts）。
 * ③ 商品那三個教學⛔ 不出現任何一家店的商品名、品牌（2026-10-30 老闆「圖片盡量不要用廠商的圖片」）：
 *    每個店家都看得到這個彈窗。圖的來源頁也一起查（圖是從那一頁截的）。
 */

const ROOT = resolve(import.meta.dirname, '../..')
const CIRCLED = '①②③④⑤⑥⑦⑧⑨'
const inPublic = (src: string) => existsSync(resolve(ROOT, 'public', src.replace(/^\//, '')))

/** 正式帳號真的在賣的商品、品牌（MYFEEL）：教學裡出現任何一個就是用了廠商的東西 */
const VENDOR_WORDS = ['MYFEEL', 'Giaretti', '珈樂堤', 'KIESLECT', '小耳記', 'BOYA', 'AROMIC', 'SHARP', '乾淨方', '電淨艙', '粒粒安', 'YiMi', '奇美']

describe('欄位教學', () => {
  for (const [id, def] of Object.entries(FIELD_HELP)) {
    const images = [def.image, def.result?.image, ...(def.steps?.items.map(s => s.src) ?? [])].filter((s): s is string => !!s)
    // 純文字的那幾個（門檻、角色…）沒有圖也沒有步驟，沒東西要查
    if (!images.length && !def.steps) continue
    describe(id, () => {
      for (const src of images) {
        it(`${src} 在 public/ 裡`, () => {
          expect(inPublic(src), `${src} 不在 public/——彈窗裡那張圖會是空的（輪播會少一步）`).toBe(true)
        })
      }

      if (def.steps) {
        it('步驟至少兩步', () => {
          expect(def.steps!.items.length).toBeGreaterThanOrEqual(2)
        })
        it('圖說不自己標號（步序由輪播的計數器講）', () => {
          for (const s of def.steps!.items) expect([...CIRCLED].filter(c => s.caption.includes(c))).toEqual([])
        })
      }
    })
  }
})

describe('商品教學不用廠商的東西', () => {
  const PRODUCT_HELP = ['sheetCatalog', 'productTemplate', 'productSheetFormat'] as const

  for (const id of PRODUCT_HELP) {
    it(`${id} 的字不提任何一家店的商品、品牌`, () => {
      const text = JSON.stringify(FIELD_HELP[id])
      expect(VENDOR_WORDS.filter(w => text.includes(w))).toEqual([])
    })
  }

  it('圖的來源頁（docs/onboarding-shots-src/product-help.html）也沒有', () => {
    const html = readFileSync(resolve(ROOT, 'docs/onboarding-shots-src/product-help.html'), 'utf8')
    expect(VENDOR_WORDS.filter(w => html.includes(w))).toEqual([])
  })
})
