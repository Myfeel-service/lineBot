/**
 * Word（.docx）、PowerPoint（.pptx）、純文字檔（.txt／.md／.csv）→ 純文字。
 *
 * `D-120` 第 1 步（`C-296`）：老闆要「手邊有什麼就丟什麼」。這幾種原本整個不收，
 * 只能叫人另存 PDF——而另存 PDF 會把 Word 的表格變成一串攤平的字，反而更難整理。
 *
 * 設計重點：
 * - **不加套件**：docx／pptx 都是 zip 包 XML。這裡用 node:zlib 自己讀 zip 的目錄，
 *   只解出需要的那幾個檔（document.xml／slideN.xml），其餘一律不碰。
 * - **XML 從頭到尾只走一次**（walkXml）：這段在請求裡同步跑，⛔ 不可以有「標籤沒收尾就一路掃到檔尾」
 *   的 regex——每個沒收尾的標籤都掃一次檔尾＝平方時間，一個 4KB 的惡意檔就卡住請求 45 秒
 *   （2026-10-11 審查實測）。
 * - **表格保持「欄位：值」**：Word 表格第一列當欄位名稱，之後每一列寫成
 *   「品名：W1；容量：12L；價格：12,900」——跟 Excel 散文路徑同一種寫法，
 *   AI 整理時才知道 12,900 是價格不是型號。
 * - **編碼自己判斷**：台灣購物平台匯出的 CSV 常是 Big5；用 UTF-8 硬讀會整份亂碼，
 *   而且亂碼看起來像「資料很怪」而不是「讀錯了」，沒有人會想到是編碼。
 * - **壓縮炸彈防線**：每個檔、整份各有解壓上限（算實際解出的位元組），讀出來的字數也有上限；
 *   超過就停並講原因。
 */
import { inflateRawSync } from 'node:zlib'

/**
 * 單一檔案解壓後的大小上限（document.xml 正常幾 MB，一張投影片幾十 KB）。
 * ⛔ 擋的是「實際解出來的位元組」（inflate 的 maxOutputLength），zip 目錄裡寫的大小只是第一道——那個可以亂填。
 */
const MAX_ENTRY_BYTES = 32 * 1024 * 1024

/**
 * 一份檔案解壓後總共最多讀多少（簡報有幾百張投影片時逐張解壓）。
 * 10MB 的檔正常解開幾十 MB；超過這個量多半是壓縮炸彈，讀下去會在 Lambda 上逾時。
 * 算的是位元組，⛔ 不是解碼後的字數（中文一個字三個位元組，算字數會讓實際解壓量多出兩倍），
 * 而且解到一半失敗的也要算（見 readZipEntry）。
 */
const MAX_TOTAL_INFLATED_BYTES = 120 * 1024 * 1024

/**
 * 一份檔案最多收多少字（w:t／a:t 裡的原文）。下游只收前 10 萬字（MAX_RAW_TEXT_LEN），
 * 正常文件也用不到（500 頁的手冊約 100 萬字）；撞到時 meta 會帶 textTruncated。
 */
const MAX_TEXT_CHARS = 2_000_000

/**
 * 表格最多寫出多少字。「欄位：值」每一列都寫一次欄位名稱、直向合併的格子每一列都帶一份，
 * 字數會比原文多——惡意檔可以靠這個把字數放大到記憶體爆掉（一格 20 萬字往下合併 10 萬列）。
 * 跟原文分開算：⛔ 共用一個額度的話，原文多的正常文件會因為原文先用掉額度而整張表不見。
 */
const MAX_TABLE_CHARS = 4_000_000

/**
 * 一份檔案最多看多少個標籤（每個 `<` 算一個，兩遍都算）。真檔案平均 16～26 bytes 一個標籤，
 * 32MB 的 document.xml（幾千頁）約 200 萬個；惡意檔可以每 4 bytes 一個，而簡報整份能解到 120MB，
 * 不設這條的話光是走一遍就要 3 秒以上。
 */
const MAX_XML_TAGS = 5_000_000

/** 表格、文字方塊最多套幾層；再深的當一般文字讀（不再分欄位），⛔ 不可以因為太深整份丟錯 */
const MAX_NESTING = 20

/** XML 元素最多套幾層：正常 Office 檔不到一百層；更深的是故意做的檔，深處的內容不讀 */
const MAX_XML_DEPTH = 10_000

/** 收尾標籤對不上最裡面那層時，最多往外找幾層（正常檔一定對得上，只有壞檔才會往外找） */
const MAX_CLOSE_SEARCH = 64

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

function badZip(kind: 'docx' | 'pptx', why: string): never {
  const label = kind === 'docx' ? 'Word' : 'PowerPoint'
  const resave = kind === 'docx' ? '在 Word 另存成 .docx' : '在 PowerPoint 另存成 .pptx'
  throw createError({
    statusCode: 422,
    statusMessage: `無法讀取這份 ${label} 檔（${why}）；請${resave}，或匯出成 PDF 再上傳。`,
  })
}

type ZipFailure = 'encrypted' | 'too-large' | 'corrupt'

const ZIP_FAILURE_WHY: Record<ZipFailure, string> = { 'encrypted': '有密碼保護', 'too-large': '內容大到不正常', 'corrupt': '檔案損毀' }

/**
 * 解壓失敗：一律丟 422，帶 reason 讓呼叫端講是哪一種。
 * ⛔ 不要再比對 zlib 的英文錯誤訊息，也不要讓它原樣往外丟（會變成 500）。
 */
function zipFailure(reason: ZipFailure): never {
  throw Object.assign(createError({ statusCode: 422, statusMessage: `壓縮檔裡的內容讀不出來（${ZIP_FAILURE_WHY[reason]}）` }), { reason })
}

