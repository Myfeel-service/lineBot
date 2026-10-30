/**
 * 商品頁的封面圖 → 我們 Storage 上的 JPG（`C-435`，`D-166` ⑤「商品的事都在試算表做」）。
 *
 * **為什麼要有**：上新商品只改試算表、不用另外傳圖。商品頁的 `og:image` 就是店家自己做的主視覺
 * （2026-10-30 唯讀抓 MYFEEL 3 頁：1200×675、印著商品名），但格式是 GIF／WebP，LINE 只收 JPG／PNG，所以要轉。
 *
 * **轉檔工具全是純 JavaScript**（GIF：omggif、PNG：pngjs、JPEG：jpeg-js、WebP：@jsquash/webp 的 .wasm）：
 * 正式站是 Lambda，裝要原生編譯的套件（例如 sharp）要賭打包與主機架構對不對得上；這幾個在哪裡跑都一樣。
 *
 * WebP 解碼器的 .wasm 複製一份放在 `server/assets/webp-codec/`：那個資料夾正式站會整包內嵌進程式（Nitro 的 server assets），
 * 不靠讀檔。⛔ 不能直接指 node_modules 裡那一份——打包工具會把 node_modules 的路徑改寫成套件名、讀不到，整個 build 失敗
 * （2026-10-30 本機 build 實際撞到兩次）。⚠️ 換 @jsquash/webp 版本要一起換這個檔，測試會比對兩份一不一樣。
 */
import { createHash } from 'node:crypto'
import omggif from 'omggif'
import jpeg from 'jpeg-js'
import { PNG } from 'pngjs'
import decodeWebp, { init as initWebp } from '@jsquash/webp/decode.js'
import { getStorage } from './firebase'
import { fetchPublicBytes, fetchPublicText } from './safe-fetch'
import type { SheetProductImageFailReason } from '~~/shared/sheet-products'

const FETCH_HEADERS = { 'User-Agent': 'LineBotKnowledgeFetcher/1.0' }
/** 商品頁只看 <head> 的 meta，前面一段就夠 */
const PAGE_MAX_BYTES = 1_500_000
const IMAGE_MAX_BYTES = 8 * 1024 * 1024
/** 目錄卡片與商品資訊卡都用不到更寬；MYFEEL 的封面圖剛好 1200 */
export const COVER_MAX_WIDTH = 1200
const JPEG_QUALITY = 85
/** 小於這個不像封面圖（追蹤用的 1×1 像素圖之類） */
const MIN_SIDE = 100
/** 解碼前先擋太大的圖（像素數），避免把 Lambda 記憶體吃光 */
const MAX_PIXELS = 25_000_000

const META_TAG = /<meta\b[^>]*>/gi
const ATTR = /([a-zA-Z:_-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g
const COVER_KEYS = ['og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src']

const decodeEntities = (s: string) => s.replace(/&amp;/g, '&').replace(/&#38;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, '\'')

/**
 * 從商品頁的 HTML 找封面圖網址（`og:image:secure_url` → `og:image` → `twitter:image`），相對網址照商品頁補齊。
 * 找不到、或不是 http(s)＝null。
 */
export function extractCoverImageUrl(html: string, pageUrl: string): string | null {
  const found = new Map<string, string>()
  for (const tag of String(html ?? '').match(META_TAG) ?? []) {
    const attrs: Record<string, string> = {}
    for (const m of tag.matchAll(ATTR)) attrs[m[1]!.toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? ''
    const key = (attrs.property ?? attrs.name ?? '').toLowerCase().trim()
    const content = decodeEntities((attrs.content ?? '').trim())
    if (key && content && COVER_KEYS.includes(key) && !found.has(key)) found.set(key, content)
  }
  for (const k of COVER_KEYS) {
    const raw = found.get(k)
    if (!raw) continue
    try {
      const u = new URL(raw, pageUrl)
      if (u.protocol === 'https:' || u.protocol === 'http:') return u.href
    }
    catch { /* 下一個 */ }
  }
  return null
}

type Rgba = { width: number, height: number, data: Uint8Array | Uint8ClampedArray }

export function sniffImageKind(b: Uint8Array): 'gif' | 'png' | 'jpeg' | 'webp' | null {
  if (b.length < 12) return null
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'png'
  if (b[0] === 0xFF && b[1] === 0xD8) return 'jpeg'
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to))
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp'
  return null
}

/** 伺服器資源裡那份解碼器（`server/assets/webp-codec/webp_dec.wasm`）的鍵 */
export const WEBP_WASM_ASSET_KEY = 'webp-codec:webp_dec.wasm'

let webpReady: Promise<void> | null = null
/** WebP 解碼器：正式站與本機 dev 從伺服器資源讀 .wasm；測試（沒有 Nitro）直接讀同一個檔 */
function ensureWebpDecoder(): Promise<void> {
  webpReady ??= (async () => {
    let bytes: Uint8Array | null = null
    try {
      if (typeof useStorage === 'function') {
        const raw = await useStorage('assets:server').getItemRaw(WEBP_WASM_ASSET_KEY)
        if (raw) bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer)
      }
    }
    catch { /* 退回讀檔 */ }
    if (!bytes) {
      const { readFile } = await import('node:fs/promises')
      const { dirname, join } = await import('node:path')
      const { fileURLToPath } = await import('node:url')
      bytes = await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'webp-codec', 'webp_dec.wasm'))
    }
    await initWebp(await WebAssembly.compile(bytes as BufferSource))
  })().catch((e) => {
    webpReady = null // 這次失敗下次再試
    throw e
  })
  return webpReady
}

