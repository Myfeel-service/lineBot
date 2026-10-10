/**
 * Word（.docx）、PowerPoint（.pptx）、純文字檔（.txt／.md／.csv）→ 純文字。
 *
 * `D-120` 第 1 步（`C-296`）：老闆要「手邊有什麼就丟什麼」。這幾種原本整個不收，
 * 只能叫人另存 PDF——而另存 PDF 會把 Word 的表格變成一串攤平的字，反而更難整理。
 *
 * 設計重點：
 * - **不加套件**：docx／pptx 都是 zip 包 XML。這裡用 node:zlib 自己讀 zip 的目錄，
 *   只解出需要的那幾個檔（document.xml／slideN.xml），其餘一律不碰。
 * - **表格保持「欄位：值」**：Word 表格第一列當欄位名稱，之後每一列寫成
 *   「品名：W1；容量：12L；價格：12,900」——跟 Excel 散文路徑同一種寫法，
 *   AI 整理時才知道 12,900 是價格不是型號。
 * - **編碼自己判斷**：台灣購物平台匯出的 CSV 常是 Big5；用 UTF-8 硬讀會整份亂碼，
 *   而且亂碼看起來像「資料很怪」而不是「讀錯了」，沒有人會想到是編碼。
 * - **壓縮炸彈防線**：解壓後的總大小有上限，超過就停並講原因。
 */
import { inflateRawSync } from 'node:zlib'

/** 單一檔案解壓後的大小上限（document.xml 正常幾 MB，超過幾十 MB 一定不是正常文件） */
const MAX_ENTRY_BYTES = 60 * 1024 * 1024

interface ZipEntry {
  name: string
  method: number
  flags: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

/** 舊版 Office 二進位檔（.doc/.ppt）與「有密碼的新版 Office 檔」都是這種外殼開頭 */
function isOleContainer(buf: Buffer): boolean {
  return buf.length >= 8 && buf.readUInt32BE(0) === 0xD0CF11E0 && buf.readUInt32BE(4) === 0xA1B11AE1
}

/** 不是 zip 的時候，講得出是哪一種（有密碼 vs 舊版檔），不要一律叫人另存 */
function notZipReason(buf: Buffer, kind: 'docx' | 'pptx'): string {
  if (isOleContainer(buf)) return `可能有密碼保護，或其實是舊版 ${kind === 'docx' ? '.doc' : '.ppt'}——有密碼的話請先移除密碼`
  return `檔案格式不對，可能是舊版 ${kind === 'docx' ? '.doc' : '.ppt'} 或檔案損毀`
}

/**
 * 一份檔案解壓後總共最多讀多少（簡報有幾百張投影片時逐張解壓）。
 * 10MB 的檔正常解開幾十 MB；超過這個量多半是壓縮炸彈，讀下去會在 Lambda 上逾時。
 */
const MAX_TOTAL_INFLATED_BYTES = 120 * 1024 * 1024

/** 「替代內容」（mc:Fallback）是給舊版 Office 看的同一份內容；兩份都讀，文字方塊的字會出現兩次 */
function stripFallbacks(xml: string): string {
  return xml.replace(/<mc:Fallback\b[\s\S]*?<\/mc:Fallback>/g, '')
}

function badZip(kind: 'docx' | 'pptx', why: string): never {
  const label = kind === 'docx' ? 'Word' : 'PowerPoint'
  const resave = kind === 'docx' ? '在 Word 另存成 .docx' : '在 PowerPoint 另存成 .pptx'
  throw createError({
    statusCode: 422,
    statusMessage: `無法讀取這份 ${label} 檔（${why}）；請${resave}，或匯出成 PDF 再上傳。`,
  })
}

/** 讀 zip 的中央目錄（不解壓）。不是 zip 就回 null，讓呼叫端講「不是有效的 Word 檔」。 */
export function readZipDirectory(buf: Buffer): ZipEntry[] | null {
  // 中央目錄結尾（EOCD）在檔尾，後面最多接 65535 bytes 的註解
  const minEocd = 22
  if (buf.length < minEocd) return null
  const searchStart = Math.max(0, buf.length - minEocd - 0xFFFF)
  let eocd = -1
  for (let i = buf.length - minEocd; i >= searchStart; i--) {
    if (buf.readUInt32LE(i) === 0x06054B50) { eocd = i; break }
  }
  if (eocd < 0) return null
  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (cdOffset >= buf.length) return null

  const entries: ZipEntry[] = []
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014B50) return null
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const compressedSize = buf.readUInt32LE(p + 20)
    const uncompressedSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localHeaderOffset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    entries.push({ name, method, flags, compressedSize, uncompressedSize, localHeaderOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** 解出一個 zip 項目。用中央目錄的大小（local header 可能因 data descriptor 而填 0）。 */
export function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  if (entry.flags & 0x1) throw new Error('encrypted')
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) throw new Error('too-large')
  const h = entry.localHeaderOffset
  if (h + 30 > buf.length || buf.readUInt32LE(h) !== 0x04034B50) throw new Error('bad-local-header')
  const start = h + 30 + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28)
  const data = buf.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return Buffer.from(data)
  if (entry.method === 8) {
    const out = inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES })
    return out
  }
  throw new Error(`unsupported-method-${entry.method}`)
}