const failureOf = (e: unknown): ZipFailure => (e as { reason?: ZipFailure } | null)?.reason ?? 'corrupt'

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

/**
 * 解出一個 zip 項目。用中央目錄的大小（local header 可能因 data descriptor 而填 0）。
 *
 * budget：這份檔案還能解壓多少位元組，解完從裡面扣。成功扣實際大小；⛔ 失敗也要扣——
 * 解到一半才發現壞掉（或解到上限才停）的那段工夫已經花掉了。不扣的話，150 張「宣稱 100 bytes、
 * 實際 60MB」的投影片會一張張解到上限再丟掉，合計解壓 9GB（2026-10-11 審查實測）。
 */
export function readZipEntry(buf: Buffer, entry: ZipEntry, budget?: { left: number }, maxEntryBytes = MAX_ENTRY_BYTES): Buffer {
  if (entry.flags & 0x1) zipFailure('encrypted')
  // maxEntryBytes：Word／簡報一個 XML 32MB 就到頂；試算表不一樣——10MB 的 xlsx 一張工作表就能解成 41MB（呼叫端自己給上限）
  const limit = Math.min(maxEntryBytes, budget ? budget.left : maxEntryBytes)
  if (limit < 1 || entry.uncompressedSize > limit) zipFailure('too-large')
  const h = entry.localHeaderOffset
  if (h + 30 > buf.length || buf.readUInt32LE(h) !== 0x04034B50) zipFailure('corrupt')
  const start = h + 30 + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28)
  if (start + entry.compressedSize > buf.length) zipFailure('corrupt')
  const data = buf.subarray(start, start + entry.compressedSize)
  let out: Buffer
  if (entry.method === 0) {
    if (data.length > limit) zipFailure('too-large')
    out = Buffer.from(data)
  }
  else if (entry.method === 8) {
    try {
      out = inflateRawSync(data, { maxOutputLength: limit })
    }
    catch (e) {
      const tooLarge = (e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE'
      // 實際解了多少拿不到：撞上限＝解滿 limit；其他錯誤最多解到「壓縮後大小 × 1032」（deflate 的最大壓縮比）
      if (budget) budget.left -= tooLarge ? limit : Math.min(limit, entry.compressedSize * 1032)
      zipFailure(tooLarge ? 'too-large' : 'corrupt')
    }
  }
  else {
    zipFailure('corrupt') // Office 只用 stored／deflate，其他壓縮方式不是正常的 Office 檔
  }
  if (budget) budget.left -= out.length
  return out
}

// ── XML 掃描（線性時間）──────────────────────────────────────────────

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

interface XmlVisitor {
  /** s／e：這個標籤 `<` 與 `>` 的位置（要讀屬性才用 attrOf 切出來）；parent：外面那一層的元素名稱 */
  open: (name: string, parent: string | undefined, s: number, e: number) => void
  close: (name: string) => void
  /** 元素之間的文字（還沒解實體字元） */
  text: (s: number, e: number) => void
}

/** XML 名稱的第一個字：英文字母、`_`、`:`、非 ASCII；其他的 `<` 是文字裡的小於符號（壞檔） */
const isNameStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58 || c >= 128

/** 一份檔案讀取時的工作量上限（整份共用；簡報是所有投影片加起來） */
interface ReadBudget {
  /** 還能收多少字（w:t／a:t 的原文，見 MAX_TEXT_CHARS） */
  chars: number
  /** 表格還能寫出多少字（見 MAX_TABLE_CHARS） */
  tableChars: number
  /** 還能看多少個標籤（見 MAX_XML_TAGS） */
  tags: number
  /** 有沒有因為上面任何一條而少讀 */
  truncated: boolean
}

const newReadBudget = (): ReadBudget => ({ chars: MAX_TEXT_CHARS, tableChars: MAX_TABLE_CHARS, tags: MAX_XML_TAGS, truncated: false })

const budgetUsedUp = (b: ReadBudget) => b.tags <= 0 || b.chars <= 0

/**
 * 從頭到尾走一次 XML，每個字只看常數次。
 * - 開／關一定成對送出：沒收尾的元素在外層收尾或文件結束時自動補關；對不上的收尾標籤當它不存在。
 * - 找不到收尾的 `>`／`-->`／`?>` 就整個停：後面不可能再有完整的標籤。⛔ 不要改成「跳過這個再找下一個」，
 *   那就回到「每個沒收尾的都掃一次檔尾」的平方時間。
 * - 超過 MAX_XML_DEPTH 層的元素連同裡面的字都不送（只數層數，好讓收尾標籤對得上）。
 * - 標籤數或字數的額度用完就停（還開著的元素照樣補關，已經讀到的字不會丟）。
 * - 不展開 DOCTYPE 裡自訂的實體（沒有「十億笑聲」炸彈的問題）。
 */
