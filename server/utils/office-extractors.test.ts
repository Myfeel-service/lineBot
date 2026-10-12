import { describe, expect, it } from 'vitest'
import { makeDocx, makeZip } from './test-helpers/make-zip'

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
} = await import('./office-extractors')

const W =(body: string) => `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="x"><w:body>${body}<w:sectPr/></w:body></w:document>`
const p = (text: string, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
const cell = (inner: string) => `<w:tc><w:tcPr/>${inner}</w:tc>`
const row = (...cells: string[]) => `<w:tr><w:trPr/>${cells.map(c => cell(p(c))).join('')}</w:tr>`
/** 有屬性的格子：pr 放進 <w:tcPr>（gridSpan、vMerge、修訂紀錄…） */
const tc = (inner: string, pr = '') => `<w:tc><w:tcPr><w:tcW w:w="100"/>${pr}</w:tcPr>${inner}</w:tc>`
const tr = (...cells: string[]) => `<w:tr>${cells.join('')}</w:tr>`
const tbl = (...rows: string[]) => `<w:tbl><w:tblPr/><w:tblGrid/>${rows.join('')}</w:tbl>`
const docx = (body: string) => extractDocxText(makeDocx(body)).text
/** Word 的文字方塊：新版（DrawingML）跟舊版（VML）各放一份，包在替代內容裡 */
const textBox = (inner: string) => `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:txbx><w:txbxContent>${inner}</w:txbxContent></wps:txbx></w:drawing></mc:Choice><mc:Fallback><w:pict><v:textbox><w:txbxContent>${inner}</w:txbxContent></v:textbox></w:pict></mc:Fallback></mc:AlternateContent></w:r>`
const slide = (...paras: string[]) => `<p:sld><p:cSld><p:spTree>${paras.map(t => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join('')}</p:spTree></p:cSld></p:sld>`
const ms = (fn: () => unknown) => {
  const t0 = performance.now()
  try { fn() }
  catch (e) {
    // 擋下來可以（422），⛔ 原始例外不行
    if ((e as { statusCode?: number }).statusCode !== 422) throw e
  }
  return performance.now() - t0
}

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
  it('解壓預算算的是位元組（中文一個字 3 bytes），⛔ 不是解碼後的字數', () => {
    const buf = makeZip({ 'a.xml': '中'.repeat(1000) })
    const budget = { left: 10_000 }
    readZipEntry(buf, readZipDirectory(buf)![0]!, budget)
    expect(budget.left).toBe(10_000 - 3000)
  })
  it('解壓失敗的也要扣預算（解到一半才壞，那段工夫已經花了），並丟 422 不丟 zlib 的原始錯誤', () => {
    const buf = makeZip({ 'a.xml': '<x/>' }, 0)
    const entry = { ...readZipDirectory(buf)![0]!, method: 8 } // 不壓縮的資料當 deflate 解 → 一定壞
    const budget = { left: 10_000_000 }
    expect(() => readZipEntry(buf, entry, budget)).toThrow(expect.objectContaining({ statusCode: 422, reason: 'corrupt' }))
    expect(budget.left).toBeLessThan(10_000_000)
  })
})