// ── XML 小工具（只處理 Office 會用到的那幾種寫法）──────────────────────

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' }

export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10)
      // 超過 Unicode 範圍的（壞檔才會有）照原樣留著；⛔ 不能交給 fromCodePoint，它會丟 RangeError 變成 500
      return Number.isFinite(n) && n > 0 && n <= 0x10FFFF ? String.fromCodePoint(n) : m
    }
    return ENTITY[code] ?? m
  })
}

/**
 * 找出最外層的 `<tag ...>...</tag>` 區塊（會處理同名巢狀，例如表格裡又有表格）。
 * 回傳每塊的起訖位置；區塊外的內容由呼叫端照原樣處理。
 */
export function topLevelBlocks(xml: string, tag: string): Array<{ start: number, end: number }> {
  // `(?=[\s>/])`：`<w:p` 不能吃到 `<w:pPr`、`<w:tbl` 不能吃到 `<w:tblPr`
  const re = new RegExp(`<${tag}(?=[\\s>/])|</${tag}>`, 'g')
  const blocks: Array<{ start: number, end: number }> = []
  let depth = 0
  let start = -1
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    if (m[0][1] === '/') {
      if (depth > 0 && --depth === 0) blocks.push({ start, end: m.index + m[0].length })
      continue
    }
    const gt = xml.indexOf('>', m.index)
    if (gt > 0 && xml[gt - 1] === '/') {
      // 自閉合（空段落 `<w:p/>`）：自己就是一整塊，不進深度
      if (depth === 0) blocks.push({ start: m.index, end: gt + 1 })
      continue
    }
    if (depth === 0) start = m.index
    depth++
  }
  return blocks
}

/** `<tag ...>內文</tag>` → 內文（自閉合回空字串） */
function innerOf(block: string, tag: string): string {
  const gt = block.indexOf('>')
  if (gt < 0 || block[gt - 1] === '/') return ''
  const close = block.lastIndexOf(`</${tag}>`)
  return block.slice(gt + 1, close > gt ? close : undefined)
}

function childBlocks(xml: string, tag: string): string[] {
  return topLevelBlocks(xml, tag).map(b => xml.slice(b.start, b.end))
}

// ── Word ───────────────────────────────────────────────────────────

/** 一個 `<w:p>` 段落 → 一行文字（tab 變空白、換行保留、清單項目前面加「・」） */
function docxParagraphText(p: string): string {
  const isList = /<w:numPr[\s>]/.test(p)
  const style = p.match(/<w:pStyle\s+w:val="([^"]+)"/)?.[1] ?? ''
  let out = ''
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:cr\s*\/>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(p))) {
    if (m[1] !== undefined) out += decodeXmlEntities(m[1])
    else if (m[0].startsWith('<w:tab')) out += ' '
    else out += '\n'
  }
  out = out.replace(/[ \t]+/g, ' ').trim()
  if (!out) return ''
  if (/^(heading|title)\s*\d*$/i.test(style)) return `## ${out}`
  if (isList) return `・${out}`
  return out
}