function walkXml(xml: string, v: XmlVisitor, budget: ReadBudget): void {
  const n = xml.length
  const stack: string[] = []
  let overflow = 0
  // 下一個 `>`、`"`、`'` 的位置快取（n＝後面沒有了）。游標只往前走，所以每種字元整份只掃一次——
  // ⛔ 每個標籤都重新 indexOf 引號的話，整份沒有單引號時每次都掃到檔尾
  let gt = -1
  let dq = -1
  let sq = -1
  const tagEnd = (from: number): number => {
    let pos = from
    for (;;) {
      if (gt < pos) { gt = xml.indexOf('>', pos); if (gt < 0) gt = n }
      if (gt >= n) return -1
      if (dq < pos) { dq = xml.indexOf('"', pos); if (dq < 0) dq = n }
      if (sq < pos) { sq = xml.indexOf('\'', pos); if (sq < 0) sq = n }
      const q = dq < sq ? dq : sq
      if (q > gt) return gt
      // 屬性值裡的 `>` 不算標籤結尾：跳過整段引號再找
      const qe = xml.indexOf(q === dq ? '"' : '\'', q + 1)
      if (qe < 0) return -1
      pos = qe + 1
    }
  }
  /** 收尾標籤：正常檔一定是最裡面那層；對不上就往外找幾層，找到了中間沒收尾的一併補關 */
  const closeTo = (name: string) => {
    if (stack[stack.length - 1] === name) {
      stack.pop()
      v.close(name)
      return
    }
    const stop = Math.max(0, stack.length - MAX_CLOSE_SEARCH)
    let k = stack.length - 2
    while (k >= stop && stack[k] !== name) k--
    if (k >= stop) while (stack.length > k) v.close(stack.pop()!)
  }

  let i = 0
  while (i < n) {
    const lt = xml.indexOf('<', i)
    if (lt < 0) {
      if (!overflow) v.text(i, n)
      break
    }
    if (lt > i && !overflow) v.text(i, lt)
    if (--budget.tags < 0 || budget.chars <= 0) {
      budget.truncated = true
      break
    }
    const c = xml.charCodeAt(lt + 1)
    if (c === 47 /* </ */) {
      const end = xml.indexOf('>', lt + 2)
      if (end < 0) break
      i = end + 1
      if (overflow) {
        overflow--
        continue
      }
      closeTo(xml.slice(lt + 2, end).trim())
      continue
    }
    if (c === 33 /* <! */) {
      if (xml.startsWith('<!--', lt)) {
        const end = xml.indexOf('-->', lt + 4)
        if (end < 0) break
        i = end + 3
        continue
      }
      if (xml.startsWith('<![CDATA[', lt)) {
        const end = xml.indexOf(']]>', lt + 9)
        if (end < 0) break
        if (!overflow) v.text(lt + 9, end)
        i = end + 3
        continue
      }
      const end = xml.indexOf('>', lt + 2) // <!DOCTYPE …>
      if (end < 0) break
      i = end + 1
      continue
    }
    if (c === 63 /* <? */) {
      const end = xml.indexOf('?>', lt + 2)
      if (end < 0) break
      i = end + 2
      continue
    }
    if (!isNameStart(c)) {
      if (!overflow) v.text(lt, lt + 1)
      i = lt + 1
      continue
    }
    const end = tagEnd(lt + 1)
    if (end < 0) break
    i = end + 1
    let j = lt + 2
    while (j < end) {
      const ch = xml.charCodeAt(j)
      if (ch <= 32 || ch === 47) break
      j++
    }
    const name = xml.slice(lt + 1, j)
    const selfClosing = xml.charCodeAt(end - 1) === 47
    if (overflow || stack.length >= MAX_XML_DEPTH) {
      if (!selfClosing) overflow++
      continue
    }
    v.open(name, stack[stack.length - 1], lt, end)
    if (selfClosing) v.close(name)
    else stack.push(name)
  }
  while (stack.length) v.close(stack.pop()!)
}

const noop = () => {}

/** 標籤上的屬性值（已解實體字元）。只切這一個標籤出來找，⛔ 不可以拿整份文件 indexOf（找不到就掃到檔尾） */
function attrOf(xml: string, s: number, e: number, attr: string): string | undefined {
  const tag = xml.slice(s, e + 1)
  let k = tag.indexOf(attr)
  while (k > 0) {
    // 前面要是空白：`Id` 才不會吃到 `r:Id`、`w:val` 不會吃到 `w:valX`
    if (tag.charCodeAt(k - 1) <= 32) {
      let j = k + attr.length
      while (tag.charCodeAt(j) <= 32) j++
      if (tag[j] === '=') {
        j++
        while (tag.charCodeAt(j) <= 32) j++
        const q = tag[j]
        if (q !== '"' && q !== '\'') return undefined
        const close = tag.indexOf(q, j + 1)
        return close < 0 ? undefined : decodeXmlEntities(tag.slice(j + 1, close))
      }
    }
    k = tag.indexOf(attr, k + 1)
  }
  return undefined
}

/** 收一段原文：從字數額度裡扣，超過的部分切掉（回空字串＝已經用完） */
function take(budget: ReadBudget, s: string): string {
  if (budget.chars <= 0) {
    budget.truncated = true
    return ''
  }
  if (s.length > budget.chars) {
    s = s.slice(0, budget.chars)
    budget.truncated = true
  }
  budget.chars -= s.length
  return s
}

const joinBlocks = (parts: string[]) => parts.join('\n').replace(/\n{3,}/g, '\n\n').trim()

// ── 替代內容（mc:AlternateContent）──────────────────────────────────

/**
 * 「替代內容」裡同一份東西有好幾個版本：mc:Choice 給新版 Office、mc:Fallback 給舊版，只能讀其中一個——
 * 兩個都讀，文字方塊的字會出現兩次（新版用 DrawingML、舊版用 VML，兩邊各放一份）。
 * 先掃一遍決定每一塊讀哪個：第一個「讀得出字」的 Choice（有 w:t／a:t 的字或文字方塊）；Choice 都沒有字就讀 Fallback。
 * ⛔ 不能一律丟掉 Fallback：Word 的表情符號是 Choice 放字型代碼（w16se:symEx，沒有字）、Fallback 才放「✅」本身，
 *    一律丟掉的話「W1：✅；W2：❌」整個不見；自閉合的 `<mc:Fallback/>` 用 regex 刪還會連後面的段落一起吃掉
 *    （2026-10-11 審查實測）。
 * 回傳每一塊（照開頭出現的順序）要讀第幾個分支。
 */
