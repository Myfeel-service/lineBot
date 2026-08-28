/**
 * 小幫手的停靠位置（可拖移，2026-08-27 老闆要求）。
 *
 * 為什麼要有這個：小幫手釘死在右下角，而右下角常常正好壓著使用者要看／要按的東西
 * （對話頁的輸入框、長表格最後一列的操作鈕、抽屜與彈窗的按鈕列）。原本唯一的解法是
 * 開開關關面板去偷看被壓住的內容——所以讓他把它拖到不擋事的地方，並且記住。
 *
 * ⛔ 三條紀律（改這裡之前先讀）：
 * 1. **整顆按鈕永遠看得見**：任何來源的座標（存下來的舊值、拖曳中、視窗縮小後）
 *    都要過 `clampDockPos`。掉到視窗外＝使用者永遠點不到小幫手，而他也不會知道
 *    「它在畫面外」——只會覺得功能消失了。
 * 2. **拖曳不可以吃掉點擊**：移動沒超過 `DOCK_DRAG_THRESHOLD` 就還是「開面板」。
 *    手一抖就打不開，比不能拖更糟。
 * 3. **面板往有空間的那一邊長**：位置決定要錨哪兩個邊（`dockAnchors`）。
 *    拖到左上角時面板要往右下開；沿用「永遠往左上開」的話，面板會整片跑到視窗外。
 *
 * 位置存在 localStorage（**不分工作區**）：這是「這台電腦上這個人的順手位置」，
 * 不是帳號設定——換工作區不該把它移回去。
 */

export interface DockPos {
  /** 浮動按鈕左上角的視窗座標（px） */
  x: number
  y: number
}

/** 浮動按鈕尺寸，對齊 `.ta-fab` 的 58px */
export const DOCK_FAB_SIZE = 58
/** 與視窗邊緣至少留這麼多，免得半顆貼在邊上很難按 */
export const DOCK_MARGIN = 12
/** 超過這個位移才算「在拖」，以下都算「點一下」 */
export const DOCK_DRAG_THRESHOLD = 4
/** 按鈕與面板之間的間距，對齊 `.tutorial-agent` 的 gap（0.75rem） */
const DOCK_STACK_GAP = 12
/**
 * 面板的最低高度：再怎麼擠也要看得到標頭加一張卡，否則不如不縮。
 *
 * ⛔ 這裡刻意**不估算**「標頭＋頁尾佔幾 px」。第一版估 96px、headless 實測是 114px
 * （頁尾在窄面板會換行、標頭 padding 也不是固定值），於是拖到畫面中央時面板底部
 * 超出視窗 6px——而且是那種只有量盒模型才看得到的錯。現在改成把上限套在面板本體
 * （`--ta-dock-panelh`），內容區用 flex 自己縮：真實外框高度讓瀏覽器算，我們不猜。
 */
const DOCK_MIN_PANEL = 220
/** 面板最窄寬度：拖到畫面正中間時寧可讓它超出一點，也不要壓成一條 */
const DOCK_MIN_WIDTH = 280

const STORE_KEY = 'ta-dock-pos'

/**
 * 把位置夾回「整顆按鈕都看得見」的範圍。
 * 純函式，因為它是這支唯一「錯了會讓功能整個消失」的地方（見檔頭紀律 1）。
 */
export function clampDockPos(
  pos: DockPos,
  vw: number,
  vh: number,
  size = DOCK_FAB_SIZE,
  margin = DOCK_MARGIN,
): DockPos {
  // 視窗比按鈕還小的極端情況（手機橫豎切換的瞬間）：上界會小於下界，
  // 取 max 保證至少貼著左上角，不要回一個 NaN 或負數
  const maxX = Math.max(margin, vw - size - margin)
  const maxY = Math.max(margin, vh - size - margin)
  return {
    x: Math.min(Math.max(pos.x, margin), maxX),
    y: Math.min(Math.max(pos.y, margin), maxY),
  }
}

export interface DockAnchors {
  /** 錨在左邊還是右邊（面板會從這一側往另一側長） */
  side: 'left' | 'right'
  /** 錨在上面還是下面 */
  vertical: 'top' | 'bottom'
  /** 直接掛到容器上的 inline style */
  style: Record<string, string>
}

