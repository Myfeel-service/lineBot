/**
 * 拖曳手勢本體的測試：真的驅動 onDragStart → pointermove → pointerup 一輪。
 *
 * 為什麼要單獨一支：`useAgentDock.test.ts` 只測純函式（夾範圍、算錨點），
 * 但「按下去會不會變成拖、拖完會不會誤開面板、放開有沒有存起來」全在事件串接裡——
 * 那段程式 typecheck 綠、既有測試綠，卻可能一次都沒被執行過（這個 repo 交過
 * 「按了沒反應」的功能，就是因為只驗了編譯）。
 *
 * 手法：把 Nuxt auto-import 換成真的 vue ref/computed，並假造 window 與 localStorage，
 * 這樣 composable 跑的是它自己的邏輯，不是我另外抄的一份。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { computed, ref } from 'vue'

// ── 假環境 ───────────────────────────────────────────────
const listeners = new Map<string, Set<(e: unknown) => void>>()
const store = new Map<string, string>()
const mountedCbs: Array<() => void> = []

const fakeWindow = {
  innerWidth: 1280,
  innerHeight: 800,
  addEventListener(type: string, fn: (e: unknown) => void) {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type)!.add(fn)
  },
  removeEventListener(type: string, fn: (e: unknown) => void) {
    listeners.get(type)?.delete(fn)
  },
}

const g = globalThis as Record<string, unknown>
g.ref = ref
g.computed = computed
g.useState = (_key: string, init: () => unknown) => ref(init())
g.onMounted = (fn: () => void) => { mountedCbs.push(fn) }
g.onBeforeUnmount = () => {}
g.window = fakeWindow
g.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
}

const { useAgentDock, DOCK_MARGIN, DOCK_FAB_SIZE } = await import('./useAgentDock')

/** 假的浮動按鈕：只需要量得到位置、吃得下 setPointerCapture */
function fakeFab(left: number, top: number) {
  return {
    getBoundingClientRect: () => ({ left, top }),
    setPointerCapture: () => {},
  }
}

function pointerEvent(x: number, y: number, extra: Record<string, unknown> = {}) {
  return {
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    clientX: x,
    clientY: y,
    target: { closest: () => null },
    currentTarget: { setPointerCapture: () => {} },
    ...extra,
  } as unknown as PointerEvent
}

function fire(type: string, e: unknown) {
  for (const fn of listeners.get(type) ?? []) fn(e)
}

/** 開一顆新的 dock（含跑 onMounted，才會讀 localStorage 與視窗尺寸） */
function mountDock() {
  listeners.clear()
  mountedCbs.length = 0
  const dock = useAgentDock()
  // ⛔用陣列不用單一變數：TS 會把「先設 null 再被閉包塞值」的變數窄化成 null，
  //   然後在呼叫處報 not callable
  mountedCbs.forEach(fn => fn())
  return dock
}

// 預設起點：右下角（與 CSS 預設一致）
const START_X = 1280 - DOCK_FAB_SIZE - 24
const START_Y = 800 - DOCK_FAB_SIZE - 24

beforeEach(() => { store.clear() })

