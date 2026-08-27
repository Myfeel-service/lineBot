/**
 * 小幫手拖移位置的純邏輯測試。
 *
 * 為什麼這兩支值得單獨測：它們是「錯了不會報錯、只會讓功能安靜消失」的那種——
 * 夾不住就是按鈕跑到視窗外（使用者只會覺得小幫手不見了，不會想到它在畫面外），
 * 錨錯邊就是面板往視窗外開（按鈕看得到、內容看不到）。兩者都不會拋例外、
 * 也不會被 typecheck 抓到。
 */
import { describe, expect, it } from 'vitest'

const g = globalThis as Record<string, unknown>
// 這支檔案只測純函式，但 composable 本體會呼叫 Nuxt 的 auto-import；
// 匯入時就要有東西頂著，否則整個模組載不起來
g.useState = () => ({ value: null })
g.ref = () => ({ value: null })
g.computed = () => ({ value: null })
g.onMounted = () => {}
g.onBeforeUnmount = () => {}

const { clampDockPos, dockAnchors, DOCK_FAB_SIZE, DOCK_MARGIN } = await import('./useAgentDock')

const VW = 1440
const VH = 900

describe('clampDockPos', () => {
  it('範圍內的座標原封不動', () => {
    expect(clampDockPos({ x: 400, y: 300 }, VW, VH)).toEqual({ x: 400, y: 300 })
  })

  it('拖出右下角 → 夾回「整顆按鈕還看得見」的位置', () => {
    const p = clampDockPos({ x: 9999, y: 9999 }, VW, VH)
    expect(p).toEqual({ x: VW - DOCK_FAB_SIZE - DOCK_MARGIN, y: VH - DOCK_FAB_SIZE - DOCK_MARGIN })
    // 右下角整顆都在視窗內
    expect(p.x + DOCK_FAB_SIZE).toBeLessThanOrEqual(VW)
    expect(p.y + DOCK_FAB_SIZE).toBeLessThanOrEqual(VH)
  })

  it('拖出左上角（含負座標）→ 夾回邊界留白', () => {
    expect(clampDockPos({ x: -500, y: -80 }, VW, VH)).toEqual({ x: DOCK_MARGIN, y: DOCK_MARGIN })
  })

  it('視窗比按鈕還小（手機轉向的瞬間）→ 仍回合法座標，不是 NaN 或負數', () => {
    const p = clampDockPos({ x: 300, y: 300 }, 40, 40)
    expect(Number.isFinite(p.x)).toBe(true)
    expect(Number.isFinite(p.y)).toBe(true)
    expect(p.x).toBeGreaterThanOrEqual(0)
    expect(p.y).toBeGreaterThanOrEqual(0)
  })
})

describe('dockAnchors', () => {
  it('右下角 → 錨右下（面板往左上長，維持原本的行為）', () => {
    const a = dockAnchors({ x: VW - 70, y: VH - 70 }, VW, VH)
    expect(a.side).toBe('right')
    expect(a.vertical).toBe('bottom')
    expect(a.style.left).toBe('auto')
    expect(a.style.top).toBe('auto')
  })

  it('左上角 → 錨左上（面板要往右下長，不能繼續往左上開到視窗外）', () => {
    const a = dockAnchors({ x: 12, y: 12 }, VW, VH)
    expect(a.side).toBe('left')
    expect(a.vertical).toBe('top')
    expect(a.style.right).toBe('auto')
    expect(a.style.bottom).toBe('auto')
    expect(a.style.left).toBe('12px')
    expect(a.style.top).toBe('12px')
  })

  it('左下 / 右上 兩個對角也各自錨對邊', () => {
    expect(dockAnchors({ x: 20, y: VH - 70 }, VW, VH)).toMatchObject({ side: 'left', vertical: 'bottom' })
    expect(dockAnchors({ x: VW - 70, y: 20 }, VW, VH)).toMatchObject({ side: 'right', vertical: 'top' })
  })

  it('錨點取「按鈕中心」而不是左上角', () => {
    // 左上角在中線左邊 20px、但整顆的中心已經過了中線 → 該錨右。
    // 拿左上角判斷的寫法會在這裡答錯（這格就是用來擋那種寫法的）
    const straddling = dockAnchors({ x: VW / 2 - 20, y: 400 }, VW, VH)
    expect(straddling.side).toBe('right')
    // 對照組：整顆都在左半邊
    expect(dockAnchors({ x: VW / 2 - DOCK_FAB_SIZE - 10, y: 400 }, VW, VH).side).toBe('left')
  })

  it('面板可用寬度＝從錨邊到對邊：靠中間時會變窄，不會溢出視窗', () => {
    const edge = dockAnchors({ x: VW - 70, y: VH - 70 }, VW, VH)
    const middle = dockAnchors({ x: VW / 2 + 100, y: VH - 70 }, VW, VH)
    const edgeW = Number.parseInt(edge.style['--ta-dock-maxw']!, 10)
    const middleW = Number.parseInt(middle.style['--ta-dock-maxw']!, 10)
    expect(edgeW).toBeGreaterThan(middleW)
    // 錨邊offset + 可用寬 不超過視窗
    expect(Number.parseInt(middle.style.right!, 10) + middleW).toBeLessThanOrEqual(VW)
  })

  it('拖到垂直中間 → 面板高度上限跟著縮', () => {
    const bottom = dockAnchors({ x: VW - 70, y: VH - 70 }, VW, VH)
    const middle = dockAnchors({ x: VW - 70, y: VH / 2 - 100 }, VW, VH)
    const bottomH = Number.parseInt(bottom.style['--ta-dock-panelh']!, 10)
    const middleH = Number.parseInt(middle.style['--ta-dock-panelh']!, 10)
    expect(middleH).toBeLessThan(bottomH)
    expect(middleH).toBeGreaterThan(0)
  })

  /**
   * 迴歸：第一版把上限算在「內容區」，得先估標頭＋頁尾佔幾 px（估了 96，實測 114），
   * 於是拖到畫面中央時面板底部超出視窗 6px。現在上限給的是**整個面板**的高度，
   * 所以這條算式可以直接驗完——不必知道外框多高。
   */
  it('面板高度上限＋上方佔用＋邊界留白 一定塞得進視窗（不靠估算外框高度）', () => {
    for (const y of [DOCK_MARGIN, 200, VH / 2 - 100, VH / 2 + 50, VH - 70]) {
      const a = dockAnchors({ x: VW - 70, y }, VW, VH)
      const panelH = Number.parseInt(a.style['--ta-dock-panelh']!, 10)
      const offset = Number.parseInt((a.vertical === 'top' ? a.style.top : a.style.bottom)!, 10)
      // 這一疊＝邊界留白 + 錨邊offset + 按鈕 + 間距 + 面板
      expect(offset + DOCK_FAB_SIZE + 12 + panelH + DOCK_MARGIN).toBeLessThanOrEqual(VH)
    }
  })

  it('四個邊只會有兩個是實際值，另兩個一定是 auto（否則固定定位會被拉開變形）', () => {
    for (const pos of [{ x: 12, y: 12 }, { x: VW - 70, y: 12 }, { x: 12, y: VH - 70 }, { x: VW - 70, y: VH - 70 }]) {
      const s = dockAnchors(pos, VW, VH).style
      expect([s.left, s.right].filter(v => v === 'auto')).toHaveLength(1)
      expect([s.top, s.bottom].filter(v => v === 'auto')).toHaveLength(1)
    }
  })
})
