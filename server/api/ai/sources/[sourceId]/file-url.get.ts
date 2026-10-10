import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { getSource } from '~~/server/utils/ai-knowledge-sources'
import { signedOriginalFileUrl } from '~~/server/utils/knowledge-source-files'

/**
 * GET /api/ai/sources/:sourceId/file-url
 * 這份資料留著的原檔，回一個 5 分鐘內有效的下載網址（`C-296`③）。
 *
 * 權限跟「看資料」同一級（ai.read）：看得到這份資料整理出來的每一條，原檔本來就不是秘密。
 * ⛔ 別家的資料一律 404（getSource 驗工作區），不說「沒有權限」——不洩漏那份資料存在。
 * 2026-10-10 以前匯入的檔案沒有原檔（當時讀完就刪），也回 404 並講原因。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'ai.read')
  const sourceId = String(getRouterParam(event, 'sourceId') ?? '').trim()
  if (!sourceId) throw createError({ statusCode: 400, statusMessage: 'sourceId required' })

  const source = await getSource(getDb(), sourceId, workspaceId)
  if (!source) throw createError({ statusCode: 404, statusMessage: '找不到這份資料' })
  const filePath = String(source.data.filePath ?? '')
  if (!filePath) {
    throw createError({ statusCode: 404, statusMessage: '這份資料沒有留原檔（2026 年 10 月以前上傳的檔案，當時讀完就沒有保存）' })
  }
  const fileName = String(source.data.fileName || source.data.name || 'original')
  return { url: await signedOriginalFileUrl(workspaceId, sourceId, filePath, fileName), fileName }
})