/**
 * PNG／WebP 檔頭寫的寬高（不解碼）；讀不出來＝null。
 * `C-438` code review：⛔ 這兩種以前是整張解成 RGBA 之後才比大小——一張 10000×10000 的高壓縮 PNG 先吃掉 400 MB 才丟「圖太大」，
 * 排程主機上同一輪的扣款、轉真人提醒會一起被記憶體不足拖垮。GIF、JPEG 本來就先看大小。
 */
export function imageHeaderSize(b: Uint8Array, kind: 'png' | 'webp'): { width: number, height: number } | null {
  const u16 = (i: number) => b[i]! | (b[i + 1]! << 8)
  const u24 = (i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)
  if (kind === 'png') {
    if (b.length < 24) return null
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (b.length < 30) return null
  const chunk = String.fromCharCode(...b.subarray(12, 16))
  if (chunk === 'VP8 ') return { width: u16(26) & 0x3FFF, height: u16(28) & 0x3FFF }
  if (chunk === 'VP8L') {
    const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0
    return { width: (bits & 0x3FFF) + 1, height: ((bits >>> 14) & 0x3FFF) + 1 }
  }
  if (chunk === 'VP8X') return { width: u24(24) + 1, height: u24(27) + 1 }
  return null
}

/** 任何一種圖 → RGBA（GIF 取第一格）。看不懂、太小、太大都丟錯 */
export async function decodeToRgba(bytes: Uint8Array): Promise<Rgba> {
  const kind = sniffImageKind(bytes)
  if (kind === 'png' || kind === 'webp') {
    const size = imageHeaderSize(bytes, kind)
    if (size && size.width * size.height > MAX_PIXELS) throw new Error('圖太大')
  }
  let img: Rgba
  if (kind === 'gif') {
    const r = new omggif.GifReader(bytes)
    if (r.width * r.height > MAX_PIXELS) throw new Error('圖太大')
    const data = new Uint8ClampedArray(r.width * r.height * 4)
    r.decodeAndBlitFrameRGBA(0, data)
    img = { width: r.width, height: r.height, data }
  }
  else if (kind === 'png') {
    const p = PNG.sync.read(Buffer.from(bytes))
    img = { width: p.width, height: p.height, data: p.data }
  }
  else if (kind === 'jpeg') {
    const j = jpeg.decode(bytes, { useTArray: true, maxResolutionInMP: MAX_PIXELS / 1_000_000 })
    img = { width: j.width, height: j.height, data: j.data }
  }
  else if (kind === 'webp') {
    await ensureWebpDecoder()
    const d = await decodeWebp(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
    img = { width: d.width, height: d.height, data: d.data }
  }
  else {
    throw new Error('看不懂的圖片格式')
  }
  if (img.width < MIN_SIDE || img.height < MIN_SIDE) throw new Error('圖太小')
  if (img.width * img.height > MAX_PIXELS) throw new Error('圖太大')
  return img
}

/** RGBA → JPG：透明的地方鋪白（JPG 沒有透明），比 maxWidth 寬就等比例縮（區塊平均，不會鋸齒） */
export function encodeJpeg(img: Rgba, maxWidth = COVER_MAX_WIDTH): { bytes: Buffer, width: number, height: number } {
  let { width, height, data } = img
  if (width > maxWidth) {
    const w = maxWidth
    const h = Math.max(1, Math.round(height * maxWidth / width))
    const out = new Uint8ClampedArray(w * h * 4)
    const sx = width / w
    const sy = height / h
    for (let y = 0; y < h; y++) {
      const y0 = Math.floor(y * sy)
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy))
      for (let x = 0; x < w; x++) {
        const x0 = Math.floor(x * sx)
        const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx))
        let r = 0, g = 0, b = 0, a = 0, n = 0
        for (let yy = y0; yy < y1; yy++) {
          for (let xx = x0; xx < x1; xx++) {
            const i = (yy * width + xx) * 4
            r += data[i]!; g += data[i + 1]!; b += data[i + 2]!; a += data[i + 3]!; n++
          }
        }
        const o = (y * w + x) * 4
        out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n
      }
    }
    width = w
    height = h
    data = out
  }
  else {
    data = new Uint8ClampedArray(data) // 不改到呼叫端的那一份
  }
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]! / 255
    if (a < 1) {
      data[i] = data[i]! * a + 255 * (1 - a)
      data[i + 1] = data[i + 1]! * a + 255 * (1 - a)
      data[i + 2] = data[i + 2]! * a + 255 * (1 - a)
      data[i + 3] = 255
    }
  }
  const encoded = jpeg.encode({ width, height, data: data as unknown as Buffer }, JPEG_QUALITY)
  return { bytes: Buffer.from(encoded.data), width, height }
}

