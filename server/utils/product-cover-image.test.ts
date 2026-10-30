/**
 * `C-435`：商品頁的封面圖 → JPG。
 * 釘五件事：
 *   ① 找得到封面圖網址（MYFEEL 的寫法、屬性順序反過來、相對網址、&amp;）；找不到＝null。
 *   ② GIF（取第一格）、PNG、JPG、WebP 都轉得出 JPG——WebP 用的 .wasm 在測試裡讀 node_modules 那一份（跟正式站打包的是同一個檔）。
 *   ③ 透明的地方鋪白、比 1200 寬就等比例縮。
 *   ④ 每一步失敗都講得出是哪一步（找不到封面圖／商品頁連不上／圖抓不到／壞圖），⛔ 不默默放棄。
 *   ⑤ 存的檔名帶內容指紋（同一張圖同一個網址；LINE 會快取圖，換了圖網址一定要不同）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import omggif from 'omggif'
import jpeg from 'jpeg-js'
import { PNG } from 'pngjs'

const { fetchPublicText, fetchPublicBytes } = vi.hoisted(() => ({ fetchPublicText: vi.fn(), fetchPublicBytes: vi.fn() }))
vi.mock('./safe-fetch', () => ({ fetchPublicText, fetchPublicBytes }))
const saved: Array<{ name: string, bytes: Buffer, opts: any }> = []
vi.mock('./firebase', () => ({
  getStorage: () => ({
    bucket: () => ({
      name: 'bkt',
      file: (name: string) => ({
        save: async (bytes: Buffer, opts: any) => { saved.push({ name, bytes, opts }) },
        makePublic: async () => {},
      }),
    }),
  }),
}))

const { extractCoverImageUrl, decodeToRgba, encodeJpeg, fetchProductCover, sniffImageKind, storeProductCover } = await import('./product-cover-image')

/** 120×100、左半紅右半藍、右下角 20×20 全透明的無損 WebP（用 @jsquash/webp 1.5.0 的編碼器產的） */
const WEBP = Buffer.from('UklGRj4AAABXRUJQVlA4TDIAAAAvd8AYEBcwHgKBJIj9ecYSCCSx7Y8wzPwH7A4UtW3ElGRJluat/1RE/ydAVVZfK7CdAw==', 'base64')

function rgba(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]) {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(fill(x, y), (y * w + x) * 4)
  return { width: w, height: h, data }
}
function pngBytes(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]) {
  const p = new PNG({ width: w, height: h })
  p.data = Buffer.from(rgba(w, h, fill).data)
  return new Uint8Array(PNG.sync.write(p))
}
function gifBytes(w: number, h: number) {
  const buf = Buffer.alloc(w * h * 2 + 1024)
  const g = new omggif.GifWriter(buf, w, h, { palette: [0xFF0000, 0x00FF00] })
  const idx = new Array(w * h).fill(0).map((_, i) => (i % w < w / 2 ? 0 : 1))
  g.addFrame(0, 0, w, h, idx)
  g.addFrame(0, 0, w, h, idx.map(() => 1)) // 第二格全綠：⛔ 不可以取到這一格
  return new Uint8Array(buf.subarray(0, g.end()))
}
const pixel = (img: { width: number, data: ArrayLike<number> }, x: number, y: number) => {
  const i = (y * img.width + x) * 4
  return [img.data[i], img.data[i + 1], img.data[i + 2]]
}
const near = (a: number[], b: number[], tol = 24) => a.every((v, i) => Math.abs(v - b[i]!) <= tol)

describe('① 找封面圖網址', () => {
  const PAGE = 'https://www.myfeel-tw.com/projects/GL-5680'
  it('MYFEEL 的寫法（data-n-head、property 在 content 前面）', () => {
    const html = '<meta data-n-head="ssr" data-hid="og:image" property="og:image" content="https://cdn.myfeel-tw.com/images/PkL2.gif">'
    expect(extractCoverImageUrl(html, PAGE)).toBe('https://cdn.myfeel-tw.com/images/PkL2.gif')
  })
  it('secure_url 優先；content 在前、單引號、&amp; 都認', () => {
    const html = `<meta content='https://a.com/x.jpg?a=1&amp;b=2' property='og:image'><meta content="https://a.com/secure.jpg" property="og:image:secure_url">`
    expect(extractCoverImageUrl(html, PAGE)).toBe('https://a.com/secure.jpg')
    expect(extractCoverImageUrl(`<meta content='https://a.com/x.jpg?a=1&amp;b=2' property='og:image'>`, PAGE)).toBe('https://a.com/x.jpg?a=1&b=2')
  })
  it('相對網址照商品頁補齊；沒有 og 用 twitter:image', () => {
    expect(extractCoverImageUrl('<meta property="og:image" content="/img/cover.png">', PAGE)).toBe('https://www.myfeel-tw.com/img/cover.png')
    expect(extractCoverImageUrl('<meta name="twitter:image" content="https://a.com/t.jpg">', PAGE)).toBe('https://a.com/t.jpg')
  })
  it('找不到、或不是 http(s)＝null', () => {
    expect(extractCoverImageUrl('<meta property="og:title" content="x">', PAGE)).toBeNull()
    expect(extractCoverImageUrl('<meta property="og:image" content="data:image/png;base64,AAA">', PAGE)).toBeNull()
  })
})

