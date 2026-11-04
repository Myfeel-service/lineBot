/**
 * 加好友邀請卡（`C-458`／`D-169`，John 哥 2026-11-04：「一回來大家就期待第一杯冰沙」）。
 *
 * 兩樣：**A4 桌牌**（印出來擺櫃台、門口）＋**分享圖**（貼 FB、IG、傳給客人）。在瀏覽器裡用 canvas 畫，
 * 畫面上看到的預覽就是下載／列印的那一張（同一張 PNG），⛔ 不另外畫一份預覽——遲早對不上。
 *
 * ⛔ **QR 直接指 LINE 官方的加好友連結**（`line.me/R/ti/p/@…`），⛔ 不先經過我們的網址再轉：
 *    印出去的東西收不回來。我們換網域（2026-08 換過一次、LIFF 連結整批壞掉）或服務停掉，
 *    經過我們的 QR 就全部變成死條碼，店家櫃台上那張也跟著壞。「哪一張比較多人掃」等真的要再說。
 * ⛔ 卡上的字不承諾 AI 會馬上回（新帳號 AI 回覆預設是關的）：只講「有問題直接在 LINE 問我們」。
 */

export type InviteCardKind = 'a4' | 'share'

export const INVITE_CARD_SIZE: Record<InviteCardKind, { w: number, h: number }> = {
  // A4 直式 150dpi（210×297mm）：家用印表機夠清楚，PNG 也不會大到存不了
  a4: { w: 1240, h: 1754 },
  // 4:5 直式：FB、IG 動態直接用，LINE 傳圖也不會被裁
  share: { w: 1080, h: 1350 },
}

export const INVITE_COPY = {
  /** A4 桌牌：人站在桌牌前面，叫他掃 */
  a4Headline: '掃我加入 LINE 好友',
  /** 分享圖：看圖的人多半就在手機上，掃不了自己的螢幕——不叫他掃，搜尋那行才是主要的路 */
  shareHeadline: '加入我們的 LINE 好友',
  sub: '有問題直接在 LINE 問我們',
  search: (basicId: string) => `或在 LINE 搜尋 ${basicId}`,
} as const

/** 系統字優先、思源當最後備援（全域規範第 12 條）；canvas 吃的是同一串 */
const FONT = '"PingFang TC", "Microsoft JhengHei", "Heiti TC", "Noto Sans TC", system-ui, sans-serif'
const INK = '#1F2937'
const MUTED = '#6B7280'
const GREEN = '#06A04A'

export interface QrMatrix {
  size: number
  isDark: (row: number, col: number) => boolean
}

/** `qrcode` 套件 `create()` 的回傳 → 我們要的樣子（套件在元件裡動態載入，這裡不依賴它） */
export function qrMatrixFrom(qr: { modules: { size: number, get: (row: number, col: number) => number | boolean } }): QrMatrix {
  return { size: qr.modules.size, isDark: (r, c) => !!qr.modules.get(r, c) }
}

export interface InviteCardData {
  /** 官方帳號在 LINE 上的名稱（⛔ 不用 MiniMe 這邊的店名：客人在 LINE 上看到的是這個） */
  name: string
  /** `@abc123` */
  basicId: string
  /** 頭像（data URL 載好的圖）；沒有就畫名字第一個字 */
  avatar: CanvasImageSource | null
}

/** 字太長就縮：從 startPx 往下每次 2px，縮到 minPx 為止 */
export function fitFontSize(measure: (px: number) => number, maxWidth: number, startPx: number, minPx: number): number {
  let px = startPx
  while (px > minPx && measure(px) > maxWidth) px -= 2
  return Math.max(px, minPx)
}

/** 縮到最小還是太長就截斷加「…」（LINE 名稱上限 20 字，正常走不到這裡） */
export function truncateToWidth(text: string, measure: (s: string) => number, maxWidth: number): string {
  if (measure(text) <= maxWidth) return text
  const chars = [...text]
  while (chars.length > 1 && measure(`${chars.join('')}…`) > maxWidth) chars.pop()
  return `${chars.join('')}…`
}

export function initialOf(name: string): string {
  return [...(name || '').trim()][0]?.toUpperCase() || '?'
}