/**
 * 從位置推出「四個邊怎麼錨、面板還剩多少空間」。
 *
 * 錨點取「按鈕中心離哪一邊近」——這同時決定面板往哪邊開，所以按鈕在左半邊時
 * 面板往右長、在上半邊時往下長，永遠開在有空間的那一側。
 * 兩個 CSS 變數（`--ta-dock-maxw`／`--ta-dock-panelh`）讓面板在剩餘空間不足時
 * 自己縮，而不是溢出視窗。
 */
export function dockAnchors(
  pos: DockPos,
  vw: number,
  vh: number,
  size = DOCK_FAB_SIZE,
  margin = DOCK_MARGIN,
): DockAnchors {
  const side = pos.x + size / 2 > vw / 2 ? 'right' : 'left'
  const vertical = pos.y + size / 2 > vh / 2 ? 'bottom' : 'top'
  const hOffset = side === 'left' ? pos.x : Math.max(0, vw - pos.x - size)
  const vOffset = vertical === 'top' ? pos.y : Math.max(0, vh - pos.y - size)
  const availW = Math.max(DOCK_MIN_WIDTH, vw - hOffset - margin)
  // 面板可用高度＝錨邊到對邊，扣掉同一疊裡的浮動按鈕與間距
  const panelH = Math.max(DOCK_MIN_PANEL, vh - vOffset - margin - size - DOCK_STACK_GAP)
  return {
    side,
    vertical,
    style: {
      left: side === 'left' ? `${Math.round(hOffset)}px` : 'auto',
      right: side === 'right' ? `${Math.round(hOffset)}px` : 'auto',
      top: vertical === 'top' ? `${Math.round(vOffset)}px` : 'auto',
      bottom: vertical === 'bottom' ? `${Math.round(vOffset)}px` : 'auto',
      '--ta-dock-maxw': `${Math.round(availW)}px`,
      '--ta-dock-panelh': `${Math.round(panelH)}px`,
    },
  }
}