function alternateContentChoices(xml: string, budget: ReadBudget): number[] {
  const chosen: number[] = []
  if (!xml.includes('mc:AlternateContent')) return chosen
  const blocks: Array<{ index: number, depth: number, hasText: boolean[], fallback: number, cur: number }> = []
  let d = 0
  let tDepth = 0
  const mark = () => {
    const b = blocks[blocks.length - 1]
    if (b && b.cur >= 0) b.hasText[b.cur] = true
  }
  walkXml(xml, {
    open(name) {
      d++
      if (name === 'mc:AlternateContent') {
        blocks.push({ index: chosen.length, depth: d, hasText: [], fallback: -1, cur: -1 })
        chosen.push(0)
        return
      }
      const b = blocks[blocks.length - 1]
      if (b && d === b.depth + 1 && (name === 'mc:Choice' || name === 'mc:Fallback')) {
        b.cur = b.hasText.length
        b.hasText.push(false)
        if (name === 'mc:Fallback') b.fallback = b.cur
        return
      }
      if (name === 'w:t' || name === 'a:t') {
        if (!tDepth) tDepth = d
      }
      else if (name === 'w:txbxContent') {
        mark()
      }
    },
    close() {
      if (d === tDepth) tDepth = 0
      const b = blocks[blocks.length - 1]
      if (b && d === b.depth + 1) {
        b.cur = -1
      }
      else if (b && d === b.depth) {
        blocks.pop()
        let pick = b.hasText.findIndex((t, k) => t && k !== b.fallback)
        if (pick < 0) pick = b.fallback >= 0 ? b.fallback : 0
        chosen[b.index] = pick
        // 裡面這一塊讀得出字 → 外面那一塊的這個分支也算讀得出字（巢狀的替代內容）
        if (b.hasText[pick]) mark()
      }
      d--
    },
    text(s, e) {
      if (tDepth && e > s) mark()
    },
  }, budget)
  return chosen
}

/** 第二遍走的時候用：照第一遍的決定，告訴呼叫端哪一個 mc:Choice／mc:Fallback 要整段略過 */
function alternateContentFilter(xml: string, budget: ReadBudget) {
  const chosen = alternateContentChoices(xml, budget)
  const open: Array<{ depth: number, pick: number, next: number }> = []
  let seen = 0
  return {
    /** skipping：外層已經在略過了（裡面的替代內容只計數，好讓順序跟第一遍對得上） */
    skips(name: string, depth: number, skipping: boolean): boolean {
      if (name === 'mc:AlternateContent') {
        seen++
        if (!skipping) open.push({ depth, pick: chosen[seen - 1] ?? 0, next: 0 })
        return false
      }
      if (skipping || (name !== 'mc:Choice' && name !== 'mc:Fallback')) return false
      const ac = open[open.length - 1]
      if (!ac || depth !== ac.depth + 1) return false
      return ac.next++ !== ac.pick
    },
    closed(depth: number) {
      const ac = open[open.length - 1]
      if (ac && ac.depth === depth) open.pop()
    },
  }
}

// ── Word ───────────────────────────────────────────────────────────

/** 表格的一格，照「格線」的位置放（col＝從第幾欄開始、span＝佔幾欄） */
interface GridCell { col: number, span: number, text: string }

/** 收一塊字的地方：本文（root）、文字方塊（box）、表格的一格（tc） */
interface BoxFrame { k: 'box' | 'tc', depth: number, parts: string[], span: number, vMerge?: string }
interface ParaFrame { k: 'p', depth: number, buf: string[], style: string, list: boolean, after: string[] }
interface TableFrame { k: 'tbl', depth: number, rows: GridCell[][], prev: GridCell[], stray: string[] }
interface RowFrame { k: 'tr', depth: number, cells: GridCell[], ownText: boolean, gridBefore: number, prevAt: number }
type Frame = BoxFrame | ParaFrame | TableFrame | RowFrame

/**
 * 這幾種元素整段不讀：修訂紀錄裡「改之前的屬性」（*PrChange）、搬走前的原文（w:moveFrom，搬到的地方 w:moveTo 會讀）。
 * ⛔ 不略過 w:tcPrChange 的話，舊的 `<w:vMerge/>` 會被當成現在的屬性，W2 的容量變成上一列的 12L。
 */
const skippedInDocx = (name: string) => name.endsWith('PrChange') || name === 'w:tblGridChange' || name === 'w:moveFrom'

/** 屬性裡的整數（格數）；讀不出來用預設值，限制在 [min, max] */
function intAttr(v: string | undefined, def: number, min: number, max: number): number {
  const n = Number.parseInt(v ?? '', 10)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def
}

/** 一個 `<w:p>` 段落 → 一行文字（tab 變空白、換行保留、清單項目前面加「・」、標題加「## 」） */
function paragraphLine(p: ParaFrame): string {
  const out = p.buf.join('').replace(/[ \t]+/g, ' ').trim()
  if (!out) return ''
  if (/^(heading|title)\s*\d*$/i.test(p.style)) return `## ${out}`
  if (p.list) return `・${out}`
  return out
}

/**
 * 表格的一列收進一格。合併儲存格要照「格線」排（2026-10-10 審查實測）：
 *  · 橫向合併（gridSpan＝N）佔 N 欄——不照格線排的話後面每一格都往左移一欄，
 *    「12,900」會被標成「容量」而不是「價格」；
 *  · 這一列前面空了幾欄（trPr 的 gridBefore）也要讓出來，否則「12L」會被標成「品名」；
 *  · 直向合併的下半格（vMerge 沒有 restart）是空的——照上一列同一欄的值補上，
 *    「品名」被合併的那幾列才不會少了名字。
 */
