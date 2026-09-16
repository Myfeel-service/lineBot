/**
 * 圖文選單底圖的合成（`C-193`）。
 *
 * 分工是這樣：**AI 只畫氣氛，格子與字由我們自己疊上去**。
 * ⛔ 讓模型把整張選單畫出來的話，看得到的按鈕跟按得到的區域一定對不齊——
 *    而客人點了沒反應這件事，在後台畫面上完全看不出來（你看到的是一張好看的圖）。
 *    所以這裡疊字用的座標，就是等一下真的會送去 LINE 的那一份可點區域。
 *
 * 這個檔分兩半：
 * - `planRichMenuOverlay`：純算式，不碰畫布，可以單獨測（會出錯的都在這裡：
 *   座標超出畫布、寬高是 0、字級算成負的）。
 * - `composeRichMenuImage`：薄薄一層畫布操作，照著上面算好的東西畫。
 */

export interface OverlayArea {
  /** 實際會送去 LINE 的可點區域（像素） */
  bounds: { x: number, y: number, width: number, height: number }
  /** 要印在這一格上的字；空字串＝這一格不印字 */
  label: string
}

export interface OverlayPlan {
  /** 這一格的框（已經夾回畫布範圍內） */
  x: number
  y: number
  w: number
  h: number
  /** 字要放的位置（框的正中央） */
  cx: number
  cy: number
  /** 建議字級（像素） */
  fontSize: number
  label: string
}

/** 字級上下限：太小看不清楚，太大會撞到隔壁格 */
const MIN_FONT = 22
const MAX_FONT = 104

/**
 * 算出每一格要畫在哪、字多大。
 *
 * ⛔ 會把框夾回畫布內：自訂版型可以把區塊拖到超出邊界，直接拿去畫會畫到畫布外
 *    （畫布不會報錯，就是**靜靜少一塊**，而且你以為它畫好了）。
 * ⛔ 夾完寬或高變成 0 的就整格丟掉，並且是**跳過不是中斷**——
 *    中斷的話後面那幾格連看都沒看過。
 */
export function planRichMenuOverlay(
  areas: readonly OverlayArea[],
  canvasW: number,
  canvasH: number,
): OverlayPlan[] {
  const plans: OverlayPlan[] = []
  if (!(canvasW > 0) || !(canvasH > 0)) return plans

  for (const a of areas ?? []) {
    const bx = Number(a?.bounds?.x ?? 0)
    const by = Number(a?.bounds?.y ?? 0)
    const bw = Number(a?.bounds?.width ?? 0)
    const bh = Number(a?.bounds?.height ?? 0)
    if (!Number.isFinite(bx) || !Number.isFinite(by) || !Number.isFinite(bw) || !Number.isFinite(bh)) continue

    const x = Math.max(0, Math.min(bx, canvasW))
    const y = Math.max(0, Math.min(by, canvasH))
    const w = Math.max(0, Math.min(bx + bw, canvasW) - x)
    const h = Math.max(0, Math.min(by + bh, canvasH) - y)
    if (w <= 0 || h <= 0) continue

    const label = String(a?.label ?? '').trim()
    // 字級同時看高度與寬度：細長的格子要靠寬度收斂，否則字會凸出去
    const byHeight = h * 0.3
    const byWidth = label.length ? (w * 0.9) / Math.max(1, label.length) : w * 0.3
    const fontSize = Math.round(Math.max(MIN_FONT, Math.min(MAX_FONT, byHeight, byWidth)))

    plans.push({ x, y, w, h, cx: x + w / 2, cy: y + h / 2, fontSize, label })
  }
  return plans
}

/**
 * 把底圖與格子合成一張圖，回傳 data URL（JPEG）。
 *
 * ⚠️ 一定要輸出 JPEG 並控制品質：LINE 那邊我們自己的上限是 **500KB**，
 *    2500 寬的 PNG 幾乎一定超過，而超過的症狀是「存檔時才失敗」。
 *
 * @param backgroundDataUrl AI 產生的底圖；給 null 就用純色底
 */
export async function composeRichMenuImage(opts: {
  backgroundDataUrl: string | null
  areas: readonly OverlayArea[]
  width: number
  height: number
  /** 沒有底圖時的底色 */
  fallbackColor?: string
  maxBytes?: number
}): Promise<{ dataUrl: string, bytes: number }> {
  const { width, height, areas } = opts
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('這個瀏覽器不支援畫布合成，請改用上傳圖片。')

  ctx.fillStyle = opts.fallbackColor ?? '#1F2937'
  ctx.fillRect(0, 0, width, height)

  if (opts.backgroundDataUrl) {
    const img = await loadImage(opts.backgroundDataUrl)
    // 底圖比例跟選單不一定一樣：用 cover 裁切，⛔不要拉伸（拉伸過的底圖一眼看得出來）
    const scale = Math.max(width / img.width, height / img.height)
    const dw = img.width * scale
    const dh = img.height * scale
    ctx.drawImage(img, (width - dw) / 2, (height - dh) / 2, dw, dh)
  }

  const plans = planRichMenuOverlay(areas, width, height)
  const line = Math.max(2, Math.round(width / 800))

  for (const p of plans) {
    // 每一格壓一層暗幕：底圖再花，白字也讀得到
    ctx.fillStyle = 'rgba(0,0,0,0.30)'
    ctx.fillRect(p.x, p.y, p.w, p.h)
    // 格線畫在格子內側，⛔不要畫在邊界上（相鄰兩格會疊成雙線粗細不一）
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'
    ctx.lineWidth = line
    ctx.strokeRect(p.x + line / 2, p.y + line / 2, p.w - line, p.h - line)

    if (!p.label) continue
    ctx.font = `600 ${p.fontSize}px "PingFang TC", "Hiragino Sans TC", "Microsoft JhengHei", sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillText(p.label, p.cx + line, p.cy + line)
    ctx.fillStyle = '#FFFFFF'
    ctx.fillText(p.label, p.cx, p.cy)
  }

  // 由高到低試品質，第一個塞得進上限的就用它
  const maxBytes = opts.maxBytes ?? 500 * 1024
  let last = canvas.toDataURL('image/jpeg', 0.92)
  for (const q of [0.92, 0.85, 0.75, 0.65, 0.55, 0.45]) {
    last = canvas.toDataURL('image/jpeg', q)
    if (dataUrlBytes(last) <= maxBytes) break
  }
  return { dataUrl: last, bytes: dataUrlBytes(last) }
}

/** data URL 解出來大概幾個位元組（base64 每 4 個字元 3 個位元組） */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding)
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('底圖讀不進來'))
    img.src = src
  })
}
