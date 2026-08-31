/**
 * 導購頁對話泡泡的「打字」效果。
 *
 * 整頁的節奏是「MiniMe 開口說話 → 底下是它端出來的東西」（見 _landing.scss 檔頭），
 * 泡泡標題本來是整句一起淡入；這裡讓它一顆字一顆字浮現，泡泡才真的像在說話。
 *
 * ⛔ 不可以用「改 textContent」那種最常見的 typewriter 寫法，三個都會壞：
 *   1. 泡泡標題裡有東西**不是純文字**——品牌名是 <img>（logo 檔本身就是 MiniMe 那個字）、
 *      強調字是 <span class="mark">（綠字＋螢光筆底）、桌機版靠 <br> 控制斷行。
 *      重寫 textContent 會把這三樣一起吃掉。
 *   2. 字一顆一顆長出來的話，泡泡會跟著變高（每顆泡泡都是兩行），整個區塊在打字過程中
 *      被往下推一次——那是版面跳動，不是動畫。
 *   3. 爬蟲／沒有 JS／「減少動態效果」的使用者要直接看到完整句子。
 * 所以做法相反：**字全部先排好**（版面一開始就是最終尺寸、DOM 裡永遠是完整句子），
 * 只是先透明，再一顆一顆亮起來。
 */

/**
 * 一個「打字單位」的切法：中文一個字算一顆，**拉丁字母與數字連在一起算一顆**。
 *
 * 為什麼拉丁字要連在一起（兩個理由，都實際會壞）：
 *   1. **斷行**：把 MiniMe／60／NT$399 拆成一個字母一個 <span> 之後，瀏覽器就可以在字母
 *      中間斷行——手機上會折出「Mini／Me」這種行。中文字之間本來就可以斷，所以不受影響。
 *   2. **節奏**：英文一個字母一顆的話，「60 秒」兩顆、「免費完成上線設定」八顆，
 *      同一句話會忽快忽慢。
 *
 * ⚠️ 空白自成一顆但不包 <span>（見 splitIntoTypingUnits）：空白沒有筆畫，藏起來也看不出來，
 *    包起來只會白白多一個空拍。
 */
const TYPING_TOKEN_RE = /\s+|[A-Za-z0-9]+(?:[$.,%+\-_/][A-Za-z0-9]+)*|./gsu

/** 把一段文字切成打字單位（保留空白，順序即原文順序）。 */
export function tokenizeForTyping(text: string): string[] {
  return text.match(TYPING_TOKEN_RE) ?? []
}

/**
 * 把泡泡標題就地拆成一顆一顆的 <span>，回傳依序要亮起來的元素。
 *
 * - 文字節點 → 每顆字一個 <span class="lp-tw__u">（空白留成純文字，不佔拍）
 * - <img>（句子裡的品牌 logo）→ 整張圖算一顆
 * - <br> → 原封不動（桌機版的斷行位置是設計決定的）
 * - 其他元素（.mark、.lp-nb）→ 往下走，外層保持不動，樣式才不會掉
 */
export function splitIntoTypingUnits(root: Element, unitClass = 'lp-tw__u'): HTMLElement[] {
  const doc = root.ownerDocument
  const units: HTMLElement[] = []

  walk(root)
  return units

  function walk(node: Node): void {
    // 先複製一份 childNodes：下面會替換節點，邊走邊改活的 NodeList 會漏掉元素
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        const text = child.nodeValue ?? ''
        if (!text) continue
        const frag = doc.createDocumentFragment()
        for (const token of tokenizeForTyping(text)) {
          if (!token.trim()) {
            frag.appendChild(doc.createTextNode(token))
            continue
          }
          const span = doc.createElement('span')
          span.className = unitClass
          span.textContent = token
          frag.appendChild(span)
          units.push(span)
        }
        node.replaceChild(frag, child)
        continue
      }
      if (child.nodeType !== 1) continue
      const el = child as HTMLElement
      if (el.tagName === 'BR') continue
      if (el.tagName === 'IMG') {
        el.classList.add(unitClass)
        units.push(el)
        continue
      }
      walk(el)
    }
  }
}

/**
 * 三顆點跳多久才開始打字。太長會變成「等它講話」，太短就看不出來在想。
 * ⚠️ 這段時間泡泡是空的（版面已經撐到最終尺寸），所以刻意壓短——它跟 .lp-reveal 的淡入
 *    重疊，點在跳的時候泡泡本身還只有半透明，空白比較不明顯。
 */
const DOTS_MS = 240
/** 一顆字的間隔。2026-08-30 老闆說「速度慢一點」，從 34 放慢到 55。 */
const UNIT_MS = 55
/**
 * 純打字（不含停頓）的總長上限：字多的句子自動打快一點。
 * ⚠️ 有這個上限才不會「某一區的標題比較長，就要多等一大截」。⛔別調太小：上限一低，長句子
 *    的速度就跟短句子差很多，同一頁看起來像兩種打字。現在最長那顆是 48ms／字、最短的 55ms，
 *    差 13% 看不出來。
 */
const MAX_TYPE_MS = 1500
/**
 * 換行的呼吸時間（2026-08-30 老闆：「換行的時候有一些呼吸時間，會更像打字效果」）。
 * 停頓期間游標還在原地閃，所以看起來是「它在想下一句」而不是「卡住了」。
 */
const LINE_PAUSE_MS = 190
/** 換段（標題打完、要開始打底下那句副標）停久一點——那是換一句話，不只是換一行。 */
const BLOCK_PAUSE_MS = 340
/** 打完到收尾（拿掉游標、螢光筆刷上去）之間的停頓。 */
const TAIL_MS = 120