describe('② 各種格式都轉得出 JPG', () => {
  it('認得出格式', () => {
    expect(sniffImageKind(gifBytes(120, 100))).toBe('gif')
    expect(sniffImageKind(pngBytes(120, 100, () => [0, 0, 0, 255]))).toBe('png')
    expect(sniffImageKind(new Uint8Array(WEBP))).toBe('webp')
    expect(sniffImageKind(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBeNull()
  })

  it('GIF：取第一格（左紅右綠），⛔ 不是第二格（全綠）', async () => {
    const img = await decodeToRgba(gifBytes(120, 100))
    expect([img.width, img.height]).toEqual([120, 100])
    expect(pixel(img, 10, 50)).toEqual([255, 0, 0])
    expect(pixel(img, 110, 50)).toEqual([0, 255, 0])
  })

  it('WebP：解得開（.wasm 讀 node_modules 那一份），轉成 JPG 讀回來顏色對', async () => {
    const img = await decodeToRgba(new Uint8Array(WEBP))
    expect([img.width, img.height]).toEqual([120, 100])
    const out = encodeJpeg(img)
    const back = jpeg.decode(out.bytes, { useTArray: true })
    expect(near(pixel(back, 20, 20) as number[], [220, 30, 30])).toBe(true)
    expect(near(pixel(back, 80, 20) as number[], [20, 30, 220])).toBe(true)
  })

  it('JPG 進、JPG 出', async () => {
    const src = jpeg.encode({ ...rgba(200, 150, () => [10, 200, 10, 255]), data: Buffer.from(rgba(200, 150, () => [10, 200, 10, 255]).data) }, 90)
    const img = await decodeToRgba(new Uint8Array(src.data))
    expect([img.width, img.height]).toEqual([200, 150])
  })

  it('太小（追蹤用的小圖）、看不懂：丟錯', async () => {
    await expect(decodeToRgba(pngBytes(10, 10, () => [0, 0, 0, 255]))).rejects.toThrow('圖太小')
    await expect(decodeToRgba(new Uint8Array(20))).rejects.toThrow('看不懂')
  })
})

describe('③ 透明鋪白、太寬等比例縮', () => {
  it('透明的地方變白（WebP 右下角那塊）', async () => {
    const img = await decodeToRgba(new Uint8Array(WEBP))
    const back = jpeg.decode(encodeJpeg(img).bytes, { useTArray: true })
    expect(near(pixel(back, 110, 90) as number[], [255, 255, 255])).toBe(true)
  })
  it('2400 寬 → 1200 寬、高照比例；不改到傳進來的那一份', () => {
    const src = rgba(2400, 1350, x => (x < 1200 ? [255, 0, 0, 255] : [0, 0, 255, 255]))
    const before = src.data[0]
    const out = encodeJpeg(src)
    expect([out.width, out.height]).toEqual([1200, 675])
    expect(src.data[0]).toBe(before)
    const back = jpeg.decode(out.bytes, { useTArray: true })
    expect(near(pixel(back, 100, 300) as number[], [255, 0, 0])).toBe(true)
    expect(near(pixel(back, 1100, 300) as number[], [0, 0, 255])).toBe(true)
  })
  it('本來就不寬：尺寸不變', () => {
    const out = encodeJpeg(rgba(1200, 675, () => [0, 0, 0, 255]))
    expect([out.width, out.height]).toEqual([1200, 675])
  })
})

describe('④ fetchProductCover：每一步失敗都講得出是哪一步', () => {
  const PAGE = 'https://www.myfeel-tw.com/projects/boyamini2'
  const html = '<meta property="og:image" content="https://cdn.example/cover.gif">'
  beforeEach(() => { fetchPublicText.mockReset(); fetchPublicBytes.mockReset() })

  it('⭐ 成功：抓商品頁 → 抓封面圖 → JPG（用同一個 UA，大小有上限）', async () => {
    fetchPublicText.mockResolvedValue({ ok: true, status: 200, text: html })
    fetchPublicBytes.mockResolvedValue({ ok: true, status: 200, bytes: Buffer.from(gifBytes(1200, 675)), truncatedBySize: false })
    const r = await fetchProductCover(PAGE)
    expect(r).toMatchObject({ ok: true, imageUrl: 'https://cdn.example/cover.gif', width: 1200, height: 675 })
    expect(sniffImageKind(new Uint8Array((r as any).jpeg))).toBe('jpeg')
    expect(fetchPublicBytes.mock.calls[0]![1]).toMatchObject({ maxBytes: 8 * 1024 * 1024, headers: { 'User-Agent': 'LineBotKnowledgeFetcher/1.0' } })
  })
  it('商品頁連不上 / 回 404＝pageUnreachable', async () => {
    fetchPublicText.mockRejectedValue(Object.assign(new Error('x'), { statusMessage: '網址抓取失敗：timeout' }))
    expect(await fetchProductCover(PAGE)).toMatchObject({ ok: false, reason: 'pageUnreachable' })
    fetchPublicText.mockResolvedValue({ ok: false, status: 404, text: '' })
    expect(await fetchProductCover(PAGE)).toMatchObject({ ok: false, reason: 'pageUnreachable', detail: '商品頁回 404' })
  })
  it('商品頁上沒有封面圖＝noCover（⛔ 不去抓別的圖亂用）', async () => {
    fetchPublicText.mockResolvedValue({ ok: true, status: 200, text: '<img src="https://a.com/logo.png">' })
    expect(await fetchProductCover(PAGE)).toMatchObject({ ok: false, reason: 'noCover' })
    expect(fetchPublicBytes).not.toHaveBeenCalled()
  })
  it('圖抓不到、超過上限（截斷的圖是壞檔）＝imageUnreachable', async () => {
    fetchPublicText.mockResolvedValue({ ok: true, status: 200, text: html })
    fetchPublicBytes.mockResolvedValue({ ok: true, status: 200, bytes: Buffer.alloc(10), truncatedBySize: true })
    expect(await fetchProductCover(PAGE)).toMatchObject({ ok: false, reason: 'imageUnreachable' })
  })
  it('不是圖＝badImage', async () => {
    fetchPublicText.mockResolvedValue({ ok: true, status: 200, text: html })
    fetchPublicBytes.mockResolvedValue({ ok: true, status: 200, bytes: Buffer.from('<html>not an image</html>'), truncatedBySize: false })
    expect(await fetchProductCover(PAGE)).toMatchObject({ ok: false, reason: 'badImage' })
  })
})

describe('WebP 解碼器那份複本', () => {
  it('⛔ server/assets 裡的 .wasm 要跟裝的 @jsquash/webp 一模一樣（換版本忘了換＝解碼器跟程式對不上）', async () => {
    const { readFile } = await import('node:fs/promises')
    const { createHash } = await import('node:crypto')
    const { dirname, join } = await import('node:path')
    const { createRequire } = await import('node:module')
    const { fileURLToPath } = await import('node:url')
    const here = dirname(fileURLToPath(import.meta.url))
    const copy = await readFile(join(here, '..', 'assets', 'webp-codec', 'webp_dec.wasm'))
    const pkg = await readFile(join(dirname(createRequire(import.meta.url).resolve('@jsquash/webp/decode.js')), 'codec', 'dec', 'webp_dec.wasm'))
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
    expect(sha(copy)).toBe(sha(pkg))
  })
})

describe('⑤ 存檔', () => {
  it('路徑在 uploads/{帳號}/sheet-products/、檔名帶內容指紋、公開網址、長期快取', async () => {
    saved.length = 0
    const a = await storeProductCover('ws1', 'src1', 'p1', Buffer.from('AAA'))
    const b = await storeProductCover('ws1', 'src1', 'p1', Buffer.from('AAA'))
    const c = await storeProductCover('ws1', 'src1', 'p1', Buffer.from('BBB'))
    expect(a).toMatch(/^https:\/\/storage\.googleapis\.com\/bkt\/uploads\/ws1\/sheet-products\/src1-p1-[0-9a-f]{12}\.jpg$/)
    expect(b).toBe(a)
    expect(c).not.toBe(a)
    expect(saved[0]!.opts).toMatchObject({ contentType: 'image/jpeg' })
  })
})