function addCell(tr: RowFrame, tbl: TableFrame, cell: BoxFrame): void {
  const last = tr.cells[tr.cells.length - 1]
  const col = last ? last.col + last.span : tr.gridBefore
  const continues = cell.vMerge !== undefined && cell.vMerge !== 'restart'
  let text: string
  if (continues) {
    // 上一列的格子照欄位排好，指標只往右走（⛔ 每格都從頭找，寬表格會變平方）
    const prev = tbl.prev
    while (tr.prevAt < prev.length && prev[tr.prevAt]!.col < col) tr.prevAt++
    const above = prev[tr.prevAt]
    text = above && above.col === col ? above.text : ''
  }
  else {
    text = joinBlocks(cell.parts).replace(/\n+/g, ' ').trim()
  }
  tr.cells.push({ col, span: cell.span, text })
  if (text && !continues) tr.ownText = true
}

function finishRow(tbl: TableFrame, tr: RowFrame): void {
  if (!tr.cells.length) return
  tbl.prev = tr.cells
  // 只有直向合併帶下來的字（自己每一格都空）→ 不另寫一行：⛔ 寫出來就是重複的「品名：W1」
  if (tr.ownText) tbl.rows.push(tr.cells)
}

/**
 * 第一列能不能當欄位名稱：每一欄都有字（中間沒有空欄、前面沒有空出來的欄）、至少兩欄、表格至少兩列。
 * 橫向合併的欄位名稱（「價格」跨兩欄）兩欄都算「價格」。
 */
function headerUsable(rows: GridCell[][]): boolean {
  if (rows.length < 2) return false
  let width = 0
  for (const c of rows[0]!) {
    if (c.col !== width || !c.text.trim()) return false
    width = c.col + c.span
  }
  return width >= 2
}

/**
 * 表格列 → 文字（Word 與 tableRowsToText 共用）。第一列能當欄位名稱 → 之後每列寫「欄位：值」；
 * 同一個欄位名稱連著好幾欄（合併的欄位名稱）→ 值用「／」接在同一個欄位下
 * （「價格：12,900／9,900」，⛔ 不寫兩次「價格」，看起來像兩個互相矛盾的價格）。
 * 否則每列用「｜」接起來（不硬猜欄位名稱：猜錯比不猜更會誤導 AI）。
 * ⛔ 欄位名稱不要攤成「每一欄一格」的陣列：惡意檔一列幾十萬格、每格跨 63 欄，攤開就是上千萬格。
 */
function gridToText(rows: GridCell[][], budget?: ReadBudget): string {
  if (!rows.length) return ''
  const useHeader = headerUsable(rows)
  const head = rows[0]!
  const labels = head.map(c => c.text.trim())
  const lines: string[] = []
  for (const r of useHeader ? rows.slice(1) : rows) {
    let line: string
    if (useHeader) {
      const pairs: string[] = []
      let last: string | undefined
      let hp = 0
      for (const c of r) {
        if (!c.text.trim()) continue
        // 兩邊都照欄位排好，指標只往右走
        while (hp < head.length && head[hp]!.col + head[hp]!.span <= c.col) hp++
        const h = hp < head.length && head[hp]!.col <= c.col ? labels[hp] : undefined
        if (h && h === last) pairs[pairs.length - 1] += `／${c.text}`
        else pairs.push(h ? `${h}：${c.text}` : c.text)
        last = h
      }
      line = pairs.join('；')
    }
    else {
      line = r.filter(c => c.text).map(c => c.text).join('｜')
    }
    if (!line) continue
    if (budget) {
      // 欄位名稱每列都寫一次＝字數會放大；用完額度就停（見 MAX_TABLE_CHARS）
      if (budget.tableChars <= 0) {
        budget.truncated = true
        break
      }
      budget.tableChars -= line.length
    }
    lines.push(line)
  }
  return lines.join('\n')
}

/**
 * 表格列 → 文字。第一列每格都有字、且至少兩欄 → 當欄位名稱，之後每列寫「欄位：值」；
 * 否則每列用「｜」接起來（不硬猜欄位名稱：猜錯比不猜更會誤導 AI）。
 */
export function tableRowsToText(rows: string[][]): string {
  return gridToText(rows.map(r => r.map((text, col) => ({ col, span: 1, text }))))
}

/** `<w:tbl>` → 「欄位：值；欄位：值」逐列 */
function docxTableText(rows: GridCell[][], budget: ReadBudget): string {
  const lines: string[] = []
  let k = 0
  // 第一列只有一格（多半是橫跨整張表的表名「2026 秋季價目表」）→ 那是表名不是欄位名稱：
  // 自己寫一行，欄位名稱改看下一列。⛔ 不先拿掉的話，表名照合併補滿整列，會被當成每一欄的欄位名稱
  while (k < rows.length && rows[k]!.length === 1) {
    lines.push(rows[k]![0]!.text)
    k++
  }
  const rest = gridToText(rows.slice(k), budget)
  if (rest) lines.push(rest)
  return lines.join('\n')
}