/** `<w:tbl>` → 「欄位：值；欄位：值」逐列（第一列當欄位名稱）；欄位名稱不齊就用「｜」接起來 */
function docxTableText(tbl: string): string {
  // 只拿「這一層」的列與格；格子裡若又有表格，交給 docxBodyText 遞迴攤平成一格文字，
  // ⛔ 不可以直接全文找 <w:tr>——內層表格的列會被當成外層的列，欄位整個錯位
  //
  // 合併儲存格要照「格線」排（2026-10-10 審查實測）：
  //  · 橫向合併（gridSpan＝N）佔 N 欄——不補空格的話後面每一格都往左移一欄，
  //    「12,900」會被標成「容量」而不是「價格」；
  //  · 直向合併的下半格（vMerge 沒有 restart）是空的——照上一列同一欄的值補上，
  //    「品名」被合併的那幾列才不會少了名字。
  const rows: string[][] = []
  let prev: string[] = []
  for (const r of childBlocks(innerOf(tbl, 'w:tbl'), 'w:tr')) {
    const grid: string[] = []
    for (const c of childBlocks(innerOf(r, 'w:tr'), 'w:tc')) {
      const inner = innerOf(c, 'w:tc')
      // 只看這一格自己的屬性（在第一個段落／內層表格之前），內層表格的屬性不算
      const ownPr = inner.slice(0, inner.search(/<w:(p|tbl)(?=[\s>/])/) >= 0 ? inner.search(/<w:(p|tbl)(?=[\s>/])/) : undefined)
      const span = Math.max(1, Math.min(50, Number(ownPr.match(/<w:gridSpan\s+w:val="(\d+)"/)?.[1] ?? 1)))
      const vMerge = ownPr.match(/<w:vMerge(?:\s+w:val="(\w+)")?\s*\/?>/)
      const continues = !!vMerge && vMerge[1] !== 'restart'
      const text = continues ? (prev[grid.length] ?? '') : docxBodyText(inner).replace(/\n+/g, ' ').trim()
      grid.push(text)
      for (let k = 1; k < span; k++) grid.push('')
    }
    prev = grid
    if (grid.some(Boolean)) rows.push(grid)
  }
  return tableRowsToText(rows)
}

/**
 * 表格列 → 文字。第一列每格都有字、且至少兩欄 → 當欄位名稱，之後每列寫「欄位：值」；
 * 否則每列用「｜」接起來（不硬猜欄位名稱：猜錯比不猜更會誤導 AI）。
 */
export function tableRowsToText(rows: string[][]): string {
  if (!rows.length) return ''
  const head = rows[0]!
  const headerUsable = head.length >= 2 && head.every(h => h.trim()) && rows.length >= 2
  if (!headerUsable) return rows.map(r => r.filter(Boolean).join('｜')).join('\n')
  return rows.slice(1).map((r) => {
    const pairs: string[] = []
    r.forEach((v, i) => {
      if (!v.trim()) return
      const h = head[i]?.trim()
      pairs.push(h ? `${h}：${v}` : v)
    })
    return pairs.join('；')
  }).filter(Boolean).join('\n')
}

/** Word 本文（可能含表格）→ 文字。表格前後空一行，讓 AI 看得出那是一張表。 */
function docxBodyText(xml: string): string {
  const parts: string[] = []
  let cursor = 0
  const pushParagraphs = (seg: string) => {
    for (const p of childBlocks(seg, 'w:p')) {
      // 文字方塊（`w:txbxContent`）長在段落裡面：先拿出來另外當段落讀，
      // 否則它的字會黏在旁邊那段正文上（「限時優惠 8 折正文」）
      const boxes = topLevelBlocks(p, 'w:txbxContent')
      let outer = p
      for (const b of [...boxes].reverse()) outer = outer.slice(0, b.start) + outer.slice(b.end)
      const line = docxParagraphText(outer)
      if (line) parts.push(line)
      for (const b of boxes) {
        const boxText = docxBodyText(innerOf(p.slice(b.start, b.end), 'w:txbxContent'))
        if (boxText) parts.push(boxText)
      }
    }
  }
  for (const t of topLevelBlocks(xml, 'w:tbl')) {
    pushParagraphs(xml.slice(cursor, t.start))
    const table = docxTableText(xml.slice(t.start, t.end))
    if (table) parts.push('', table, '')
    cursor = t.end
  }
  pushParagraphs(xml.slice(cursor))
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function extractDocxText(buf: Buffer): { text: string, meta: Record<string, string | number> } {
  const entries = readZipDirectory(buf)
  if (!entries) badZip('docx', notZipReason(buf, 'docx'))
  const doc = entries.find(e => e.name === 'word/document.xml')
  if (!doc) badZip('docx', '找不到文件內容')
  let xml: string
  try {
    xml = stripFallbacks(readZipEntry(buf, doc).toString('utf8'))
  }
  catch (e) {
    const msg = (e as Error).message
    const why = msg === 'encrypted' ? '有密碼保護' : (msg === 'too-large' || /maxOutputLength|buffer/i.test(msg)) ? '內容大到不正常' : '檔案損毀'
    badZip('docx', why)
  }
  const body = xml.slice(Math.max(0, xml.indexOf('<w:body')), xml.lastIndexOf('</w:body>') > 0 ? xml.lastIndexOf('</w:body>') : undefined)
  const text = docxBodyText(body)
  return { text, meta: { format: 'docx' } }
}

// ── PowerPoint ─────────────────────────────────────────────────────

/** 依簡報「實際的投影片順序」排（presentation.xml 的清單），不是靠檔名的數字 */
function pptxSlideOrder(buf: Buffer, entries: ZipEntry[]): string[] {
  const byName = new Map(entries.map(e => [e.name, e]))
  const slideFiles = entries.map(e => e.name).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
  const numeric = [...slideFiles].sort((a, b) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]))
  try {
    const pres = byName.get('ppt/presentation.xml')
    const rels = byName.get('ppt/_rels/presentation.xml.rels')
    if (!pres || !rels) return numeric
    const presXml = readZipEntry(buf, pres).toString('utf8')
    const relXml = readZipEntry(buf, rels).toString('utf8')
    const target = new Map<string, string>()
    for (const m of relXml.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = m[0].match(/\bId="([^"]+)"/)?.[1]
      const t = m[0].match(/\bTarget="([^"]+)"/)?.[1]
      if (id && t) target.set(id, t.replace(/^\/?(ppt\/)?/, 'ppt/'))
    }
    const ordered: string[] = []
    for (const m of presXml.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)) {
      const t = target.get(m[1]!)
      if (t && byName.has(t)) ordered.push(t)
    }
    // 清單讀不出來（或少了幾張）就退回檔名順序，⛔ 不要因此少讀投影片
    return ordered.length === slideFiles.length ? ordered : numeric
  }
  catch {
    return numeric
  }
}

