/**
 * 知識庫收哪些檔案（`C-296`，`D-120` 第 1 步）——前端選檔／拖放、簽名上傳網址、建整理工作三處共用這一份。
 *
 * ⛔ 三處各寫一份清單的下場：畫面說收、伺服器說不支援（或反過來），而且錯誤只在撞到時才出現。
 * 收不了的檔案一律回「怎麼辦」，不是只說不支援——舊版 .doc、蘋果 Pages 這種，
 * 店家多半不知道差在哪，只說「不支援」等於叫他自己去查。
 */

export type KnowledgeFileKind = 'pdf' | 'xlsx' | 'csv' | 'docx' | 'pptx' | 'text' | 'image'

export const KNOWLEDGE_FILE_KIND_BY_EXT: Record<string, KnowledgeFileKind> = {
  pdf: 'pdf',
  xlsx: 'xlsx',
  xls: 'xlsx',
  csv: 'csv',
  docx: 'docx',
  pptx: 'pptx',
  txt: 'text',
  md: 'text',
  markdown: 'text',
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  webp: 'image',
  heic: 'image',
  heif: 'image',
}

/**
 * 存原檔時用的型別（`C-296`③）。瀏覽器給的 `file.type` 常常是空的（.md、.heic、部分 Windows 的 .csv），
 * 空著存進去，之後「下載原檔」會變成一個瀏覽器不知道怎麼開的檔案。
 */
export const KNOWLEDGE_FILE_MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
}

/** `<input type="file" accept>` 用（副檔名就夠；手機選照片時 HEIC 也要在清單裡） */
export const KNOWLEDGE_FILE_ACCEPT = Object.keys(KNOWLEDGE_FILE_KIND_BY_EXT).map(e => `.${e}`).join(',')

/** 畫面上講「收什麼」的那一句 */
export const KNOWLEDGE_FILE_LABEL = 'PDF、Word、PPT、Excel、CSV、文字檔、照片'

/** 單檔上限（瀏覽器、簽名網址、建工作三道關同一個數字） */
export const KNOWLEDGE_FILE_MAX_BYTES = 10 * 1024 * 1024

export function fileExtension(name: string): string {
  const m = String(name ?? '').toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1]! : ''
}

export function knowledgeFileKind(name: string): KnowledgeFileKind | null {
  return KNOWLEDGE_FILE_KIND_BY_EXT[fileExtension(name)] ?? null
}

/** 每種檔案在畫面上叫什麼（偵測結果那一行） */
export const KNOWLEDGE_FILE_KIND_LABEL: Record<KnowledgeFileKind, string> = {
  pdf: 'PDF',
  xlsx: 'Excel 表格',
  csv: 'CSV 表格',
  docx: 'Word 文件',
  pptx: '簡報',
  text: '文字檔',
  image: '照片',
}

/** 收不了的檔案 → 當場講怎麼辦 */
export function unsupportedFileHint(name: string): string {
  const ext = fileExtension(name)
  switch (ext) {
    case 'doc':
      return '這是舊版 Word 檔（.doc），請用 Word 打開後「另存新檔」成 .docx 再上傳'
    case 'ppt':
      return '這是舊版 PowerPoint 檔（.ppt），請用 PowerPoint 打開後另存成 .pptx 再上傳'
    case 'pages':
    case 'key':
      return '這是蘋果的 Pages／Keynote 檔，請先用「輸出」存成 PDF 再上傳'
    case 'numbers':
      return '這是蘋果的 Numbers 檔，請先用「輸出」存成 Excel 或 CSV 再上傳'
    case 'rtf':
    case 'odt':
    case 'odp':
    case 'ods':
      return `「.${ext}」這種檔案目前不收，請另存成 Word（.docx）、Excel（.xlsx）或 PDF 再上傳`
    case 'zip':
    case 'rar':
    case '7z':
      return '壓縮檔請先解壓縮，把裡面的檔案直接拖進來（一次可以好幾份）'
    case 'mp3':
    case 'm4a':
    case 'wav':
    case 'aac':
    case 'mp4':
    case 'mov':
      return '錄音和影片目前還不收；有逐字稿的話，可以直接把文字貼進來'
    case 'gif':
    case 'bmp':
    case 'tif':
    case 'tiff':
      return `「.${ext}」圖片請另存成 JPG 或 PNG 再上傳`
    default:
      return `${ext ? `「.${ext}」這種檔案` : '這種檔案'}目前不收；收得了：${KNOWLEDGE_FILE_LABEL}`
  }
}
