import { v4 as uuidv4 } from 'uuid'
import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import {
  addWorkspaceProductName,
  createKnowledgeChunk,
  normalizeChunkInput,
  validateChunkInput,
} from '~~/server/utils/ai-knowledge-chunks'
import { KNOWLEDGE_SOURCES_COLLECTION } from '~~/server/utils/ai-knowledge-sources'

/**
 * POST /api/ai/knowledge/create
 * Body: { title, content, tags[], questions[], sourceId?, productName? }
 *
 * 行為：
 *   - 若 body.sourceId 有值：把這張卡掛到該既有 source 底下（用於「在某 source 內手動補一張」）
 *   - 若 body.sourceId 空：**自動建立 type='manual' 的新 source**，名稱用 title。
 *     這樣手寫單張條目也是「一個 source = 一張卡」，跟 PDF / URL 統一在來源層管理。
 *
 * productName 只在「自動建 source」那條路吃：產品名是來源層欄位（索引時繼承），
 * 掛進既有 source 的卡跟著那個 source 走，不該被單張卡覆蓋。
 * 沒有它的話，手寫的「濾網怎麼洗」不屬於任何產品，客人指名問**另一台**時照樣可能被拿去回答。
 *
 * 同步建立並索引：回傳時 status 已是 indexed（成功）或 failed（embed 出錯）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')
  const rawBody = await readBody(event)
  const input = normalizeChunkInput(rawBody)
  const err = validateChunkInput(input)
  if (err) throw createError({ statusCode: 400, statusMessage: err })

  const db = getDb()

  // 若沒指定 sourceId → 自動建一個 type='manual' 的 source
  let sourceId = input.sourceId
  /**
   * 掛進既有 source 的卡**一律忽略** productName：產品名是來源層欄位，
   * 這張卡的產品跟著它所屬那份資料走。收下來卻只寫進全域產品清單的話：
   * 那個名字會永遠留在清單裡（清單只增不刪）並在每次重建索引時拿去比對每張卡的標題，
   * 而回應又會把它照原樣回傳、看起來像存好了。
   */
  const productName = input.sourceId ? '' : String(rawBody?.productName ?? '').trim().slice(0, 60)
  if (!sourceId) {
    sourceId = uuidv4()
    const now = FieldValue.serverTimestamp()
    await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).set({
      workspaceId,
      type: 'manual',
      name: input.title.slice(0, 200),
      url: '',
      ...(productName ? { productName } : {}),
      folderId: typeof rawBody?.folderId === 'string' ? rawBody.folderId : null,
      filePath: '',
      contentHash: '',
      etag: '',
      lastModified: '',
      refreshIntervalSec: 0,
      refreshIntervalMinutes: 0,
      onChangeBehavior: 'notify',
      lastFetchedAt: now,
      outdatedAt: null,
      status: 'ready',
      chunkCount: 1,
      createdAt: now,
      updatedAt: now,
    })
  }

  // 併進產品名清單：下一次填「所屬產品」時這個名字才挑得到（同一台不會被打成第二種寫法）。
  // 要在建卡之前——建卡就會索引，索引時會讀這份清單決定卡片認哪個產品。
  if (productName) await addWorkspaceProductName(db, workspaceId, productName)

  const chunkId = uuidv4()
  const result = await createKnowledgeChunk(db, {
    workspaceId,
    chunkId,
    title: input.title,
    content: input.content,
    tags: input.tags,
    questions: input.questions,
    sourceId,
  })

  return {
    id: result.id,
    status: result.status,
    failureReason: result.failureReason,
    title: input.title,
    content: input.content,
    tags: input.tags,
    questions: input.questions ?? [],
    sourceId,
    productName,
  }
})