export function useAgentDock() {
  /** null＝沒搬過，用 CSS 的預設右下角（不要在這裡複製一份預設座標，會有兩套真相） */
  const pos = useState<DockPos | null>('agent-dock-pos', () => null)
  const dragging = ref(false)
  const vw = ref(0)
  const vh = ref(0)
  /** 這一次手勢到底是「拖」還是「點」；由 consumeDrag 讀走 */
  const wasDrag = ref(false)

  const fabRef = ref<HTMLElement | null>(null)

  /**
   * 呈現用的錨點。**夾範圍在這裡做，不寫回 `pos`**——
   * `pos` 存的是「使用者實際把它放在哪」，夾範圍只是「這個視窗現在畫得出來的位置」。
   * 混在一起的後果：在手機或縮小的視窗開一次，就把使用者在大螢幕擺好的位置永久改掉了
   * （縮回去也回不來）。分開之後，視窗變小時它會自己讓位，變大時回到原本那個位置。
   */
  const anchors = computed<DockAnchors | null>(() =>
    pos.value && vw.value && vh.value
      ? dockAnchors(clampDockPos(pos.value, vw.value, vh.value), vw.value, vh.value)
      : null,
  )
  const dockStyle = computed(() => anchors.value?.style)
  const dockSide = computed(() => anchors.value?.side ?? 'right')
  const dockVertical = computed(() => anchors.value?.vertical ?? 'bottom')
  /** 有沒有被搬過——面板要不要給「移回右下角」的退路看這個 */
  const moved = computed(() => pos.value !== null)

  function persist() {
    try {
      if (pos.value)
        localStorage.setItem(STORE_KEY, JSON.stringify(pos.value))
      else
        localStorage.removeItem(STORE_KEY)
    }
    catch {}
  }

  function resetPos() {
    pos.value = null
    persist()
  }

  // ── 拖曳 ────────────────────────────────────────────────
  let startPointer = { x: 0, y: 0 }
  let startPos: DockPos = { x: 0, y: 0 }
  let activeId: number | null = null

  function onDragStart(e: PointerEvent) {
    // 滑鼠只吃左鍵；右鍵/中鍵不該把東西拖走
    if (e.pointerType === 'mouse' && e.button !== 0)
      return
    // 從**別的**按鈕上按下去的不算拖曳（面板標頭裡的分頁鈕、關閉鈕）。
    // ⛔ 一定要擋：setPointerCapture 會把後續事件改派到捕獲元件，click 的目標就變成
    //    標頭而不是那顆按鈕——分頁與關閉鈕會整個點不動。
    // ⛔ 但要排除「把手自己就是一顆按鈕」的情形：浮動按鈕本身就是 <button>，
    //    只寫 closest('button') 的話它每次都命中自己 → 一按下就 return，
    //    拖曳完全不會啟動（2026-08-27 交出去的第一版就是這個 bug，
    //    而當時的測試把 target.closest 假造成永遠回 null，所以照樣綠燈）。
    const pressedButton = (e.target as HTMLElement | null)?.closest('button')
    if (pressedButton && pressedButton !== e.currentTarget)
      return
    // 還沒搬過時沒有座標可算 delta，就地量按鈕現在在哪（CSS 排出來的右下角）
    const rect = fabRef.value?.getBoundingClientRect()
    startPos = pos.value ?? (rect ? { x: rect.left, y: rect.top } : { x: 0, y: 0 })
    startPointer = { x: e.clientX, y: e.clientY }
    activeId = e.pointerId
    // 每次手勢開頭都清掉，否則「從標頭拖完（沒有 click）」的旗標會留到下一次
    // 真的點按鈕時才被讀到，變成第一下點不開
    wasDrag.value = false
    window.addEventListener('pointermove', onDragMove)
    window.addEventListener('pointerup', onDragEnd)
    window.addEventListener('pointercancel', onDragEnd)
    // 捕獲指標＝游標移出視窗時仍收得到事件（拖到邊緣才不會斷）。
    // ⛔ 但它**會丟例外**（NotFoundError：指標已經放開、或不是作用中的指標），
    //    所以一定要排在註冊監聽**之後**並且包起來——放前面又沒包的話，
    //    一丟例外後面三行就不會執行，拖曳會靜靜地完全失效、畫面上什麼線索都沒有。
    try {
      (e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId)
    }
    catch {}
  }

  function onDragMove(e: PointerEvent) {
    if (activeId !== null && e.pointerId !== activeId)
      return
    const dx = e.clientX - startPointer.x
    const dy = e.clientY - startPointer.y
    if (!wasDrag.value && Math.hypot(dx, dy) < DOCK_DRAG_THRESHOLD)
      return
    wasDrag.value = true
    dragging.value = true
    pos.value = clampDockPos({ x: startPos.x + dx, y: startPos.y + dy }, vw.value, vh.value)
  }

  function onDragEnd() {
    window.removeEventListener('pointermove', onDragMove)
    window.removeEventListener('pointerup', onDragEnd)
    window.removeEventListener('pointercancel', onDragEnd)
    activeId = null
    dragging.value = false
    if (wasDrag.value)
      persist()
  }

  /**
   * 這次的點擊是不是拖曳的尾巴（是就別開面板）。讀完即清——
   * click 緊接在 pointerup 之後發生，所以旗標的壽命只有一個手勢。
   */
  function consumeDrag(): boolean {
    const was = wasDrag.value
    wasDrag.value = false
    return was
  }

  /**
   * 視窗尺寸變了只要更新尺寸就好：`anchors` 會用新尺寸重算，該讓位就讓位。
   * ⛔不要在這裡改 `pos` 或寫 localStorage（理由見 `anchors` 的註解）。
   */
  function syncViewport() {
    vw.value = window.innerWidth
    vh.value = window.innerHeight
  }

  onMounted(() => {
    syncViewport()
    try {
      const raw = localStorage.getItem(STORE_KEY)
      if (raw) {
        const saved = JSON.parse(raw) as Partial<DockPos> | null
        // 只驗「是不是數字」，不在這裡夾——呈現時才夾（舊座標在大螢幕上要回得去）
        if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y))
          pos.value = { x: saved!.x!, y: saved!.y! }
      }
    }
    catch {}
    window.addEventListener('resize', syncViewport)
  })

  onBeforeUnmount(() => {
    window.removeEventListener('resize', syncViewport)
    onDragEnd()
  })

  return {
    fabRef,
    dockStyle,
    dockSide,
    dockVertical,
    dragging,
    moved,
    onDragStart,
    consumeDrag,
    resetPos,
  }
}