/**
 * Word 的 document.xml → 文字。表格前後空一行，讓 AI 看得出那是一張表。
 *
 * 一次走完整份，用一疊「框」記住現在在哪裡（段落／表格／列／格子／文字方塊）：
 * - 只拿「這一層」的列與格；格子裡若又有表格，內層攤平成一格文字。⛔ 不可以把內層表格的列當外層的列——欄位整個錯位。
 * - 文字方塊（w:txbxContent）長在段落裡面：另外當段落讀，排在那一段後面。否則它的字會黏在旁邊那段正文上
 *   （「限時優惠 8 折正文」）。文字方塊裡有表格也一樣排在後面，⛔ 不可以把外面那一段切成兩半而丟字。
 * - 表格／文字方塊套超過 MAX_NESTING 層，更深的不再分欄位，字直接併進最深那一層讀。
 */
function docxDocumentText(xml: string, budget: ReadBudget): string {
  const alt = alternateContentFilter(xml, budget)
  const root: BoxFrame = { k: 'box', depth: 0, parts: [], span: 1 }
  const frames: Frame[] = [root]
  let d = 0
  let skipDepth = 0
  let tDepth = 0
  let nesting = 0
  const top = (): Frame => frames[frames.length - 1]!
  /** 讀好的一塊字放哪：段落裡的（文字方塊、段落裡的表格）排在段落後面；格子／文字方塊放自己裡面；列跟列之間的放表格後面 */
  const sink = (): string[] => {
    for (let k = frames.length - 1; k > 0; k--) {
      const f = frames[k]!
      if (f.k === 'p') return f.after
      if (f.k === 'box' || f.k === 'tc') return f.parts
      if (f.k === 'tbl') return f.stray
    }
    return root.parts
  }
  const push = (p: ParaFrame, s: string) => {
    const t = take(budget, s)
    if (t) p.buf.push(t)
  }
  const finish = (f: Frame) => {
    switch (f.k) {
      case 'p': {
        const line = paragraphLine(f)
        const to = sink()
        if (line) to.push(line)
        for (const a of f.after) to.push(a)
        return
      }
      case 'box': {
        nesting--
        const t = joinBlocks(f.parts)
        if (t) sink().push(t)
        return
      }
      case 'tc': {
        const tr = top()
        const tbl = frames[frames.length - 2]
        if (tr.k === 'tr' && tbl?.k === 'tbl') addCell(tr, tbl, f)
        return
      }
      case 'tr': {
        const tbl = top()
        if (tbl.k === 'tbl') finishRow(tbl, f)
        return
      }
      case 'tbl': {
        nesting--
        const t = docxTableText(f.rows, budget)
        const to = sink()
        if (t) to.push('', t, '')
        for (const s of f.stray) to.push(s)
      }
    }
  }

  walkXml(xml, {
    open(name, parent, s, e) {
      d++
      const altSkip = alt.skips(name, d, skipDepth > 0)
      if (skipDepth) return
      if (altSkip || skippedInDocx(name)) {
        skipDepth = d
        return
      }
      const f = top()
      switch (name) {
        case 'w:p':
          // 段落裡又有段落（太深的文字方塊攤平時才會有）：換行接著讀
          if (f.k === 'p') push(f, '\n')
          else frames.push({ k: 'p', depth: d, buf: [], style: '', list: false, after: [] })
          return
        case 'w:t':
          if (f.k === 'p' && !tDepth) tDepth = d
          return
        case 'w:tab':
          // 只算文字裡的 tab；段落設定裡的定位點（w:tabs 底下的 w:tab）不是字
          if (f.k === 'p' && parent === 'w:r') push(f, ' ')
          return
        case 'w:br':
        case 'w:cr':
          if (f.k === 'p' && parent === 'w:r') push(f, '\n')
          return
        case 'w:pStyle':
          if (f.k === 'p' && parent === 'w:pPr' && d === f.depth + 2) f.style = attrOf(xml, s, e, 'w:val') ?? ''
          return
        case 'w:numPr':
          if (f.k === 'p' && parent === 'w:pPr' && d === f.depth + 2) f.list = true
          return
        case 'w:numId':
          // numId 0＝「取消編號」，不是清單
          if (f.k === 'p' && parent === 'w:numPr' && d === f.depth + 3 && attrOf(xml, s, e, 'w:val') === '0') f.list = false
          return
        case 'w:txbxContent':
          if (nesting < MAX_NESTING) {
            nesting++
            frames.push({ k: 'box', depth: d, parts: [], span: 1 })
          }
          return
        case 'w:tbl':
          if (nesting < MAX_NESTING) {
            nesting++
            frames.push({ k: 'tbl', depth: d, rows: [], prev: [], stray: [] })
          }
          return
        case 'w:tr':
          if (f.k === 'tbl') frames.push({ k: 'tr', depth: d, cells: [], ownText: false, gridBefore: 0, prevAt: 0 })
          return
        case 'w:gridBefore':
          // Word 一張表最多 63 欄
          if (f.k === 'tr' && parent === 'w:trPr' && d === f.depth + 2) f.gridBefore = intAttr(attrOf(xml, s, e, 'w:val'), 0, 0, 63)
          return
        case 'w:tc':
          if (f.k === 'tr') frames.push({ k: 'tc', depth: d, parts: [], span: 1 })
          return
        case 'w:gridSpan':
          if (f.k === 'tc' && parent === 'w:tcPr' && d === f.depth + 2) f.span = intAttr(attrOf(xml, s, e, 'w:val'), 1, 1, 63)
          return
        case 'w:vMerge':
          if (f.k === 'tc' && parent === 'w:tcPr' && d === f.depth + 2) f.vMerge = attrOf(xml, s, e, 'w:val') ?? 'continue'
      }
    },
    close() {
      if (skipDepth) {
        if (d === skipDepth) skipDepth = 0
        d--
        return
      }
      if (d === tDepth) tDepth = 0
      alt.closed(d)
      const f = top()
      if (f.depth === d) {
        frames.pop()
        finish(f)
      }
      d--
    },
    text(s, e) {
      if (skipDepth || !tDepth) return
      const f = top()
      if (f.k === 'p') push(f, decodeXmlEntities(xml.slice(s, e)))
    },
  }, budget)
  return joinBlocks(root.parts)
}

