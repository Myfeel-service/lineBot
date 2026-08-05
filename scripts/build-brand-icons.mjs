/**
 * 由 public/logomark.svg 產生瀏覽器要的點陣圖示：public/favicon.ico、public/apple-touch-icon.png。
 *
 * 什麼時候要跑：設計換了 logomark.svg 之後。
 *   npm run build:icons        （需要 rsvg-convert：brew install librsvg）
 *
 * 為什麼不能只放 SVG：
 *   - 舊瀏覽器與 Windows 捷徑只認 .ico
 *   - iOS 的 apple-touch-icon 不吃 SVG，而且會把透明背景壓成黑色
 * 所以這兩個點陣檔一律鋪白底、把 logomark 置中留邊（logomark 是橫的，方形圖示要補上下留白）。
 * logomark 的路徑資料是「讀」進來的、不是手抄，換圖重跑就會跟著更新。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')
const TMP = mkdtempSync(join(tmpdir(), 'brand-icons-'))

const src = readFileSync(join(PUBLIC, 'logomark.svg'), 'utf8')
const viewBox = src.match(/viewBox="([\d.\s-]+)"/)
if (!viewBox) throw new Error('logomark.svg 少了 viewBox，無法換算方形畫布比例')
const [, , vbW, vbH] = viewBox[1].trim().split(/\s+/).map(Number)
const inner = src.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')

/** 方形白底畫布，logomark 置中、左右各留 padRatio 比例的邊 */
function squareSvg(size, padRatio) {
  const w = size * (1 - padRatio * 2)
  const h = w * (vbH / vbW)
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="#ffffff"/>
  <svg x="${(size - w) / 2}" y="${(size - h) / 2}" width="${w}" height="${h}" viewBox="0 0 ${vbW} ${vbH}">${inner}</svg>
</svg>
`
}

/** 一律先畫 1024 再縮到目標尺寸，小圖才不會有鋸齒 */
function png(size, padRatio, out) {
  const svg = join(TMP, `sq-${size}.svg`)
  writeFileSync(svg, squareSvg(1024, padRatio))
  execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), svg, '-o', out])
  return out
}

/** ICO 容器：directory entries ＋ 內嵌 PNG（Vista 起支援，現役瀏覽器都吃） */
function ico(sizes, pngPaths, out) {
  const imgs = pngPaths.map(p => readFileSync(p))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2)              // type 1 = icon
  header.writeUInt16LE(imgs.length, 4)
  const dir = Buffer.alloc(16 * imgs.length)
  let offset = header.length + dir.length
  imgs.forEach((buf, i) => {
    const size = sizes[i]
    const o = i * 16
    dir[o] = size >= 256 ? 0 : size       // 寬（256 要寫 0）
    dir[o + 1] = size >= 256 ? 0 : size   // 高
    dir.writeUInt16LE(1, o + 4)           // color planes
    dir.writeUInt16LE(32, o + 6)          // bits per pixel
    dir.writeUInt32LE(buf.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += buf.length
  })
  writeFileSync(out, Buffer.concat([header, dir, ...imgs]))
}

// 小尺寸要少留邊，不然 16px 下 logo 只剩幾個像素看不出形狀
const ICO_SIZES = [16, 32, 48]
ico(ICO_SIZES, ICO_SIZES.map(s => png(s, s <= 32 ? 0.04 : 0.07, join(TMP, `ico-${s}.png`))), join(PUBLIC, 'favicon.ico'))
png(180, 0.14, join(PUBLIC, 'apple-touch-icon.png'))

console.log('已更新 public/favicon.ico 與 public/apple-touch-icon.png')