describe('XML 掃描', () => {
  it('標籤名稱要整個對上：<w:p 不吃 <w:pPr、<w:t 不吃 <w:tab／<w:tbl；自閉合 <w:p/> 是空段落', () => {
    const body = '<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t>甲</w:t><w:tab/><w:t>乙</w:t></w:r></w:p><w:p/>'
      + tbl(row('品名', '價格'), row('W1', '100'))
    expect(docx(body)).toBe('甲 乙\n\n品名：W1；價格：100')
  })
  it('屬性值裡的 `>`、註解、處理指令、CDATA 都不會打亂段落', () => {
    const body = '<!-- <w:p><w:r><w:t>註解裡的不讀</w:t></w:r></w:p> --><?pi x?>'
      + '<w:p><w:pPr><w:pStyle w:val="a>b"/></w:pPr><w:r><w:t xml:space="preserve">x &gt; y</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t><![CDATA[a<b]]></w:t></w:r></w:p>'
    expect(docx(body)).toBe('x > y\na<b')
  })
  it('段落設定裡的定位點（w:tabs 底下的 w:tab）不是字；分頁符號算換行', () => {
    expect(docx('<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t><w:br w:type="page"/><w:t>C</w:t></w:r></w:p>'))
      .toBe('A B\nC')
  })

  // 2026-10-11 審查：沒收尾的標籤讓每次比對都掃到檔尾（平方時間），4KB 的檔讓請求卡 45 秒。
  // 舊版 10 萬個要跑好幾十秒到幾分鐘；現在整份只走一次，每種都應該在幾十毫秒內
  it.each([
    ['<w:t>', () => makeDocx(`<w:p><w:r>${'<w:t>'.repeat(100_000)}</w:r></w:p>`)],
    ['<mc:Fallback>', () => makeDocx(p('a') + '<mc:Fallback>'.repeat(100_000) + p('b'))],
    ['<w:tbl>', () => makeDocx(`${'<w:tbl>'.repeat(100_000)}${p('x')}`)],
    ['<w:p（沒有 >）', () => makeDocx('<w:p '.repeat(100_000))],
    ['<!--', () => makeDocx('<!--'.repeat(100_000))],
  ])('惡意 Word：10 萬個沒收尾的 %s 也在 1.5 秒內讀完', (_label, make) => {
    const buf = make()
    expect(ms(() => extractDocxText(buf))).toBeLessThan(1500)
  })
  it.each([
    ['<a:t>', () => makeZip({ 'ppt/slides/slide1.xml': `<p:sld><a:p><a:r>${'<a:t>'.repeat(100_000)}</a:r></a:p></p:sld>` })],
    ['<p:sldId', () => makeZip({ 'ppt/presentation.xml': `<p:presentation>${'<p:sldId '.repeat(100_000)}`, 'ppt/_rels/presentation.xml.rels': '<Relationships/>', 'ppt/slides/slide1.xml': slide('x') })],
    ['<Relationship', () => makeZip({ 'ppt/presentation.xml': '<p:presentation/>', 'ppt/_rels/presentation.xml.rels': `<Relationships>${'<Relationship Id="a" '.repeat(100_000)}`, 'ppt/slides/slide1.xml': slide('x') })],
  ])('惡意簡報：10 萬個沒收尾的 %s 也在 1.5 秒內讀完', (_label, make) => {
    const buf = make()
    expect(ms(() => extractPptxText(buf))).toBeLessThan(1500)
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

  it('搬移修訂：搬走前的原文（w:moveFrom）不讀，搬到的地方照讀——同一段字不出現兩次', () => {
    expect(docx('<w:p><w:moveFrom><w:r><w:t>保固一年。</w:t></w:r></w:moveFrom><w:r><w:t>人為損壞不保。</w:t></w:r><w:moveTo><w:r><w:t>保固一年。</w:t></w:r></w:moveTo></w:p>'))
      .toBe('人為損壞不保。保固一年。')
  })

  it('numId 0＝取消編號，不加清單的「・」', () => {
    expect(docx('<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr></w:pPr><w:r><w:t>不是清單</w:t></w:r></w:p>')).toBe('不是清單')
  })
})

describe('替代內容（mc:AlternateContent）：Choice 跟 Fallback 只讀一個', () => {
  it('Choice 沒有字（表情符號的字型代碼）→ 讀 Fallback 裡的字，⛔ 不可以整個不見', () => {
    // Word 存表情符號的寫法：Choice 只放 w16se:symEx（字型＋代碼），字本身只在 Fallback
    const emoji = (ch: string, code: string) => `<w:r><mc:AlternateContent><mc:Choice Requires="w16se"><w16se:symEx w16se:font="Segoe UI Emoji" w16se:char="${code}"/></mc:Choice><mc:Fallback><w:t>${ch}</w:t></mc:Fallback></mc:AlternateContent></w:r>`
    const c = (inner: string) => tc(`<w:p>${inner}</w:p>`)
    const run = (s: string) => `<w:r><w:t>${s}</w:t></w:r>`
    const body = tbl(tr(c(run('功能')), c(run('W1')), c(run('W2'))), tr(c(run('防水')), c(emoji('✅', '2705')), c(emoji('❌', '274C'))))
      + `<w:p>${emoji('✅', '2705')}${run(' 滿千免運')}</w:p>`
    expect(docx(body)).toBe('功能：防水；W1：✅；W2：❌\n\n✅ 滿千免運')
  })

  it('自閉合的 <mc:Fallback/> 不會把後面的段落一起吃掉', () => {
    const body = '<w:p><w:r><mc:AlternateContent><mc:Choice Requires="w14"><w:t>甲</w:t></mc:Choice><mc:Fallback/></mc:AlternateContent></w:r></w:p>'
      + p('中間這段很重要') + p('第二段也很重要')
      + '<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:t>乙</w:t></mc:Choice><mc:Fallback><w:t>乙</w:t></mc:Fallback></mc:AlternateContent></w:r></w:p>'
    expect(docx(body)).toBe('甲\n中間這段很重要\n第二段也很重要\n乙')
  })

  it('Fallback 裡又有替代內容：選上的那一個整塊讀、沒選上的整塊不讀，不留碎片', () => {
    const inner = '<mc:AlternateContent><mc:Choice Requires="wps"><w:t>內新版</w:t></mc:Choice><mc:Fallback><w:t>內舊版</w:t></mc:Fallback></mc:AlternateContent>'
    const outer = (choice: string) => `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wpg">${choice}</mc:Choice><mc:Fallback><w:r>${inner}</w:r><w:r><w:t>外舊版</w:t></w:r></mc:Fallback></mc:AlternateContent></w:r></w:p>`
    expect(docx(outer('<w:t>外新版</w:t>'))).toBe('外新版')
    // 外層 Choice 沒有字 → 讀外層 Fallback；裡面那一塊照樣只讀它的 Choice
    expect(docx(outer('<w:drawing/>'))).toBe('內新版外舊版')
  })
})

describe('Word 表格：合併儲存格、修訂紀錄、放在文字方塊裡', () => {
  it('欄位名稱橫跨兩欄（價格＝會員價＋原價）→ 兩個值都標「價格」，接在同一個欄位下', () => {
    // ⛔ 以前一格合併的欄位名稱就讓整張表失去「欄位：值」，變成「品名｜價格 / W1｜12,900｜9,900」
    const body = tbl(
      tr(tc(p('品名')), tc(p('價格'), '<w:gridSpan w:val="2"/>')),
      tr(tc(p('W1')), tc(p('12,900')), tc(p('9,900'))),
      tr(tc(p('W2')), tc(p('15,900')), tc('<w:p/>')),
    )
    expect(docx(body)).toBe('品名：W1；價格：12,900／9,900\n品名：W2；價格：15,900')
  })

  it('第一列是橫跨整張表的表名 → 表名自己一行，欄位名稱看下一列', () => {
    const body = tbl(
      tr(tc(p('2026 秋季價目表'), '<w:gridSpan w:val="3"/>')),
      tr(tc(p('品名')), tc(p('容量')), tc(p('價格'))),
      tr(tc(p('W1')), tc(p('12L')), tc(p('12,900'))),
    )
    expect(docx(body)).toBe('2026 秋季價目表\n品名：W1；容量：12L；價格：12,900')
  })

  it('這一列前面空了一欄（gridBefore）→ 值要往右讓一欄，⛔ 不可以把 12L 標成「品名」', () => {
    const body = tbl(
      tr(tc(p('品名')), tc(p('容量')), tc(p('價格'))),
      `<w:tr><w:trPr><w:gridBefore w:val="1"/></w:trPr>${tc(p('12L'))}${tc(p('12,900'))}</w:tr>`,
    )
    expect(docx(body)).toBe('容量：12L；價格：12,900')
  })

  it('修訂紀錄裡「改之前」的直向合併（tcPrChange）不算數，W2 的容量是自己的 20L', () => {
    const body = tbl(
      tr(tc(p('品名')), tc(p('容量')), tc(p('價格'))),
      tr(tc(p('W1')), tc(p('12L')), tc(p('12,900'))),
      tr(tc(p('W2')), tc(p('20L'), '<w:tcPrChange w:id="1" w:author="a"><w:tcPr><w:vMerge/></w:tcPr></w:tcPrChange>'), tc(p('19,900'))),
    )
    expect(docx(body)).toBe('品名：W1；容量：12L；價格：12,900\n品名：W2；容量：20L；價格：19,900')
  })

  it('只有直向合併帶下來、自己每格都空的一列 → 不另寫一行（不重複「品名：W1」）', () => {
    const body = tbl(
      tr(tc(p('品名')), tc(p('容量')), tc(p('價格'))),
      tr(tc(p('W1'), '<w:vMerge w:val="restart"/>'), tc(p('12L')), tc(p('12,900'))),
      tr(tc('<w:p/>', '<w:vMerge/>'), tc('<w:p/>'), tc('<w:p/>')),
    )
    expect(docx(body)).toBe('品名：W1；容量：12L；價格：12,900')
  })

  it('文字方塊裡有表格：外面那段、方塊裡表格前後的段落一個字都不少', () => {
    const inner = p('盒內第一段') + tbl(row('品名', '價格'), row('W1', '100')) + p('盒內最後')
    const body = p('上一段') + `<w:p><w:r><w:t>宿主段落文字</w:t></w:r>${textBox(inner)}</w:p>` + p('下一段')
    expect(docx(body)).toBe('上一段\n宿主段落文字\n盒內第一段\n\n品名：W1；價格：100\n\n盒內最後\n下一段')
  })

  it('表格直接夾在段落裡（不合規格的檔）→ 段落的字照讀，表格排在那一段後面', () => {
    expect(docx(`<w:p><w:r><w:t>前</w:t></w:r>${tbl(row('a', 'b'), row('1', '2'))}<w:r><w:t>後</w:t></w:r></w:p>`)).toBe('前後\n\na：1；b：2')
  })

  it('格子被內容控制項（w:sdt）包起來也照欄位排', () => {
    const body = tbl(tr(tc(p('品名')), tc(p('容量')), tc(p('價格'))), `<w:tr><w:sdt><w:sdtContent>${tc(p('W1'))}</w:sdtContent></w:sdt>${tc(p('12L'))}${tc(p('12,900'))}</w:tr>`)
    expect(docx(body)).toBe('品名：W1；容量：12L；價格：12,900')
  })
})

describe('太深、太大、故意做壞的檔：讀得出來或講原因，⛔ 不丟原始例外、不卡住', () => {
  const nest = (levels: number, wrap: (inner: string, k: number) => string) => {
    let x = p('最裡面')
    for (let k = 0; k < levels; k++) x = wrap(x, k)
    return x
  }

  it('表格套 3000 層（0.5KB 的檔）→ 不會 call stack 爆掉，最裡面的字照讀', () => {
    const body = nest(3000, x => `<w:tbl><w:tr><w:tc>${x}</w:tc></w:tr></w:tbl>`)
    let text = ''
    expect(ms(() => { text = docx(body) })).toBeLessThan(1500)
    expect(text).toBe('最裡面')
  })

  it('套超過 20 層之後不再分欄位，但每一層的字都還在', () => {
    const text = docx(nest(25, (x, k) => tbl(tr(tc(p(`第${k}層`)), tc(x)))))
    for (let k = 0; k < 25; k++) expect(text).toContain(`第${k}層`)
    expect(text).toContain('最裡面')
  })

  it('一格 20 萬字往下合併 2 萬列（字數放大）→ 很快停下並標 textTruncated，⛔ 不可以把記憶體吃光', () => {
    const big = '長'.repeat(200_000)
    const body = '<w:tbl>'
      + tr(tc(p('品名')), tc(p('說明')))
      + tr(tc(p(big), '<w:vMerge w:val="restart"/>'), tc(p('v')))
      + tr(tc('<w:p/>', '<w:vMerge/>'), tc(p('v'))).repeat(20_000)
      + '</w:tbl>'
    let meta: Record<string, unknown> = {}
    expect(ms(() => { meta = extractDocxText(makeDocx(body)).meta })).toBeLessThan(1500)
    expect(meta.textTruncated).toBe(1)
  })

  it('document.xml 宣稱 100 bytes、實際解開超過 32MB → 422 講內容大到不正常（擋的是實際解出來的量）', () => {
    const buf = makeDocx(p('A'.repeat(33 * 1024 * 1024)), { declaredSize: 100 })
    expect(() => extractDocxText(buf)).toThrow(/內容大到不正常/)
  })

  it('壞掉的檔（截斷、亂改位元組、檔尾歸零、亂碼）一律讀得出來或丟 422', () => {
    const good = makeDocx(p('標題') + tbl(row('品名', '價格'), row('W1', '100')) + `<w:p>${textBox(p('方塊'))}</w:p>`)
    let seed = 7
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF; return seed % n }
    const variants: Buffer[] = []
    for (let k = 0; k < 60; k++) {
      variants.push(good.subarray(0, rnd(good.length)))
      const flipped = Buffer.from(good)
      for (let j = 0; j < 20; j++) flipped[rnd(flipped.length)] = rnd(256)
      variants.push(flipped)
      variants.push(Buffer.from(Array.from({ length: 2000 }, () => rnd(256))))
      // 解壓後的 XML 亂改再壓回去，才打得到 XML 解析（只改壓縮後的多半在解壓那關就擋下）
      const xml = Buffer.from(W(p('標題') + tbl(row('品名', '價格'), row('W1', '100')) + `<w:p>${textBox(p('方塊'))}</w:p>`))
      for (let j = 0; j < 20; j++) xml[rnd(xml.length)] = '<>/"=&;! wtpbl:'.charCodeAt(rnd(15))
      variants.push(makeZip({ 'word/document.xml': xml.subarray(0, xml.length - rnd(xml.length)) }))
    }
    const zeroTail = Buffer.from(good)
    zeroTail.fill(0, good.length - 200)
    variants.push(zeroTail)
    for (const v of variants) expect(ms(() => extractDocxText(v))).toBeLessThan(1000)
  })
})

describe('extractPptxText', () => {
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

  it('PowerPoint 的換行 <a:br><a:rPr/></a:br>（不是自閉合）也算換行，字不黏在一起', () => {
    const buf = makeZip({ 'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>中杯 NT$85</a:t></a:r><a:br><a:rPr lang="zh-TW"/></a:br><a:r><a:t>大杯 NT$100</a:t></a:r></a:p></p:sld>' })
    expect(extractPptxText(buf).text).toBe('## 第 1 張投影片\n中杯 NT$85\n大杯 NT$100')
  })

  it('替代內容只讀一份（Choice 有字讀 Choice，沒字讀 Fallback）', () => {
    const ac = (choice: string, fallback: string) => `<mc:AlternateContent><mc:Choice Requires="p14">${choice}</mc:Choice><mc:Fallback>${fallback}</mc:Fallback></mc:AlternateContent>`
    const sp = (t: string) => `<p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`
    const buf = makeZip({ 'ppt/slides/slide1.xml': `<p:sld><p:spTree>${ac(sp('新版'), sp('新版'))}${ac('<p:pic/>', sp('舊版才有'))}</p:spTree></p:sld>` })
    expect(extractPptxText(buf).text).toBe('## 第 1 張投影片\n新版\n舊版才有')
  })

  // 2026-10-11 審查實測：150 張「宣稱 100 bytes、實際 60MB」的投影片，以前每張解到上限才丟掉，合計解壓 9GB
  describe('壓縮炸彈', () => {
    const bomb = `<p:sld><a:p><a:r><a:t>${'A'.repeat(33 * 1024 * 1024)}</a:t></a:r></a:p></p:sld>`

    it('一張正常＋150 張炸彈 → 很快停下：正常那張照讀，其他算讀不出來', () => {
      const files: Record<string, string> = { 'ppt/slides/slide1.xml': slide('W1 REGEN 改 保固一年') }
      for (let k = 2; k <= 151; k++) files[`ppt/slides/slide${k}.xml`] = bomb
      const buf = makeZip(files, 8, { declaredSize: 100 })
      let r: { text: string, meta: Record<string, string | number> } | undefined
      expect(ms(() => { r = extractPptxText(buf) })).toBeLessThan(3000)
      expect(r!.text).toBe('## 第 1 張投影片\nW1 REGEN 改 保固一年')
      expect(r!.meta).toMatchObject({ slides: 151, slidesWithText: 1, slidesUnreadable: 150 })
    })

    it('全部都是炸彈 → 422 講內容大到不正常（⛔ 不回空字串讓呼叫端以為是圖片）', () => {
      const buf = makeZip({ 'ppt/slides/slide1.xml': bomb, 'ppt/slides/slide2.xml': bomb }, 8, { declaredSize: 100 })
      expect(() => extractPptxText(buf)).toThrow(/投影片內容大到不正常/)
    })
  })

  it('壞掉的簡報（截斷、亂改位元組、亂碼、XML 亂掉）一律讀得出來或丟 422', () => {
    const files = {
      'ppt/presentation.xml': '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>',
      'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/></Relationships>',
      'ppt/slides/slide1.xml': slide('封面', 'W1 REGEN 改'),
    }
    const good = makeZip(files)
    let seed = 11
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF; return seed % n }
    for (let k = 0; k < 60; k++) {
      const flipped = Buffer.from(good)
      for (let j = 0; j < 20; j++) flipped[rnd(flipped.length)] = rnd(256)
      const broken = Object.fromEntries(Object.entries(files).map(([name, xml]) => {
        const b = Buffer.from(xml)
        for (let j = 0; j < 8; j++) b[rnd(b.length)] = '<>/"=! apt:'.charCodeAt(rnd(11))
        return [name, b.subarray(0, b.length - rnd(b.length))]
      }))
      for (const v of [good.subarray(0, rnd(good.length)), flipped, makeZip(broken)]) expect(ms(() => extractPptxText(v))).toBeLessThan(1000)
    }
  })
})

