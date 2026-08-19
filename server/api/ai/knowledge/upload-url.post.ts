import { v4 as uuidv4 } from 'uuid'
import { getStorage } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'

/** 允許直傳的知識庫檔案副檔名（與 preview-jobs 的 file 分支一致：PDF / Excel）。 */
const ALLOWED_EXT = new Set(['pdf', 'xlsx', 'xls'])

/**
 * POST /api/ai/knowledge/upload-url
 *
 * 發一個 GCS v4 signed PUT URL，讓瀏覽器把原檔「直接」上傳到 Storage：
 * - 繞過 AWS Lambda 同步請求 6MB payload 上限（aws-amplify preset → Nitro 跑在 Lambda）；
 * - 不用 base64（省 ~33% 體積、也不必把整顆檔塞進 JSON body）。
 *
 * 前端 PUT 完，再帶著回傳的 storagePath 去建 preview job（body 只剩幾十 bytes）。
 * 回 { uploadId, storagePath, uploadUrl }。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')
  const body = await readBody(event)
  const fileName = String(body?.fileName ?? '').trim()
  const contentType = String(body?.contentType ?? '').trim().toLowerCase()
  if (!fileName) throw createError({ statusCode: 400, statusMessage: '請提供 fileName' })

  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  const looksPdf = ext === 'pdf' || contentType.includes('pdf')
  const looksXlsx = ext === 'xlsx' || ext === 'xls'
    || contentType.includes('spreadsheet') || contentType.includes('excel')
  if (!ALLOWED_EXT.has(ext) && !looksPdf && !looksXlsx) {
    throw createError({ statusCode: 400, statusMessage: `不支援的檔案類型：${ext || contentType || '未知'}` })
  }

  const uploadId = uuidv4()
  const safeExt = ALLOWED_EXT.has(ext) ? ext : (looksPdf ? 'pdf' : 'xlsx')
  // 固定在本 workspace 的 preview-uploads/ 底下；preview-jobs 下載時會用這個前綴做隔離檢查。
  const storagePath = `preview-uploads/${workspaceId}/${uploadId}.${safeExt}`

  // 不把 Content-Type 納入簽章 → 前端 PUT 的 header 不必逐字對齊，少一種 403 SignatureDoesNotMatch。
  // 下載端只認 bytes，檔案型別由 preview-jobs 收到的 fileName/contentType 另行判定。
  // ⛔大小上限納入簽章（C-49A）：不設的話拿到網址就能 PUT 2GB——GCS 照收（付儲存費），
  // 之後 preview-jobs 把整包下載進 Lambda 直接 OOM，而且炸掉後那顆檔案永遠留在 bucket。
  const [uploadUrl] = await getStorage().bucket()
    .file(storagePath)
    .getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + 10 * 60 * 1000, // 10 分鐘內要 PUT 完
      extensionHeaders: { 'x-goog-content-length-range': '0,10485760' }, // 10MB，與 preview-jobs 檢查一致
    })

  return { uploadId, storagePath, uploadUrl }
})
