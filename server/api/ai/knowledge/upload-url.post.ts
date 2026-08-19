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

  /**
   * ⛔簽章裡**不要**放任何 extensionHeaders（含 x-goog-content-length-range）。
   * 2026-08-19 踩過：為了擋超大上傳把 content-length-range 加進 extensionHeaders，
   * 但 signer 會把每個 extensionHeader 併入 X-Goog-SignedHeaders 與 canonical request，
   * 而瀏覽器 PUT 只送 Content-Type → 簽章對不上 → **所有檔案上傳一律 403**。
   * 要靠它擋大小的話，前端每次 PUT 都得逐字送同一個 header，多一種必炸的耦合。
   *
   * 大小防線改放伺服器端兩道（都在我們自己手上，不依賴 client 行為）：
   *   ① preview-jobs 下載前先 file.getMetadata() 檢查 size，超過就刪檔並回 400（不進記憶體）
   *   ② cleanupExpiredPreviewJobs 每輪清 preview-uploads/ 超過 24h 的孤兒檔
   * 代價：超大檔會先落地 GCS 幾秒到幾小時的儲存費——比「上傳整個壞掉」便宜太多。
   */
  const [uploadUrl] = await getStorage().bucket()
    .file(storagePath)
    .getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + 10 * 60 * 1000, // 10 分鐘內要 PUT 完
    })

  return { uploadId, storagePath, uploadUrl }
})
