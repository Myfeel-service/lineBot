/**
 * 疊字的座標算式（`C-193`）。
 *
 * 為什麼要測這一半：整件事成立的前提是「看得到的格子」＝「按得到的區域」。
 * 算錯的症狀很壞——圖看起來好好的，客人點下去沒反應，後台完全看不出來。
 * 畫布那一半（顏色、字體）用眼睛看就好，會出錯的是這裡的邊界處理。
 */
import { describe, expect, it } from 'vitest'
import { dataUrlBytes, planRichMenuOverlay } from './richmenu-compose'

const box = (x: number, y: number, width: number, height: number, label = '') => ({ bounds: { x, y, width, height }, label })

describe('疊字的座標', () => {
  it('四宮格：四格都在、位置就是可點區域的位置', () => {
    const plans = planRichMenuOverlay([
      box(0, 0, 1250, 421, '查訂單'),
      box(1250, 0, 1250, 421, '改地址'),
      box(0, 421, 1250, 422, '找真人'),
      box(1250, 421, 1250, 422, '看活動'),
    ], 2500, 843)

    expect(plans).toHaveLength(4)
    expect(plans[0]).toMatchObject({ x: 0, y: 0, w: 1250, h: 421, cx: 625 })
    expect(plans[3]).toMatchObject({ x: 1250, y: 421, cx: 1875 })
  })

  it('🔴 拖到畫布外的區塊要夾回來，⛔不可以畫到畫布外面（畫布不會報錯，就是靜靜少一塊）', () => {
    const [p] = planRichMenuOverlay([box(2400, 700, 400, 400, '超出去')], 2500, 843)
    expect(p).toMatchObject({ x: 2400, y: 700, w: 100, h: 143 })
  })

  it('🔴 完全在畫布外、或寬高是 0 的整格丟掉——但**後面那幾格要照樣處理**', () => {
    const plans = planRichMenuOverlay([
      box(3000, 0, 200, 200, '完全在外面'),
      box(0, 0, 0, 400, '寬是零'),
      box(0, 0, 1250, 421, '這格是好的'),
    ], 2500, 843)
    expect(plans).toHaveLength(1)
    expect(plans[0]!.label).toBe('這格是好的')
  })

  it('壞掉的座標不會讓整件事爆掉', () => {
    const plans = planRichMenuOverlay([
      { bounds: { x: Number.NaN, y: 0, width: 100, height: 100 }, label: 'NaN' },
      box(0, 0, 100, 100, '好的'),
    ], 2500, 843)
    expect(plans).toHaveLength(1)
  })

  it('畫布本身是 0 就什麼都不畫', () => {
    expect(planRichMenuOverlay([box(0, 0, 10, 10, 'a')], 0, 843)).toEqual([])
  })

  it('字級：細長的格子要靠寬度收斂，否則字會凸出格子', () => {
    const [wide] = planRichMenuOverlay([box(0, 0, 2500, 843, '短')], 2500, 843)
    const [narrow] = planRichMenuOverlay([box(0, 0, 200, 843, '很長的一串按鈕名字')], 2500, 843)
    expect(narrow!.fontSize).toBeLessThan(wide!.fontSize)
  })

  it('字級有下限，再擠也不會變成看不見的大小', () => {
    const [p] = planRichMenuOverlay([box(0, 0, 40, 30, '一二三四五六七八九十')], 2500, 843)
    expect(p!.fontSize).toBeGreaterThanOrEqual(22)
  })
})

describe('算圖檔大小', () => {
  it('估得出 data URL 的位元組數（⛔用來擋 500KB 上限，不能差太多）', () => {
    // "AAAA" = 3 bytes
    expect(dataUrlBytes('data:image/jpeg;base64,AAAA')).toBe(3)
    expect(dataUrlBytes('data:image/jpeg;base64,AAA=')).toBe(2)
    expect(dataUrlBytes('data:image/jpeg;base64,AA==')).toBe(1)
  })
})
