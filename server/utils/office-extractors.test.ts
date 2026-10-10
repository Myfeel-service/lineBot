import { describe, expect, it } from 'vitest'
import { makeZip } from './test-helpers/make-zip'

// office-extractors.ts 用 Nuxt 全域 createError 丟 4xx；unit 測試環境沒有這個全域，補一個最小版。
;(globalThis as unknown as { createError?: unknown }).createError ??= (opts: { statusCode?: number; statusMessage?: string }) =>
  Object.assign(new Error(opts?.statusMessage ?? 'error'), opts)

const {
  decodeTextBuffer,
  extractDocxText,
  extractPptxText,
  readZipDirectory,
  readZipEntry,
  tableRowsToText,
  topLevelBlocks,
} = await import('./office-extractors')

const W =(body: string) => `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="x"><w:body>${body}<w:sectPr/></w:body></w:document>`
const p = (text: string, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
const cell = (inner: string) => `<w:tc><w:tcPr/>${inner}</w:tc>`
const row = (...cells: string[]) => `<w:tr><w:trPr/>${cells.map(c => cell(p(c))).join('')}</w:tr>`

describe('zip 讀取', () => {
  it('壓縮與不壓縮的項目都讀得出來', () => {
    for (const method of [0, 8] as const) {
      const buf = makeZip({ 'a.txt': '你好', 'dir/b.xml': '<x>保固一年</x>' }, method)
      const entries = readZipDirectory(buf)!
      expect(entries.map(e => e.name)).toEqual(['a.txt', 'dir/b.xml'])
      expect(readZipEntry(buf, entries[1]!).toString('utf8')).toBe('<x>保固一年</x>')
    }
  })
  it('不是 zip（舊版 .doc、亂丟的檔）→ null，不丟例外', () => {
    expect(readZipDirectory(Buffer.from('這不是 zip 檔'))).toBeNull()
    expect(readZipDirectory(Buffer.alloc(0))).toBeNull()
  })
})

describe('topLevelBlocks', () => {
  it('同名巢狀只回最外層；<w:p 不會吃到 <w:pPr；自閉合 <w:p/> 自成一塊', () => {
    const xml = '<w:p><w:pPr/><w:t>a</w:t></w:p><w:p/><w:tbl><w:tbl></w:tbl></w:tbl>'
    expect(topLevelBlocks(xml, 'w:p').map(b => xml.slice(b.start, b.end)))
      .toEqual(['<w:p><w:pPr/><w:t>a</w:t></w:p>', '<w:p/>'])
    expect(topLevelBlocks(xml, 'w:tbl')).toHaveLength(1)
  })
})

describe('extractDocxText', () => {
  it('段落、標題、清單、實體字元照原樣讀出', () => {
    const xml = W([
      p('W1 使用說明書', '<w:pStyle w:val="Heading1"/>'),
      p('本產品主機自購買日起保固一年。'),
      p('勿自行拆解', '<w:numPr><w:ilvl w:val="0"/></w:numPr>'),
      p('價格 &lt; NT$13,000 &amp; 含運'),
      '<w:p/>',
    ].join(''))
    const { text } = extractDocxText(makeZip({ 'word/document.xml': xml }))
    expect(text).toBe([
      '## W1 使用說明書',
      '本產品主機自購買日起保固一年。',
      '・勿自行拆解',
      '價格 < NT$13,000 & 含運',
    ].join('\n'))
  })

  it('表格第一列當欄位名稱 → 每列寫成「欄位：值」（AI 才知道 12,900 是價格）', () => {
    const table = `<w:tbl><w:tblPr/>${row('品名', '容量', '價格')}${row('W1 REGEN 改', '12L', '12,900')}${row('W1 mini', '', '8,990')}</w:tbl>`
    const { text } = extractDocxText(makeZip({ 'word/document.xml': W(p('價目表') + table + p('以上含稅')) }))
    expect(text).toBe([
      '價目表',
      '',
      '品名：W1 REGEN 改；容量：12L；價格：12,900',
      '品名：W1 mini；價格：8,990',
      '',
      '以上含稅',
    ].join('\n'))
  })

  it('格子裡又有表格：內層攤成一格文字，⛔ 不可以把內層的列當外層的列', () => {
    const inner = `<w:tbl>${row('零件', '保固')}${row('主機', '1 年')}${row('濾網', '不保固')}</w:tbl>`
    const outer = `<w:tbl>${row('項目', '說明')}<w:tr>${cell(p('保固'))}${cell(inner)}</w:tr></w:tbl>`
    const { text } = extractDocxText(makeZip({ 'word/document.xml': W(outer) }))
    // 外層只有一列資料；內層兩列被收在「說明」那一格裡
    expect(text.split('\n').filter(Boolean)).toEqual(['項目：保固；說明：零件：主機；保固：1 年 零件：濾網；保固：不保固'])
  })

  it('合併儲存格照格線排：橫向合併不讓後面的格往左移、直向合併的下半格補上一列的值', () => {
    const tc = (t: string, pr = '') => `<w:tc>${pr ? `<w:tcPr>${pr}</w:tcPr>` : ''}${p(t)}</w:tc>`
    const table = '<w:tbl>'
      + `<w:tr>${tc('品名')}${tc('容量')}${tc('價格')}</w:tr>`
      // 「W1 套組」橫跨品名＋容量兩欄：⛔ 以前 12,900 會被標成「容量」
      + `<w:tr>${tc('W1 套組', '<w:gridSpan w:val="2"/>')}${tc('12,900')}</w:tr>`
      + `<w:tr>${tc('W1 mini', '<w:vMerge w:val="restart"/>')}${tc('6L')}${tc('8,990')}</w:tr>`
      + `<w:tr>${tc('', '<w:vMerge/>')}${tc('8L')}${tc('9,990')}</w:tr>`
      + '</w:tbl>'
    const { text } = extractDocxText(makeZip({ 'word/document.xml': W(table) }))
    expect(text.split('\n').filter(Boolean)).toEqual([
      '品名：W1 套組；價格：12,900',
      '品名：W1 mini；容量：6L；價格：8,990',
      '品名：W1 mini；容量：8L；價格：9,990',
    ])
  })

  it('文字方塊只讀一次（替代內容 mc:Fallback 不讀），也不黏在旁邊那段正文上', () => {
    const box = (t: string) => `<w:txbxContent>${p(t)}</w:txbxContent>`
    const para = `<w:p><w:r><mc:AlternateContent><mc:Choice>${box('限時優惠 8 折')}</mc:Choice><mc:Fallback>${box('限時優惠 8 折')}</mc:Fallback></mc:AlternateContent></w:r><w:r><w:t>正文</w:t></w:r></w:p>`
    expect(extractDocxText(makeZip({ 'word/document.xml': W(para) })).text).toBe('正文\n限時優惠 8 折')
  })

  it('有密碼的 Office 檔（不是 zip、是舊式外殼）→ 講可能有密碼，不只叫人另存', () => {
    const ole = Buffer.from('d0cf11e0a1b11ae1000000000000', 'hex')
    expect(() => extractDocxText(ole)).toThrow(/可能有密碼保護/)
  })

  it('壞掉的字元實體（超出 Unicode 範圍）照原樣留著，⛔ 不可以讓整份丟錯', () => {
    expect(extractDocxText(makeZip({ 'word/document.xml': W(p('A&#x110000;B')) })).text).toBe('A&#x110000;B')
  })

  it('修訂模式刪掉的字不讀（<w:delText>），插入的照讀', () => {
    const xml = W('<w:p><w:del><w:r><w:delText>舊價格 9,990</w:delText></w:r></w:del><w:ins><w:r><w:t>新價格 8,990</w:t></w:r></w:ins></w:p>')
    expect(extractDocxText(makeZip({ 'word/document.xml': xml })).text).toBe('新價格 8,990')
  })

  it('舊版 .doc（不是 zip）→ 講清楚要另存 .docx', () => {
    expect(() => extractDocxText(Buffer.from('\xD0\xCF\x11\xE0 舊版 Word 二進位檔'))).toThrow(/另存成 \.docx/)
  })

  it('是 zip 但沒有 word/document.xml → 講找不到內容', () => {
    expect(() => extractDocxText(makeZip({ 'other.xml': '<x/>' }))).toThrow(/找不到文件內容/)
  })
})

describe('extractPptxText', () => {
  const slide = (...paras: string[]) => `<p:sld><p:cSld><p:spTree>${paras.map(t => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join('')}</p:spTree></p:cSld></p:sld>`

  it('照簡報實際順序讀（不是檔名數字）、每張標「第 N 張投影片」、空白投影片略過', () => {
    const buf = makeZip({
      'ppt/presentation.xml': '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/><p:sldId id="258" r:id="rId4"/></p:sldIdLst></p:presentation>',
      'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/><Relationship Id="rId3" Target="slides/slide2.xml"/><Relationship Id="rId4" Target="slides/slide3.xml"/></Relationships>',
      'ppt/slides/slide1.xml': slide('第二張：保固一年'),
      'ppt/slides/slide2.xml': slide('封面', 'W1 REGEN 改'),
      'ppt/slides/slide3.xml': slide(),
    })
    const { text, meta } = extractPptxText(buf)
    expect(text).toBe(['## 第 1 張投影片', '封面', 'W1 REGEN 改', '', '## 第 2 張投影片', '第二張：保固一年'].join('\n'))
    expect(meta).toEqual({ slides: 3, slidesWithText: 2, slidesUnreadable: 0 })
  })

  it('讀不到順序清單就照檔名數字排（slide2 在 slide10 前面），不少讀投影片', () => {
    const buf = makeZip({
      'ppt/slides/slide10.xml': slide('十'),
      'ppt/slides/slide2.xml': slide('二'),
    })
    expect(extractPptxText(buf).text).toBe(['## 第 1 張投影片', '二', '', '## 第 2 張投影片', '十'].join('\n'))
  })

  it('舊版 .ppt → 講清楚要另存 .pptx', () => {
    expect(() => extractPptxText(Buffer.from('not a zip'))).toThrow(/另存成 \.pptx/)
  })
})

describe('tableRowsToText', () => {
  it('第一列有空格（不像欄位名稱）→ 不硬猜，每列用「｜」接', () => {
    expect(tableRowsToText([['2026 秋季價目表', ''], ['W1', '12,900']])).toBe('2026 秋季價目表\nW1｜12,900')
  })
})

describe('decodeTextBuffer', () => {
  it('Big5（台灣購物平台常見的 CSV）→ 自動認出來，不變亂碼', () => {
    // 「品名,價格\n電話,0912345678」的 Big5 bytes（iconv 產生）
    const big5 = Buffer.from('ab7ea6572cbbf9aee60ab971b8dc2c30393132333435363738', 'hex')
    expect(decodeTextBuffer(big5)).toEqual({ text: '品名,價格\n電話,0912345678', encoding: 'big5' })
  })
  it('⛔ 大部分是 UTF-8、只有一個壞位元組 → 還是 UTF-8（不可以整份改用 Big5 讀成亂碼）', () => {
    const mostly = Buffer.concat([Buffer.from('品名,價格\n耶加雪菲,450\n', 'utf8'), Buffer.from([0xFF]), Buffer.from('曼特寧,420\n', 'utf8')])
    const r = decodeTextBuffer(mostly)
    expect(r.encoding).toBe('utf-8')
    expect(r.text).toContain('耶加雪菲')
    expect(r.text).toContain('曼特寧')
  })

  it('UTF-8（有沒有 BOM 都行）與 UTF-16 都讀得出來', () => {
    expect(decodeTextBuffer(Buffer.from('﻿保固一年', 'utf8'))).toEqual({ text: '保固一年', encoding: 'utf-8' })
    expect(decodeTextBuffer(Buffer.from('保固一年', 'utf8')).encoding).toBe('utf-8')
    expect(decodeTextBuffer(Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('保固', 'utf16le')]))).toEqual({ text: '保固', encoding: 'utf-16le' })
  })
})