export type CoverFetchResult =
  | { ok: true, jpeg: Buffer, imageUrl: string, width: number, height: number }
  | { ok: false, reason: SheetProductImageFailReason, detail: string }

/** 商品頁 → 封面圖 JPG（不寫任何東西）。每一步失敗都講得出是哪一步 */
export async function fetchProductCover(pageUrl: string): Promise<CoverFetchResult> {
  let html: string
  try {
    const page = await fetchPublicText(pageUrl, { timeoutMs: 6_000, maxBytes: PAGE_MAX_BYTES, headers: FETCH_HEADERS })
    if (!page.ok) return { ok: false, reason: 'pageUnreachable', detail: `商品頁回 ${page.status}` }
    html = page.text
  }
  catch (e: any) {
    return { ok: false, reason: 'pageUnreachable', detail: String(e?.statusMessage ?? e?.message ?? e) }
  }
  const imageUrl = extractCoverImageUrl(html, pageUrl)
  if (!imageUrl) return { ok: false, reason: 'noCover', detail: '商品頁上找不到封面圖（og:image）' }
  let bytes: Buffer
  try {
    const img = await fetchPublicBytes(imageUrl, { timeoutMs: 8_000, maxBytes: IMAGE_MAX_BYTES, headers: FETCH_HEADERS })
    if (!img.ok) return { ok: false, reason: 'imageUnreachable', detail: `封面圖回 ${img.status}` }
    if (img.truncatedBySize) return { ok: false, reason: 'imageUnreachable', detail: '封面圖超過 8 MB' }
    bytes = img.bytes
  }
  catch (e: any) {
    return { ok: false, reason: 'imageUnreachable', detail: String(e?.statusMessage ?? e?.message ?? e) }
  }
  try {
    const out = encodeJpeg(await decodeToRgba(new Uint8Array(bytes)))
    return { ok: true, jpeg: out.bytes, imageUrl, width: out.width, height: out.height }
  }
  catch (e: any) {
    return { ok: false, reason: 'badImage', detail: String(e?.message ?? e) }
  }
}

/**
 * 存進 Storage、公開，回公開網址。檔名帶內容指紋：同一張圖重抓不會變網址，換了圖網址一定不同（LINE 會快取圖）。
 * 路徑跟後台上傳的圖同一個資料夾（`uploads/{wid}/…`、公開讀）；清暫存檔的排程只掃 `preview-uploads/`，不會動到這裡。
 */
export async function storeProductCover(workspaceId: string, sourceId: string, productId: string, jpegBytes: Buffer): Promise<string> {
  const hash = createHash('sha256').update(jpegBytes).digest('hex').slice(0, 12)
  const bucket = getStorage().bucket()
  const fileName = `uploads/${workspaceId}/sheet-products/${sourceId}-${productId}-${hash}.jpg`
  const file = bucket.file(fileName)
  await file.save(jpegBytes, { contentType: 'image/jpeg', metadata: { cacheControl: 'public, max-age=31536000, immutable' } })
  await file.makePublic()
  return `https://storage.googleapis.com/${bucket.name}/${fileName}`
}