/**
 * 排出「第幾顆字在第幾毫秒出現」，換行與換段的地方多留呼吸時間。
 *
 * ⚠️ 換行**不能靠 `<br>` 判斷**：桌機版的斷行是 `<br>` 排的，但手機版（≤720px）
 *    CSS 把 `.lp-bubble h2 br` 收掉讓文字自然流——照 `<br>` 停頓的話，手機上會在
 *    「句子中間」莫名其妙停一下，真正的換行處反而不停。所以改成**量真實版面**：
 *    每顆字的位置往下跳了一行，就是換行，桌機手機都對。
 *
 * ⚠️ 門檻用「字級的六成」不是「位置不一樣就算換行」：句子裡的品牌 logo 是圖片，
 *    高度跟旁邊的字不同，同一行上的位置本來就差幾 px（差多少看字級，不是固定值）。
 *    真正換一行是差一整個行高，兩者差很遠，不會誤判。
 *
 * ⚠️ 量的時機是**捲到才量**（play 當下），不是掛載時：字型還在載入的話版面會再變一次。
 *    這裡一口氣讀完所有位置、中間不寫入 DOM，所以只會觸發一次版面計算。
 */
function buildSchedule(
  units: HTMLElement[],
  blocks: (HTMLElement | null)[],
  step: number,
): { startAt: number[], total: number } {
  const tops = units.map(u => u.getBoundingClientRect().top)
  const lineThreshold = new Map<HTMLElement | null, number>()
  const startAt: number[] = []
  let at = 0

  for (let i = 0; i < units.length; i++) {
    if (i > 0) {
      at += step
      const block = blocks[i]!
      if (block !== blocks[i - 1]) {
        at += BLOCK_PAUSE_MS
      }
      else {
        if (!lineThreshold.has(block)) {
          const size = block ? Number.parseFloat(getComputedStyle(block).fontSize) : 16
          lineThreshold.set(block, (Number.isFinite(size) ? size : 16) * 0.6)
        }
        if (tops[i]! - tops[i - 1]! > lineThreshold.get(block)!) at += LINE_PAUSE_MS
      }
    }
    startAt.push(at)
  }
  return { startAt, total: at + step }
}

export interface BubbleTyping {
  /** 捲到這一區時呼叫，開始演。重複呼叫只會演一次。 */
  play: () => void
  /** 離開頁面時呼叫：停掉 rAF 並讓句子留在完整狀態。 */
  cancel: () => void
}

/**
 * 準備一顆泡泡的打字效果（拆字＋插入「正在輸入」的三顆點），回傳播放控制。
 *
 * ⚠️ 拆字刻意在**掛載當下**就做完，不是等捲到才做：捲到才拆的話，那一幀要同時做
 *    DOM 改寫與淡入動畫，第一顆字會卡一下。這時候泡泡還是 opacity:0（.lp-reveal），
 *    所以拆字過程看不到。
 *
 * 回傳 null＝這顆泡泡沒有可打的東西，或已經準備過了。
 */
export function prepareBubbleTyping(turn: HTMLElement): BubbleTyping | null {
  const bubble = turn.querySelector<HTMLElement>('.lp-bubble')
  const heading = bubble?.querySelector<HTMLElement>('h2')
  if (!bubble || !heading || bubble.dataset.typing === '1') return null

  // ⚠️ 拆的是**整顆泡泡**不是只有標題：五顆泡泡裡有兩顆帶一句副標（「還好，每一關都有
  //    AI 能接住的解法——」），只拆標題的話副標會從第一幀就完整躺在那裡——標題還在打點點，
  //    答案已經先講完了。一顆泡泡＝一則訊息，要打就整則一起打。
  const units = splitIntoTypingUnits(bubble)
  if (!units.length) return null
  bubble.dataset.typing = '1'

  // 每顆字屬於哪一段（標題 h2 或副標 p）——換段要停比換行更久，見 BLOCK_PAUSE_MS
  const blocks = units.map(u => u.closest('h2, p') as HTMLElement | null)

  // is-typing＝「還沒講完」：字先透明、螢光筆先不畫（螢光筆是畫在整段 .mark 上的，
  // 不先關掉的話，字還沒出現就會先看到一條綠色底線浮在空泡泡裡）。
  turn.classList.add('is-typing')

  const dots = bubble.ownerDocument.createElement('span')
  dots.className = 'lp-tw__dots'
  dots.setAttribute('aria-hidden', 'true')
  dots.innerHTML = '<i></i><i></i><i></i>'
  // 放在標題最前面＋絕對定位＝停在第一個字的位置，不吃版面（不會把第一行推開）
  heading.prepend(dots)

  let raf = 0
  let started = false
  let head: HTMLElement | null = null

  function done(): void {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    head?.classList.remove('is-head')
    head = null
    for (const unit of units) unit.classList.add('is-on')
    turn.classList.remove('is-typing')
    dots.remove()
  }

  return {
    play() {
      if (started) return
      started = true
      const step = Math.min(UNIT_MS, MAX_TYPE_MS / units.length)
      const schedule = buildSchedule(units, blocks, step)
      const startedAt = performance.now()
      let shown = 0

      const tick = (now: number): void => {
        const elapsed = now - startedAt
        if (elapsed >= DOTS_MS) {
          dots.classList.add('is-out')
          const typed = elapsed - DOTS_MS
          if (shown < units.length && typed >= schedule.startAt[shown]!) {
            head?.classList.remove('is-head')
            while (shown < units.length && typed >= schedule.startAt[shown]!) units[shown++]!.classList.add('is-on')
            head = units[shown - 1]!
            head.classList.add('is-head')
          }
        }
        if (elapsed >= DOTS_MS + schedule.total + TAIL_MS) { done(); return }
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
    },
    cancel: done,
  }
}