describe('拖曳手勢', () => {
  it('拖了一段 → 位置真的變了，而且 style 跟著換錨點', () => {
    const dock = mountDock()
    dock.fabRef.value = fakeFab(START_X, START_Y) as unknown as HTMLElement
    expect(dock.moved.value).toBe(false)
    expect(dock.dockStyle.value).toBeUndefined() // 還沒搬＝交給 CSS 預設

    dock.onDragStart(pointerEvent(START_X + 20, START_Y + 20))
    fire('pointermove', pointerEvent(START_X + 20 - 900, START_Y + 20 - 600))
    fire('pointerup', pointerEvent(0, 0))

    expect(dock.moved.value).toBe(true)
    // 往左上拖 900/600 → 錨點換到左上
    expect(dock.dockSide.value).toBe('left')
    expect(dock.dockVertical.value).toBe('top')
    expect(dock.dockStyle.value?.right).toBe('auto')
    expect(dock.dockStyle.value?.bottom).toBe('auto')
  })

  it('只是點一下（位移 2px）→ 不算拖曳，面板照樣打得開', () => {
    const dock = mountDock()
    dock.fabRef.value = fakeFab(START_X, START_Y) as unknown as HTMLElement

    dock.onDragStart(pointerEvent(START_X, START_Y))
    fire('pointermove', pointerEvent(START_X + 2, START_Y + 1))
    fire('pointerup', pointerEvent(START_X + 2, START_Y + 1))

    expect(dock.moved.value).toBe(false) // 位置沒被改
    expect(dock.consumeDrag()).toBe(false) // ＝onFabClick 會照常開面板
  })

  it('真的拖過 → 那一下的 click 要被吃掉（不然拖完面板自己彈出來）', () => {
    const dock = mountDock()
    dock.fabRef.value = fakeFab(START_X, START_Y) as unknown as HTMLElement

    dock.onDragStart(pointerEvent(START_X, START_Y))
    fire('pointermove', pointerEvent(START_X - 200, START_Y - 100))
    fire('pointerup', pointerEvent(START_X - 200, START_Y - 100))

    expect(dock.consumeDrag()).toBe(true)
    // 讀完就清掉：下一次真的點才不會被連坐
    expect(dock.consumeDrag()).toBe(false)
  })

  it('從標頭拖完（後面沒有 click）→ 旗標不會留到下一次真的點按鈕', () => {
    const dock = mountDock()
    dock.fabRef.value = fakeFab(START_X, START_Y) as unknown as HTMLElement

    // 第一輪：拖，但沒有人來 consume（從面板標頭拖曳就是這個情形）
    dock.onDragStart(pointerEvent(START_X, START_Y))
    fire('pointermove', pointerEvent(START_X - 300, START_Y - 200))
    fire('pointerup', pointerEvent(0, 0))

    // 第二輪：只是點一下按鈕
    dock.onDragStart(pointerEvent(300, 300))
    fire('pointerup', pointerEvent(300, 300))

    expect(dock.consumeDrag()).toBe(false) // ⛔這裡回 true 就是「第一下點不開」
  })

  it('點在按鈕上（分頁／關閉鈕）→ 整個手勢讓掉，不會被當成拖標頭', () => {
    const dock = mountDock()
    dock.fabRef.value = fakeFab(START_X, START_Y) as unknown as HTMLElement

    dock.onDragStart(pointerEvent(500, 500, { target: { closest: (s: string) => (s === 'button' ? {} : null) } }))
    // 沒有註冊任何監聽＝這一輪根本沒開始
    expect(listeners.get('pointermove')?.size ?? 0).toBe(0)
    expect(dock.moved.value).toBe(false)
  })

  it('滑鼠右鍵不觸發拖曳', () => {
    const dock = mountDock()
    dock.fabRef.value = fakeFab(START_X, START_Y) as unknown as HTMLElement
    dock.onDragStart(pointerEvent(500, 500, { button: 2 }))
    expect(listeners.get('pointermove')?.size ?? 0).toBe(0)
  })

  it('拖到視窗外 → 當場就被夾住，按鈕不會掉出畫面', () => {
    const dock = mountDock()
    dock.fabRef.value = fakeFab(START_X, START_Y) as unknown as HTMLElement

    dock.onDragStart(pointerEvent(START_X, START_Y))
    fire('pointermove', pointerEvent(START_X + 5000, START_Y + 5000))
    fire('pointerup', pointerEvent(0, 0))

    // 錨在右下，offset 不會小於邊界留白
    expect(Number.parseInt(dock.dockStyle.value!.right!, 10)).toBeGreaterThanOrEqual(DOCK_MARGIN)
    expect(Number.parseInt(dock.dockStyle.value!.bottom!, 10)).toBeGreaterThanOrEqual(DOCK_MARGIN)
  })

  it('放開後存進 localStorage；下次開頁讀回同一個位置', () => {
    const first = mountDock()
    first.fabRef.value = fakeFab(START_X, START_Y) as unknown as HTMLElement
    first.onDragStart(pointerEvent(START_X, START_Y))
    // 拖到明確落在左半邊的位置（x≈298），錨點才會是 left
    fire('pointermove', pointerEvent(START_X - 900, START_Y - 400))
    fire('pointerup', pointerEvent(0, 0))

    const saved = JSON.parse(store.get('ta-dock-pos')!)
    expect(saved.x).toBe(START_X - 900)
    expect(saved.y).toBe(START_Y - 400)

    // 重新掛載（＝重新整理頁面）
    const second = mountDock()
    expect(second.moved.value).toBe(true)
    expect(second.dockStyle.value?.left).toBe(`${START_X - 900}px`)
  })

  it('存著的舊位置在小視窗上讓位（畫得出來），但存檔不動——回到大螢幕要回得去', () => {
    store.set('ta-dock-pos', JSON.stringify({ x: 1200, y: 700 }))
    fakeWindow.innerWidth = 400
    fakeWindow.innerHeight = 500
    try {
      const small = mountDock()
      const style = small.dockStyle.value!
      // 四個邊一定是「兩個實際值 + 兩個 auto」，實際值要是合法非負數
      // （⛔別對 'auto' 做 parseInt，會拿到 NaN——第一版測試就錯在這裡）
      for (const pair of [[style.left, style.right], [style.top, style.bottom]]) {
        const used = pair.filter(v => v !== 'auto')
        expect(used).toHaveLength(1)
        expect(Number.parseInt(used[0]!, 10)).toBeGreaterThanOrEqual(0)
      }
      // ⛔存檔不可以被夾過的值蓋掉：在手機開一次就把大螢幕擺好的位置弄掉了
      expect(JSON.parse(store.get('ta-dock-pos')!)).toEqual({ x: 1200, y: 700 })
    }
    finally {
      fakeWindow.innerWidth = 1280
      fakeWindow.innerHeight = 800
    }

    // 換回大螢幕：回到原本那個位置（右下），不是停在被夾過的地方
    const big = mountDock()
    expect(Number.parseInt(big.dockStyle.value!.right!, 10)).toBe(1280 - 1200 - DOCK_FAB_SIZE)
  })

  it('壞掉的 localStorage 值不會讓小幫手消失（回預設右下角）', () => {
    store.set('ta-dock-pos', '{"x":"壞資料"}')
    const dock = mountDock()
    expect(dock.moved.value).toBe(false)
    expect(dock.dockStyle.value).toBeUndefined()
  })

  it('移回右下角：清掉位置也清掉存檔', () => {
    const dock = mountDock()
    dock.fabRef.value = fakeFab(START_X, START_Y) as unknown as HTMLElement
    dock.onDragStart(pointerEvent(START_X, START_Y))
    fire('pointermove', pointerEvent(100, 100))
    fire('pointerup', pointerEvent(0, 0))
    expect(dock.moved.value).toBe(true)

    dock.resetPos()
    expect(dock.moved.value).toBe(false)
    expect(store.has('ta-dock-pos')).toBe(false)
  })

  it('放開之後不再繼續跟著滑鼠跑（監聽有拆乾淨）', () => {
    const dock = mountDock()
    dock.fabRef.value = fakeFab(START_X, START_Y) as unknown as HTMLElement
    dock.onDragStart(pointerEvent(START_X, START_Y))
    fire('pointermove', pointerEvent(START_X - 100, START_Y - 100))
    fire('pointerup', pointerEvent(0, 0))
    const after = dock.dockStyle.value?.right

    fire('pointermove', pointerEvent(0, 0)) // 已經沒人在聽了
    expect(dock.dockStyle.value?.right).toBe(after)
    expect(listeners.get('pointermove')?.size ?? 0).toBe(0)
  })
})