/** 下載的檔名：店名＋哪一張（檔名不能用的字拿掉） */
export function inviteFileName(kind: InviteCardKind, name: string): string {
  const safe = [...String(name || '').replace(/[\\/:*?"<>|\s]+/g, '')].slice(0, 30).join('') || 'LINE'
  return `${safe}-邀請卡-${kind === 'a4' ? 'A4桌牌' : '分享圖'}.png`
}

/**
 * 畫 QR。模組大小取整數像素（⛔ 不縮放一張小 PNG：印到 A4 會糊、邊緣出現灰階，掃描器讀不準）。
 * 四周留 2 格白邊（quiet zone），沒有白邊的 QR 很多手機掃不到。
 * @returns 實際畫出來的邊長（置中在 box 裡）
 */
export function drawQr(ctx: CanvasRenderingContext2D, qr: QrMatrix, x: number, y: number, box: number): number {
  const QUIET = 2
  const cell = Math.max(1, Math.floor(box / (qr.size + QUIET * 2)))
  const side = cell * (qr.size + QUIET * 2)
  const ox = Math.round(x + (box - side) / 2)
  const oy = Math.round(y + (box - side) / 2)
  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(ox, oy, side, side)
  ctx.fillStyle = '#111111'
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (qr.isDark(r, c)) ctx.fillRect(ox + (c + QUIET) * cell, oy + (r + QUIET) * cell, cell, cell)
    }
  }
  return side
}

function drawAvatar(ctx: CanvasRenderingContext2D, data: InviteCardData, cx: number, cy: number, d: number) {
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, d / 2, 0, Math.PI * 2)
  ctx.closePath()
  ctx.clip()
  if (data.avatar) {
    ctx.drawImage(data.avatar, cx - d / 2, cy - d / 2, d, d)
  }
  else {
    ctx.fillStyle = GREEN
    ctx.fillRect(cx - d / 2, cy - d / 2, d, d)
    ctx.fillStyle = '#FFFFFF'
    ctx.font = `700 ${Math.round(d * 0.46)}px ${FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(initialOf(data.name), cx, cy + d * 0.02)
  }
  ctx.restore()
  // 細邊：白底上的白色頭像才看得出是一顆圓
  ctx.beginPath()
  ctx.arc(cx, cy, d / 2, 0, Math.PI * 2)
  ctx.strokeStyle = '#E5E7EB'
  ctx.lineWidth = Math.max(2, d * 0.012)
  ctx.stroke()
}

/** 置中寫一行字；太寬先縮字、縮到底再截斷 */
function centerText(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  baseline: number,
  o: { px: number, minPx?: number, weight?: number, color: string, maxWidth: number },
) {
  const weight = o.weight ?? 400
  const px = fitFontSize((p) => {
    ctx.font = `${weight} ${p}px ${FONT}`
    return ctx.measureText(text).width
  }, o.maxWidth, o.px, o.minPx ?? o.px)
  ctx.font = `${weight} ${px}px ${FONT}`
  const shown = truncateToWidth(text, s => ctx.measureText(s).width, o.maxWidth)
  ctx.fillStyle = o.color
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(shown, cx, baseline)
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/**
 * 畫整張。版面數字都是照實際輸出目測調的（A4 印出來 QR 約 10cm 寬，一公尺外掃得到）。
 * ⚠️ 改版面要重看一次輸出的 PNG：字與 QR 的上下間距是一起調的，只動一個會擠在一起。
 */
export function drawInviteCard(ctx: CanvasRenderingContext2D, kind: InviteCardKind, data: InviteCardData, qr: QrMatrix) {
  const { w, h } = INVITE_CARD_SIZE[kind]
  const cx = w / 2
  if (kind === 'a4') {
    ctx.fillStyle = '#FFFFFF'
    ctx.fillRect(0, 0, w, h)
    drawAvatar(ctx, data, cx, 250, 200)
    centerText(ctx, data.name || data.basicId, cx, 450, { px: 76, minPx: 44, weight: 700, color: INK, maxWidth: 1040 })
    drawQr(ctx, qr, (w - 760) / 2, 520, 760)
    centerText(ctx, INVITE_COPY.a4Headline, cx, 1400, { px: 76, weight: 700, color: GREEN, maxWidth: 1080 })
    centerText(ctx, INVITE_COPY.sub, cx, 1490, { px: 48, color: INK, maxWidth: 1080 })
    centerText(ctx, INVITE_COPY.search(data.basicId), cx, 1620, { px: 40, color: MUTED, maxWidth: 1080 })
    return
  }
  // 分享圖：淡綠底＋白卡，滑動態時一眼看得出是一張卡、不是一張截圖
  ctx.fillStyle = '#E8F7EE'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#FFFFFF'
  roundRect(ctx, 56, 56, w - 112, h - 112, 44)
  ctx.fill()
  drawAvatar(ctx, data, cx, 210, 160)
  centerText(ctx, data.name || data.basicId, cx, 362, { px: 62, minPx: 38, weight: 700, color: INK, maxWidth: 860 })
  drawQr(ctx, qr, (w - 540) / 2, 410, 540)
  centerText(ctx, INVITE_COPY.shareHeadline, cx, 1032, { px: 62, minPx: 50, weight: 700, color: GREEN, maxWidth: 900 })
  centerText(ctx, INVITE_COPY.sub, cx, 1106, { px: 42, color: INK, maxWidth: 900 })
  centerText(ctx, INVITE_COPY.search(data.basicId), cx, 1188, { px: 38, color: MUTED, maxWidth: 900 })
}

/**
 * A4 桌牌送去列印：開一個看不見的 iframe，裡面只有那張圖、頁面設成 A4 無邊界。
 * ⛔ 不用 `window.print()` 印整頁再用 CSS 藏東西：對話框是 append 到 body 的，藏不乾淨就會多印一頁後台。
 */
export function printA4Image(dataUrl: string) {
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0'
  frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><title>邀請卡</title>'
    + '<style>@page{size:A4 portrait;margin:0}html,body{margin:0;padding:0}img{display:block;width:210mm;height:297mm}</style>'
    + `</head><body><img src="${dataUrl}" alt=""></body></html>`
  const cleanup = () => frame.remove()
  frame.onload = () => {
    const win = frame.contentWindow
    const img = frame.contentDocument?.querySelector('img')
    const go = () => {
      if (!win) return cleanup()
      win.addEventListener('afterprint', () => setTimeout(cleanup, 500))
      win.focus()
      win.print()
      // 有的瀏覽器不發 afterprint：一分鐘後無論如何收掉
      setTimeout(cleanup, 60_000)
    }
    if (img && !img.complete) img.onload = go
    else go()
  }
  document.body.appendChild(frame)
}
