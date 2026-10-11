import { deflateRawSync } from 'node:zlib'

export interface MakeZipOptions {
  /**
   * 目錄裡寫的「解壓後大小」（不給就照實際大小）。測壓縮炸彈用：宣稱 100 bytes、實際解開 33MB——
   * 讀取端 ⛔ 不可以相信這個數字。
   */
  declaredSize?: number
}

/**
 * 測試用的最小 zip 產生器：真的 Word（.docx）／PowerPoint（.pptx）檔就是這種結構。
 * method 8 = deflate（Office 預設）、0 = 不壓縮；讀取端兩種都要讀得到。
 * 內容一樣的檔只壓一次（150 張一樣大的炸彈投影片不用壓 150 次）。
 * ⛔ 只給測試用，不要拿去產出要給人下載的檔案（沒有 CRC，Office 打不開）。
 */
export function makeZip(files: Record<string, string | Buffer>, method: 0 | 8 = 8, opts: MakeZipOptions = {}): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  const compressed = new Map<string | Buffer, Buffer>()
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const raw = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
    let data = method === 8 ? compressed.get(content) : raw
    if (!data) {
      data = deflateRawSync(raw)
      compressed.set(content, data)
    }
    const size = opts.declaredSize ?? raw.length
    const nameBuf = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034B50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014B50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, data)
    centrals.push(central, nameBuf)
    offset += local.length + nameBuf.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054B50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

/** 一份最小的 Word 檔：body 是 <w:body> 裡面那一段 XML */
export function makeDocx(body: string, opts?: MakeZipOptions): Buffer {
  return makeZip({
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="x"><w:body>${body}<w:sectPr/></w:body></w:document>`,
  }, 8, opts)
}