describe('tableRowsToText', () => {
  it('第一列有空格（不像欄位名稱）→ 不硬猜，每列用「｜」接', () => {
    expect(tableRowsToText([['2026 秋季價目表', ''], ['W1', '12,900']])).toBe('2026 秋季價目表\nW1｜12,900')
  })
  it('同一個欄位名稱連著兩欄 → 值用「／」接在同一個欄位下，不寫兩次「價格」', () => {
    expect(tableRowsToText([['品名', '價格', '價格'], ['W1', '12,900', '9,900']])).toBe('品名：W1；價格：12,900／9,900')
  })
})

describe('decodeTextBuffer', () => {
  const big5 = (hex: string) => Buffer.from(hex, 'hex')
  // 下面的 Big5 bytes 都是 python `str.encode('big5')` 產生的
  const BIG5_HEADER = 'b0d3ab7ebd73b8b92cab7ea6572cb0e2bbf92cae77a6730a' // 「商品編號,品名,售價,庫存↵」

  it('Big5（台灣購物平台常見的 CSV）→ 自動認出來，不變亂碼', () => {
    // 「品名,價格\n電話,0912345678」的 Big5 bytes（iconv 產生）
    expect(decodeTextBuffer(big5('ab7ea6572cbbf9aee60ab971b8dc2c30393132333435363738'))).toEqual({ text: '品名,價格\n電話,0912345678', encoding: 'big5', unreadableChars: 0 })
  })

  it('同一個 buffer 只解一次（建整理工作與讀表各要一次，10MB 的檔別整份解好幾遍）；不同 buffer 各自解', () => {
    const buf = big5('ab7ea6572cbbf9aee60ab971b8dc2c30393132333435363738')
    const first = decodeTextBuffer(buf)
    expect(decodeTextBuffer(buf)).toBe(first)
    const copy = Buffer.from(buf)
    expect(decodeTextBuffer(copy)).not.toBe(first)
    expect(decodeTextBuffer(copy)).toEqual(first)
  })

  it('Big5：中文表頭＋1000 列英數 → 還是 Big5（⛔ 以前會被當成 UTF-8，「品名」讀成亂碼還不警告）', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => `A${String(i).padStart(5, '0')},Espresso Blend ${i},${100 + i},${i % 50}\n`).join('')
    const r = decodeTextBuffer(Buffer.concat([big5(BIG5_HEADER), Buffer.from(rows)]))
    expect(r.encoding).toBe('big5')
    expect(r.text.startsWith('商品編號,品名,售價,庫存\nA00000,Espresso Blend 0')).toBe(true)
    expect(r.unreadableChars).toBe(0)
  })

  it('Big5：只有一個中文字的欄位（是／否／大／小／無）也認得出來', () => {
    // 這幾個字的第二個位元組是英文字母，UTF-8 讀起來只壞一個——⛔ 不能靠「壞的字夠少就算 UTF-8」
    for (const [ch, hex] of [['是', 'ac4f'], ['否', 'a75f'], ['大', 'a46a'], ['小', 'a470'], ['無', 'b54c']] as const) {
      const r = decodeTextBuffer(Buffer.concat([Buffer.from('id,name,stock\n1,W1,'), big5(hex), Buffer.from('\n')]))
      expect(r).toEqual({ text: `id,name,stock\n1,W1,${ch}\n`, encoding: 'big5', unreadableChars: 0 })
    }
  })

  it('⛔ 大部分是 UTF-8、只有一個壞位元組 → 還是 UTF-8（不可以整份改用 Big5 讀成亂碼）', () => {
    const mostly = Buffer.concat([Buffer.from('品名,價格\n耶加雪菲,450\n', 'utf8'), Buffer.from([0xFF]), Buffer.from('曼特寧,420\n', 'utf8')])
    const r = decodeTextBuffer(mostly)
    expect(r.encoding).toBe('utf-8')
    expect(r.text).toContain('耶加雪菲')
    expect(r.text).toContain('曼特寧')
    expect(r.unreadableChars).toBe(1)
  })

  it('7 千字的 UTF-8 裡有 8 個壞位元組 → 還是 UTF-8，講得出有 8 個字讀不出來', () => {
    const text = `品名,價格,說明\n${Array.from({ length: 300 }, (_, i) => `W${i},${1000 + i},這是第${i}項商品的說明文字\n`).join('')}`
    const b = Buffer.from(text, 'utf8')
    for (let k = 1; k <= 8; k++) b[b.indexOf(',', Math.floor(b.length * k / 9))] = 0xFF // 把 8 個逗號換成壞位元組
    const r = decodeTextBuffer(b)
    expect(r.encoding).toBe('utf-8')
    expect(r.unreadableChars).toBe(8)
    expect(r.text).toContain('這是第299項商品的說明文字')
  })

  it('西歐（cp1252 彎引號）、俄文（cp1251）編碼 → 不丟錯，英數照讀，講得出有字讀不出來', () => {
    const cp1252 = decodeTextBuffer(Buffer.from('48652073616964209368656c6c6f94', 'hex')) // He said “hello”
    expect(cp1252.text).toBe('He said �hello�')
    expect(cp1252.unreadableChars).toBeGreaterThan(0)
    for (const hex of ['cde0e1ee', 'cde0e1eef020f6e5edfb2c31323020f0f3e12e']) { // Набо／Набор цены,120 руб.
      const r = decodeTextBuffer(Buffer.from(hex, 'hex'))
      expect(r.unreadableChars).toBeGreaterThan(0)
      if (hex.length > 8) expect(r.text).toContain(',120 ')
    }
  })

  it('UTF-8（有沒有 BOM 都行）與 UTF-16 都讀得出來', () => {
    expect(decodeTextBuffer(Buffer.from('﻿保固一年', 'utf8'))).toEqual({ text: '保固一年', encoding: 'utf-8', unreadableChars: 0 })
    expect(decodeTextBuffer(Buffer.from('保固一年', 'utf8')).encoding).toBe('utf-8')
    expect(decodeTextBuffer(Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('保固', 'utf16le')]))).toEqual({ text: '保固', encoding: 'utf-16le', unreadableChars: 0 })
  })

  it('亂碼位元組不丟錯（文字檔沒有「讀不出來」這種失敗，只有幾個字讀不出來）', () => {
    let seed = 3
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF; return seed % n }
    for (let k = 0; k < 50; k++) {
      const r = decodeTextBuffer(Buffer.from(Array.from({ length: 1 + rnd(3000) }, () => rnd(256))))
      expect(r.unreadableChars).toBeGreaterThanOrEqual(0)
    }
  })
})