function pptxSlideText(xml: string): string {
  const lines: string[] = []
  for (const p of childBlocks(xml, 'a:p')) {
    let line = ''
    for (const m of p.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\s*\/>/g)) {
      line += m[1] !== undefined ? decodeXmlEntities(m[1]) : '\n'
    }
    line = line.replace(/[ \t]+/g, ' ').trim()
    if (line) lines.push(line)
  }
  return lines.join('\n')
}

export function extractPptxText(buf: Buffer): { text: string, meta: Record<string, string | number> } {
  const entries = readZipDirectory(buf)
  if (!entries) badZip('pptx', notZipReason(buf, 'pptx'))
  const byName = new Map(entries.map(e => [e.name, e]))
  const order = pptxSlideOrder(buf, entries)
  if (!order.length) badZip('pptx', '找不到任何投影片')
  const out: string[] = []
  let withText = 0
  // 讀不出來的投影片要數出來講（單張壞掉不擋整份，但⛔不可以默默少幾張）
  let unreadable = 0
  let inflated = 0
  order.forEach((name, i) => {
    const entry = byName.get(name)!
    if (inflated + entry.uncompressedSize > MAX_TOTAL_INFLATED_BYTES) { unreadable++; return }
    let xml = ''
    try {
      xml = stripFallbacks(readZipEntry(buf, entry).toString('utf8'))
      inflated += xml.length
    }
    catch (e) {
      if ((e as Error).message === 'encrypted') badZip('pptx', '有密碼保護')
      unreadable++
      return
    }
    const text = pptxSlideText(xml)
    if (!text) return
    withText++
    out.push(`## 第 ${i + 1} 張投影片`, text, '')
  })
  return { text: out.join('\n').trim(), meta: { slides: order.length, slidesWithText: withText, slidesUnreadable: unreadable } }
}

// ── 純文字檔（.txt／.md／.csv）的編碼判斷 ────────────────────────────

export type TextEncodingName = 'utf-8' | 'utf-16le' | 'utf-16be' | 'big5'

/**
 * bytes → 字串，自己判斷編碼：BOM 優先 → 合法 UTF-8 → Big5。
 * ⛔ 不要只靠 UTF-8 加替代字元硬讀：Big5 的 CSV 會整份變成「�」，
 *    看起來像資料壞了，沒有人會想到是編碼。
 */
export function decodeTextBuffer(buf: Buffer): { text: string, encoding: TextEncodingName } {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), encoding: 'utf-8' }
  }
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le' }
  }
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be' }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' }
  }
  catch {
    // 大部分是 UTF-8、只有零星一兩個壞位元組（複製貼上帶進來的）→ 還是 UTF-8，壞的那幾個字換掉就好。
    // ⛔ 不可以因為一個壞位元組就整份改用 Big5 讀：那會把整份正確的字讀成亂碼
    const lenient = new TextDecoder('utf-8').decode(buf)
    const bad = (lenient.match(/�/g) ?? []).length
    if (bad <= Math.max(1, lenient.length / 1000)) return { text: lenient, encoding: 'utf-8' }
    return { text: new TextDecoder('big5').decode(buf), encoding: 'big5' }
  }
}
