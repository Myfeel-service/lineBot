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
import { composeOverviewContent } from '~~/server/utils/ai-overview'
import type { KnowledgeChunkStatus } from '~~/shared/types/ai-knowledge'

/** 總覽裡「你寫的那段」最多幾個字（整張還要放得下商品清單，單條上限 5000） */
const OWNER_NOTE_MAX_CHARS = 1500

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
    isOverview?: boolean
    overviewAuto?: string
  }
  if (existing.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: 'chunk not found' })
  }

  /**
   * 總覽只改「你寫的那段」（`C-369`）：商品清單那段系統照資料重做，這裡收的是店家補充的話。
   * ⛔ 不鎖：改了這段之後商品清單照樣跟著資料換——整張鎖住就是 MYFEEL 首頁總覽停在 7 月的原因。
   * 只對拆過兩段的總覽有效；還沒拆的（舊的）照一般知識改，下次資料更新時才拆。
   */
  const ownerNoteEdit = existing.isOverview === true && typeof existing.overviewAuto === 'string' && typeof rawBody?.ownerNote === 'string'
  const ownerNote = ownerNoteEdit ? String(rawBody.ownerNote).trim().slice(0, OWNER_NOTE_MAX_CHARS) : ''
  const input = normalizeChunkInput(ownerNoteEdit
    ? { ...rawBody, content: composeOverviewContent(existing.overviewAuto!, ownerNote) }
    : rawBody)
  const err = validateChunkInput(input)
  if (err) throw createError({ statusCode: 400, statusMessage: err })

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
    // 總覽只改「你寫的那段」不鎖（`C-369`）
    manualEdit: !ownerNoteEdit,
    ...input,
    tags: tagsProvided ? input.tags : undefined,
  })
  if (ownerNoteEdit) {
    await ref.update({ ownerNote })
  }
  else if (existing.isOverview === true && contentChanged) {
    // 拆過兩段的總覽被整張改了（不是只改你寫的那段）：照手改處理，兩段的記號拿掉，下次資料更新時再拆一次
    await ref.update({ ownerNote: FieldValue.delete(), overviewAuto: FieldValue.delete() })
  }

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
    contentChanged && (ownerNoteEdit ? '你寫的介紹' : '內容'),
    questionsChanged && '客人問法',
    tagsChanged && '標籤',
  ].filter(Boolean).join('、')
  const relearn = titleChanged || contentChanged || questionsChanged
  /**
   * ⛔ 總覽整張改（不是只改你寫的那段）也不能講「之後不會跟著網頁更新」（`C-379`）：下次資料有更新時
   *    總覽照 `C-369` 會被拆開重做——商品清單換成最新的、AI 挑出他自己的話留著，改過的整段另外存著。
   *    講「鎖住了」等於騙他：他以為改好的字會一直在，下次更新就被換掉了。
   */
  const lockNote = ownerNoteEdit
    ? '；商品清單照樣跟著資料更新'
    : existing.isOverview === true
    ? `；總覽照樣跟著資料更新：下次更新時商品清單會換成最新的，你寫的介紹會留著${contentChanged ? '（這次改的整段另外存著，可以找回來）' : ''}`
    : sourceType === 'gsheet'
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
    // `D-129`：店家看得到的字不講「重新學習」
    note: `${input.title}：改了${what}${relearn ? '，AI 會照新的內容再學一次' : ''}${lockNote}`,
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