export function extractDocxText(buf: Buffer): { text: string, meta: Record<string, string | number> } {
  const entries = readZipDirectory(buf)
  if (!entries) badZip('docx', notZipReason(buf, 'docx'))
  const doc = entries.find(e => e.name === 'word/document.xml')
  if (!doc) badZip('docx', '找不到文件內容')
  let xml: string
  try {
    xml = readZipEntry(buf, doc).toString('utf8')
  }
  catch (e) {
    badZip('docx', ZIP_FAILURE_WHY[failureOf(e)])
  }
  const budget = newReadBudget()
  const text = docxDocumentText(xml, budget)
  return { text, meta: budget.truncated ? { format: 'docx', textTruncated: 1 } : { format: 'docx' } }
}

// ── PowerPoint ─────────────────────────────────────────────────────

/** 依簡報「實際的投影片順序」排（presentation.xml 的清單），不是靠檔名的數字 */
function pptxSlideOrder(buf: Buffer, entries: ZipEntry[], inflate: { left: number }, budget: ReadBudget): string[] {
  const byName = new Map(entries.map(e => [e.name, e]))
  const slideFiles = new Set(entries.map(e => e.name).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)))
  const numeric = [...slideFiles].sort((a, b) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]))
  const pres = byName.get('ppt/presentation.xml')
  const rels = byName.get('ppt/_rels/presentation.xml.rels')
  if (!pres || !rels) return numeric
  let presXml: string
  let relXml: string
  try {
    presXml = readZipEntry(buf, pres, inflate).toString('utf8')
    relXml = readZipEntry(buf, rels, inflate).toString('utf8')
  }
  catch {
    return numeric
  }
  const target = new Map<string, string>()
  walkXml(relXml, {
    open(name, _parent, s, e) {
      if (name !== 'Relationship') return
      const id = attrOf(relXml, s, e, 'Id')
      const t = attrOf(relXml, s, e, 'Target')
      if (id && t) target.set(id, t.replace(/^\/?(ppt\/)?/, 'ppt/'))
    },
    close: noop,
    text: noop,
  }, budget)
  const ordered: string[] = []
  const seen = new Set<string>()
  walkXml(presXml, {
    open(name, _parent, s, e) {
      if (name !== 'p:sldId') return
      const t = target.get(attrOf(presXml, s, e, 'r:id') ?? '')
      // 同一張列兩次只算一次（⛔ 不然重複的清單會讓同一張被解壓好幾次）
      if (t && slideFiles.has(t) && !seen.has(t)) {
        seen.add(t)
        ordered.push(t)
      }
    },
    close: noop,
    text: noop,
  }, budget)
  // 清單讀不出來（或少了幾張）就退回檔名順序，⛔ 不要因此少讀投影片
  return ordered.length === numeric.length ? ordered : numeric
}

function pptxSlideText(xml: string, budget: ReadBudget): string {
  const alt = alternateContentFilter(xml, budget)
  const lines: string[] = []
  let d = 0
  let skipDepth = 0
  let tDepth = 0
  let para: { depth: number, buf: string[] } | null = null
  const push = (s: string) => {
    const t = take(budget, s)
    if (t) para!.buf.push(t)
  }
  walkXml(xml, {
    open(name) {
      d++
      const altSkip = alt.skips(name, d, skipDepth > 0)
      if (skipDepth) return
      if (altSkip) {
        skipDepth = d
        return
      }
      if (name === 'a:p') {
        if (para) push('\n')
        else para = { depth: d, buf: [] }
        return
      }
      if (!para) return
      if (name === 'a:t') {
        if (!tDepth) tDepth = d
      }
      // PowerPoint 的換行多半寫成 `<a:br><a:rPr/></a:br>`（不是自閉合），一律算換行
      else if (name === 'a:br') {
        push('\n')
      }
    },
    close() {
      if (skipDepth) {
        if (d === skipDepth) skipDepth = 0
        d--
        return
      }
      if (d === tDepth) tDepth = 0
      alt.closed(d)
      if (para && para.depth === d) {
        const line = para.buf.join('').replace(/[ \t]+/g, ' ').trim()
        if (line) lines.push(line)
        para = null
      }
      d--
    },
    text(s, e) {
      if (!skipDepth && tDepth && para) push(decodeXmlEntities(xml.slice(s, e)))
    },
  }, budget)
  return lines.join('\n')
}

export function extractPptxText(buf: Buffer): { text: string, meta: Record<string, string | number> } {
  const entries = readZipDirectory(buf)
  if (!entries) badZip('pptx', notZipReason(buf, 'pptx'))
  const byName = new Map(entries.map(e => [e.name, e]))
  const inflate = { left: MAX_TOTAL_INFLATED_BYTES }
  const budget = newReadBudget()
  const order = pptxSlideOrder(buf, entries, inflate, budget)
  if (!order.length) badZip('pptx', '找不到任何投影片')
  const out: string[] = []
  let withText = 0
  // 讀不出來的投影片要數出來講（單張壞掉不擋整份，但⛔不可以默默少幾張）
  let unreadable = 0
  let tooLarge = 0
  order.forEach((name, i) => {
    // 解壓或讀取的額度用完之後，剩下的每一張都直接算讀不出來（內容大到不正常），不再解壓
    if (budgetUsedUp(budget)) {
      budget.truncated = true
      unreadable++
      tooLarge++
      return
    }
    let xml: string
    try {
      xml = readZipEntry(buf, byName.get(name)!, inflate).toString('utf8')
    }
    catch (e) {
      const reason = failureOf(e)
      if (reason === 'encrypted') badZip('pptx', '有密碼保護')
      unreadable++
      if (reason === 'too-large') tooLarge++
      return
    }
    const text = pptxSlideText(xml, budget)
    if (!text) return
    withText++
    out.push(`## 第 ${i + 1} 張投影片`, text, '')
  })
  // 一張都讀不出來：直接講原因。⛔ 不要回空字串——呼叫端會以為「投影片都是圖片」，叫人去存成圖片
  if (unreadable === order.length) badZip('pptx', tooLarge ? '投影片內容大到不正常' : '投影片都讀不出來，檔案可能損毀')
  const meta: Record<string, string | number> = { slides: order.length, slidesWithText: withText, slidesUnreadable: unreadable }
  if (budget.truncated) meta.textTruncated = 1
  return { text: out.join('\n').trim(), meta }
}

