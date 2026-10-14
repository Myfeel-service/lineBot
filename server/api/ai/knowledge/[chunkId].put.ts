import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import {
  KNOWLEDGE_CHUNKS_COLLECTION,
  normalizeChunkInput,
  updateKnowledgeChunk,
  validateChunkInput,
} from '~~/server/utils/ai-knowledge-chunks'
import { KNOWLEDGE_SOURCES_COLLECTION } from '~~/server/utils/ai-knowledge-sources'
import { writeAuditLog } from '~~/server/utils/audit-log'
import type { KnowledgeChunkStatus } from '~~/shared/types/ai-knowledge'

/** 比對用：去空白、去空的、不管順序（換個順序對 AI 沒有差別，updateKnowledgeChunk 判斷要不要重學也是這樣比） */
function sameList(a: string[], b: string[]): boolean {
  const key = (xs: string[]) => JSON.stringify(xs.map(x => String(x).trim()).filter(Boolean).sort())
  return key(a) === key(b)
}

/**
 * PUT /api/ai/knowledge/:chunkId
 * Body: { title, content, tags?[], questions?[] }
 *
 * 內容變動會觸發重新索引；只改標題/標籤則保留現有 embedding。
 * 若這張卡屬於 type='manual' 的 source（即「一個 source = 一張卡」的手寫條目），
 * 同步把 source.name 更新成新的 title，讓來源列表的顯示跟著走。
 *
 * ⛔ 什麼都沒改就什麼都不寫（`C-308`①）：以前按「儲存」一律寫 manuallyEditedAt——打開看一下、
 *    沒改字按儲存，那一條就被鎖住、從此不跟著表格／網頁更新，而且操作紀錄查不到
 *    （只有標題／內容變才記）。2026-10-13 MYFEEL 有 3 條就這樣被鎖。
 *    現在：標題、內容、客人問法、標籤（body 有帶的那幾格）跟存著的比，照同一套整理（normalizeChunkInput）之後
 *    一樣＝不寫、不鎖、回現在的樣子（`changed: false`）；有變才鎖、才記，紀錄講改了哪幾樣。
 *    body 沒帶 tags／questions＝不改那一格（以前沒帶 tags 會把標籤洗成空的）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'knowledge.write')
  const chunkId = String(getRouterParam(event, 'chunkId') ?? '').trim()
  if (!chunkId) throw createError({ statusCode: 400, statusMessage: 'chunkId required' })

  const rawBody = await readBody(event)
  const input = normalizeChunkInput(rawBody)
  const err = validateChunkInput(input)
  if (err) throw createError({ statusCode: 400, statusMessage: err })
  const tagsProvided = Array.isArray(rawBody?.tags)

  const db = getDb()
  const ref = db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(chunkId)
  const snap = await ref.get()
  if (!snap.exists) throw createError({ statusCode: 404, statusMessage: 'chunk not found' })
  const existing = snap.data() as {
    workspaceId?: string
    content?: string
    sourceId?: string | null
    title?: string
    tags?: unknown
    questions?: unknown
    status?: string
    failureReason?: string
  }
  if (existing.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: 'chunk not found' })
  }

  // 存著的值照 body 同一套整理（trim、去空的、問法最多 3 句），才不會「沒改」也比出差異
  const stored = normalizeChunkInput({
    title: existing.title,
    content: existing.content,
    tags: Array.isArray(existing.tags) ? existing.tags : [],
    questions: Array.isArray(existing.questions) ? existing.questions : [],
  })
  const titleChanged = stored.title !== input.title
  const contentChanged = stored.content !== input.content
  const questionsChanged = input.questions !== undefined && !sameList(input.questions, stored.questions ?? [])
  const tagsChanged = tagsProvided && !sameList(input.tags, stored.tags)

  if (!titleChanged && !contentChanged && !questionsChanged && !tagsChanged) {
    return {
      id: chunkId,
      status: String(existing.status ?? 'pending') as KnowledgeChunkStatus,
      failureReason: existing.failureReason,
      title: stored.title,
      content: stored.content,
      tags: stored.tags,
      /** false＝跟存著的一模一樣，什麼都沒寫、也沒鎖（`C-308`①） */
      changed: false,
    }
  }

  const result = await updateKnowledgeChunk(db, {
    chunkId,
    // title 也在 embedding 文字裡，改標題同樣要重新索引；問法變了 updateKnowledgeChunk 自己會判斷要重學
    contentChanged: contentChanged || titleChanged,
    manualEdit: true,
    ...input,
    tags: tagsProvided ? input.tags : undefined,
  })

  // 若是 manual source 的單張卡 → 同步更新 source.name；同時拿來源種類，紀錄才講得出「之後不跟著哪裡更新」
  let sourceType = ''
  if (existing.sourceId) {
    const sourceRef = db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(existing.sourceId)
    const sourceSnap = await sourceRef.get().catch(() => null)
    if (sourceSnap?.exists) {
      const sourceData = sourceSnap.data() as { type?: string; workspaceId?: string }
      if (sourceData?.workspaceId === workspaceId) {
        sourceType = String(sourceData.type ?? '')
        if (titleChanged && sourceType === 'manual') {
          await sourceRef.update({
            name: input.title.slice(0, 200),
            updatedAt: FieldValue.serverTimestamp(),
          }).catch(() => {})
        }
      }
    }
  }

  /*
   * 稽核（`C-254`、`C-308`①）。⛔ 內容**不整份存**：一條可以到好幾千字，存進來會被截成 500 字
   * 並把整筆標成 `lossy`；改了什麼用白話列出來，要看原文去知識庫看。
   * ⚠️ 標題／內容／問法變了會重新學習一次；從表格或網頁來的會被鎖住，兩件事都要寫進備註。
   */
  const what = [
    titleChanged && '標題',
    contentChanged && '內容',
    questionsChanged && '客人問法',
    tagsChanged && '標籤',
  ].filter(Boolean).join('、')
  const relearn = titleChanged || contentChanged || questionsChanged
  const lockNote = sourceType === 'gsheet'
    ? '；之後不會跟著表格更新（可以在這條解除鎖定）'
    : sourceType === 'url'
      ? '；之後不會跟著網頁更新（可以在這條解除鎖定）'
      : ''
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'knowledge.put',
    targetId: chunkId,
    before: { title: stored.title },
    after: { title: input.title },
    note: `${input.title}：改了${what}${relearn ? '，這條會重新學習一次' : ''}${lockNote}`,
  }, db)

  return {
    id: chunkId,
    status: result.status,
    failureReason: result.failureReason,
    title: input.title,
    content: input.content,
    tags: tagsProvided ? input.tags : stored.tags,
    changed: true,
  }
})
