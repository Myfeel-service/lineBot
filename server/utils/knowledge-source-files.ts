/**
 * 知識庫的原檔留著（`C-296`③，`D-120` 第 1 步）。
 *
 * 以前檔案讀完就刪（`bulk-create` 寫 `filePath: ''`）：資料頁點不開、看不到原文，
 * 說明書改版也沒辦法跟舊版對照。原文模式（`C-298`）要從原檔重切，這一步是它的地基。
 *
 * 流程：
 *  ① 上傳 → `preview-uploads/{ws}/…`（瀏覽器直傳，讀完就刪，跟以前一樣）
 *  ② 建整理工作時另存一份到 `preview-jobs/{ws}/{jobId}/source.{ext}`（工作沒人收就跟著工作過期被清掉）
 *  ③ 真的匯入時 **複製**到 `knowledge-files/{ws}/{sourceId}/original.{ext}`——這才是長期留著的那一份
 *  ④ 刪資料（含回收桶到期清運）時連同這個資料夾一起刪
 *
 * ⛔ 路徑一律由伺服器組，不收前端給的路徑：收了就等於讓人讀別家的檔案。
 * ⛔ 下載一律發短效簽名網址，不把檔案公開；網址只活 5 分鐘。
 */
import { getStorage } from './firebase'
// ⛔ 這支只准依賴 Storage：ai-knowledge-sources（刪資料）要 import 它，
//    若這裡反過來 import ai-preview-jobs（它又 import ai-knowledge-sources）就成了循環。
//    整理工作的原檔由呼叫端讀好、把 bytes 傳進來。

export const KNOWLEDGE_FILES_PREFIX = 'knowledge-files'

export function sourceFilePrefix(workspaceId: string, sourceId: string): string {
  return `${KNOWLEDGE_FILES_PREFIX}/${workspaceId}/${sourceId}/`
}

export interface KeptOriginalFile {
  filePath: string
  fileName: string
  fileSize: number
  fileContentType: string
}

/**
 * 把整理工作留著的原檔複製成這份資料的原檔。舊的（「更新這一份」時）先清掉——
 * 副檔名可能不同（舊的是 PDF、新的是 Word），不清的話會留下一份沒人指得到的孤兒檔。
 * 失敗回 null，⛔ 不擋匯入：卡片才是這一步的主角，原檔只是讓資料頁多一顆「下載原檔」。
 */
export async function keepOriginalFile(opts: {
  workspaceId: string
  sourceId: string
  /** 讀原檔 bytes（呼叫端從整理工作那份讀）；丟錯＝留存失敗，不擋匯入 */
  readBytes: () => Promise<Buffer>
  ext: string
  fileName: string
  contentType: string
}): Promise<KeptOriginalFile | null> {
  const ext = (opts.ext.match(/^[a-z0-9]+$/i)?.[0] ?? 'bin').toLowerCase()
  const dest = `${sourceFilePrefix(opts.workspaceId, opts.sourceId)}original.${ext}`
  try {
    const buf = await opts.readBytes()
    await deleteSourceFiles(opts.workspaceId, opts.sourceId)
    await getStorage().bucket().file(dest).save(buf, { contentType: opts.contentType || 'application/octet-stream' })
    return { filePath: dest, fileName: opts.fileName, fileSize: buf.length, fileContentType: opts.contentType }
  }
  catch (e) {
    console.warn(`[knowledge-files] 原檔留存失敗（不擋匯入）${opts.sourceId}:`, (e as Error)?.message)
    return null
  }
}

/** 刪掉某份資料留著的原檔（整個資料夾）。失敗只記錄、不擋刪除本身。 */
export async function deleteSourceFiles(workspaceId: string, sourceId: string): Promise<void> {
  await getStorage().bucket()
    .deleteFiles({ prefix: sourceFilePrefix(workspaceId, sourceId) })
    .catch((e) => { console.warn(`[knowledge-files] 刪原檔失敗 ${sourceId}:`, (e as Error)?.message) })
}

/**
 * 下載原檔的短效網址。檔名用原本的（中文檔名要照 RFC 5987 編碼，不然瀏覽器存成亂碼）。
 * filePath 必須在這份資料自己的資料夾底下——⛔ 不信任資料庫以外的任何路徑。
 */
export async function signedOriginalFileUrl(
  workspaceId: string,
  sourceId: string,
  filePath: string,
  fileName: string,
): Promise<string> {
  if (!filePath.startsWith(sourceFilePrefix(workspaceId, sourceId)) || filePath.includes('..')) {
    throw createError({ statusCode: 404, statusMessage: '找不到這份資料的原檔' })
  }
  const safeAscii = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '')
  const [url] = await getStorage().bucket().file(filePath).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + 5 * 60 * 1000,
    responseDisposition: `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  })
  return url
}