// ── 純文字檔（.txt／.md／.csv）的編碼判斷 ────────────────────────────

export type TextEncodingName = 'utf-8' | 'utf-16le' | 'utf-16be' | 'big5'

function countReplacementChars(s: string): number {
  let n = 0
  for (let i = s.indexOf('�'); i >= 0; i = s.indexOf('�', i + 1)) n++
  return n
}

/**
 * Big5 讀法裡「解得出來、但不像台灣中文」的有多少（以位元組計，跟 UTF-8 一個壞位元組一個「�」可以直接比）。
 * - 81–A0、FA–FE 開頭：香港增補字／造字區，台灣的 Big5（CP950）用不到。瀏覽器標準的解碼器會把它們也解成
 *   某個罕用字（不會變成「�」）——cp1252 的彎引號 0x93 後面接一個英文字母就正好落在這裡。
 * - 一半以上是次常用字（C6A1 以後）：台灣的中文絕大多數是常用字；俄文（cp1251）、西歐（cp1252）的字母
 *   兩兩湊成一個字才會整片落在這區——這時整份的雙位元組字都不可信。⛔ 這種檔用 Big5 讀還會把後面的英文字母
 *   吃掉（「crème」讀成「cr鋗e」），用 UTF-8 讀只是那幾個字母變「�」，英數都留著。
 * 單獨一個壞位元組不在這裡算：解碼器本來就會換成「�」。
 */
function big5Implausibility(buf: Buffer): number {
  let foreign = 0
  let pairs = 0
  let rare = 0
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!
    if (b < 0x81 || b === 0xFF) continue
    const t = buf[i + 1]
    if (t === undefined || !((t >= 0x40 && t <= 0x7E) || (t >= 0xA1 && t <= 0xFE))) continue
    i++
    if (b < 0xA1 || b > 0xF9) {
      foreign++
    }
    else {
      pairs++
      if (b > 0xC6 || (b === 0xC6 && t >= 0xA1)) rare++
    }
  }
  return 2 * foreign + (rare * 2 > pairs ? 2 * pairs : 0)
}

/**
 * bytes → 字串，自己判斷編碼：BOM → 完全合法的 UTF-8 → 完全合法的（台灣）Big5 →
 * 都不完全合法時兩種都讀，取「讀不出來的字」少的那個（一樣多算 UTF-8）。
 *
 * unreadableChars：選定的讀法裡有幾個字讀不出來（「�」，Big5 另加上面那種台灣用不到的字）。
 * 大於 0 時呼叫端應該提醒「有 N 個字讀不出來，請另存成 UTF-8 再傳」。
 *
 * ⛔ 不要只靠 UTF-8 加替代字元硬讀：Big5 的 CSV 會整份變成「�」，看起來像資料壞了，沒有人會想到是編碼。
 * ⛔ 也不要用「UTF-8 壞的字夠少就算 UTF-8」的門檻：常用中文字有一半，Big5 的第二個位元組是英文字母，
 *    UTF-8 讀起來每個中文字只壞一個——中文表頭＋1000 列英數的 Big5 CSV 會整份被當成 UTF-8，
 *    「品名」讀成亂碼還不會警告（2026-10-11 審查實測）。
 * 仍然要守住：UTF-8 檔裡有幾個壞位元組（複製貼上帶進來的）→ 還是 UTF-8，壞的那幾個字換掉就好；
 *    Big5 讀 UTF-8 的中文會壞一大堆，比較之下 UTF-8 一定贏。
 */
export function decodeTextBuffer(buf: Buffer): { text: string, encoding: TextEncodingName, unreadableChars: number } {
  const result = (text: string, encoding: TextEncodingName) => ({ text, encoding, unreadableChars: countReplacementChars(text) })
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return result(new TextDecoder('utf-8').decode(buf.subarray(3)), 'utf-8')
  }
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    return result(new TextDecoder('utf-16le').decode(buf.subarray(2)), 'utf-16le')
  }
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    return result(new TextDecoder('utf-16be').decode(buf.subarray(2)), 'utf-16be')
  }
  try {
    return result(new TextDecoder('utf-8', { fatal: true }).decode(buf), 'utf-8')
  }
  catch {}
  const oddBig5 = big5Implausibility(buf)
  if (!oddBig5) {
    try {
      return result(new TextDecoder('big5', { fatal: true }).decode(buf), 'big5')
    }
    catch {}
  }
  const utf8 = result(new TextDecoder('utf-8').decode(buf), 'utf-8')
  const big5 = result(new TextDecoder('big5').decode(buf), 'big5')
  big5.unreadableChars += oddBig5
  return big5.unreadableChars < utf8.unreadableChars ? big5 : utf8
}
