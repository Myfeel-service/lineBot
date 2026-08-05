import { v4 as uuidv4 } from 'uuid'
import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import {
  buildSourceClearFailure,
  clearSourceOutdated,
  countSourceChunks,
  getSource,
  KNOWLEDGE_SOURCES_COLLECTION,
} from '~~/server/utils/ai-knowledge-sources'
import {
  createKnowledgeChunk,
  KNOWLEDGE_CHUNKS_COLLECTION,
  normalizeChunkInput,
  updateKnowledgeChunk,
  validateChunkInput,
} from '~~/server/utils/ai-knowledge-chunks'
import { summarizeAsOverviewCard } from '~~/server/utils/ai-knowledge-chunker'
import { recordAiUsage } from '~~/server/utils/ai-usage'
import { loadOldChunksForDiff, type DiffAction, type DiffEntry } from '~~/server/utils/ai-knowledge-resync'

/**
 * 套用 diff 後，依「當下這個 source 旗下的子卡片」重新合成總覽卡（isOverview）。
 * 機器合成、預設覆蓋；但若使用者手動編輯過總覽卡（manuallyEditedAt）則保留不動。
 * 失敗只記 warning，不擋 re-sync 主流程。
 */
async function regenerateOverviewCard(
  db: ReturnType<typeof getDb>,
  workspaceId: string,
  sourceId: string,
): Promise<void> {
  const snap = await db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .where('sourceId', '==', sourceId)
    .get()

  let existingOverview: { id: string; manuallyEdited: boolean } | null = null
  const childCards: Array<{ title: string; content: string; tags: string[] }> = []
  for (const d of snap.docs) {
    const data = d.data() as any
    if (data?.isOverview === true) {
      existingOverview = { id: d.id, manuallyEdited: data?.manuallyEditedAt != null }
      continue
    }
    childCards.push({
      title: String(data?.title ?? ''),
      content: String(data?.content ?? ''),
      tags: Array.isArray(data?.tags) ? data.tags.map(String) : [],
    })
  }

  // 手動編輯過的總覽卡：尊重人工版本，不自動覆蓋
  if (existingOverview?.manuallyEdited) return

  const ov = await summarizeAsOverviewCard(
    childCards.map(c => ({ ...c, sourceId: null })),
  )
  if (!ov) return // 子卡不足 2 張等情況，保留現狀

  await recordAiUsage(workspaceId, {
    inputTokens: ov.inputTokens,
    outputTokens: ov.outputTokens,
    importInputTokens: ov.inputTokens,
    importOutputTokens: ov.outputTokens,
  }).catch(() => {})

  if (existingOverview) {
    await updateKnowledgeChunk(db, {
      chunkId: existingOverview.id,
      title: ov.card.title,
      content: ov.card.content,
      tags: ov.card.tags,
      questions: ov.card.questions ?? [],
      contentChanged: true,
      manualEdit: false,
    })
  }
  else {
    await createKnowledgeChunk(db, {
      workspaceId,
      chunkId: uuidv4(),
      title: ov.card.title,
      content: ov.card.content,
      tags: ov.card.tags,
      questions: ov.card.questions ?? [],
      isOverview: true,
      sourceId,
    })
  }
}

/**
 * POST /api/ai/sources/:sourceId/resync-apply
 *
 * Body: { entries: DiffEntry[], decisions: Record<entryId, DiffAction> }
 *
 * 客戶端把 preview 拿到的 diff entries 跟使用者每張的決定送回來，後端依決定套用：
 *   - add_new   → 新建 chunk（含 embedding）
 *   - use_new   → 用新版內容覆蓋舊 chunk（觸發 re-index）；清掉 manuallyEditedAt
 *   - keep_old  → 不動
 *   - delete_old → 刪掉舊 chunk
 *   - skip      → 不動（跟 keep_old 等價，但語意上指「新版被略過」）
 *
 * 套用後：清掉 outdatedAt 旗標、更新 source.lastFetchedAt / chunkCount。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'sources.write')
  const sourceId = String(getRouterParam(event, 'sourceId') ?? '').trim()
  if (!sourceId) throw createError({ statusCode: 400, statusMessage: 'sourceId required' })

  const body = await readBody(event)
  const entries = Array.isArray(body?.entries) ? body.entries as DiffEntry[] : []
  const decisions = body?.decisions as Record<string, DiffAction> | undefined
  if (!entries.length || !decisions) {
    throw createError({ statusCode: 400, statusMessage: '請提供 entries 與 decisions' })
  }

  const db = getDb()
  const source = await getSource(db, sourceId, workspaceId)
  if (!source) throw createError({ statusCode: 404, statusMessage: 'source not found' })

  // entries 整包由 client 提供:任何引用舊卡的動作（覆寫 / 刪除 / questions 回填）都必須
  // 先驗證該卡確實屬於本 workspace + 本 source,否則帶任意 chunkId 就能跨租戶刪改。
  const ownedChunkIds = new Set(
    (await loadOldChunksForDiff(db, workspaceId, sourceId)).map(c => c.id),
  )

  let added = 0
  let updated = 0
  let deleted = 0
  let kept = 0
  const errors: Array<{ entryId: string; message: string }> = []

  for (const entry of entries) {
    const action = decisions[entry.id]
    if (!action) {
      kept++
      continue
    }
    if (entry.oldChunk && !ownedChunkIds.has(entry.oldChunk.id)) {
      errors.push({ entryId: entry.id, message: '卡片不屬於此來源，已略過' })
      continue
    }
    try {
      if (action === 'keep_old' || action === 'skip') {
        // 內容完全相同（kind=unchanged）的卡：順手回填新切卡生成的「常見問法」。
        // 內容沒變所以問句安全可採；不回填的話，舊卡（多在 questions 功能上線前建立）
        // 永遠吃不到問句帶來的檢索提升。updateKnowledgeChunk 偵測到 questions 變更會自動重新索引。
        if (
          entry.kind === 'unchanged'
          && entry.oldChunk
          && entry.newChunk?.questions?.length
        ) {
          await updateKnowledgeChunk(db, {
            chunkId: entry.oldChunk.id,
            title: entry.oldChunk.title,
            content: entry.oldChunk.content,
            tags: entry.oldChunk.tags,
            questions: entry.newChunk.questions,
            contentChanged: false,
            manualEdit: false,
          }).catch(e => console.warn('[resync-apply] questions backfill failed:', entry.oldChunk?.id, e))
        }
        kept++
        continue
      }
      if (action === 'add_new' && entry.newChunk) {
        // 新內容也由 client 提供:過品質/格式驗證（trim、5000 上限、過短 placeholder）
        const input = normalizeChunkInput(entry.newChunk)
        const verr = validateChunkInput(input)
        if (verr) {
          errors.push({ entryId: entry.id, message: verr })
          continue
        }
        await createKnowledgeChunk(db, {
          workspaceId,
          chunkId: uuidv4(),
          title: input.title,
          content: input.content,
          tags: input.tags,
          questions: input.questions ?? [],
          sourceId,
        })
        added++
        continue
      }
      if (action === 'use_new' && entry.oldChunk && entry.newChunk) {
        const input = normalizeChunkInput(entry.newChunk)
        const verr = validateChunkInput(input)
        if (verr) {
          errors.push({ entryId: entry.id, message: verr })
          continue
        }
        await updateKnowledgeChunk(db, {
          chunkId: entry.oldChunk.id,
          title: input.title,
          content: input.content,
          tags: input.tags,
          questions: input.questions ?? [],
          // title 也在 embedding 文字裡，title 或 content 變了都要重新索引
          contentChanged: entry.oldChunk.content !== input.content
            || entry.oldChunk.title !== input.title,
          manualEdit: false, // re-sync 是自動的，不算手動編輯
        })
        // 清掉 manuallyEditedAt（使用者已選擇用新版了）
        await db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(entry.oldChunk.id).update({
          manuallyEditedAt: null,
        }).catch(() => {})
        updated++
        continue
      }
      if (action === 'delete_old' && entry.oldChunk) {
        await db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(entry.oldChunk.id).delete()
        deleted++
        continue
      }
      errors.push({ entryId: entry.id, message: `invalid action "${action}" for kind "${entry.kind}"` })
    }
    catch (err: any) {
      errors.push({
        entryId: entry.id,
        message: String(err?.statusMessage || err?.message || 'unknown error').slice(0, 200),
      })
    }
  }

  // 列表頁來源：依套用後的子卡片重新合成總覽卡（覆蓋舊的；手動編輯過則保留）
  if (source.data.generateOverview) {
    await regenerateOverviewCard(db, workspaceId, sourceId)
      .catch(e => console.warn('[resync-apply] overview regen failed:', e))
  }

  // 更新 source 狀態。contentHash 用 client 帶回的「preview 當時的指紋」（preview 回應
  // 原樣轉傳）——不能讀當下的 cache:排程任務可能在 preview 與 apply 之間覆寫 cache,
  // 那會把新版指紋配上舊版內容,新變動從此不再被偵測。沒帶就不動 contentHash
  //（最壞只是下次排程再報一次變動,方向安全）。
  const bodyHash = String(body?.contentHash ?? '').trim()
  const newChunkCount = await countSourceChunks(db, workspaceId, sourceId)
  await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).update({
    chunkCount: newChunkCount,
    lastFetchedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    // appliedContentHash 與 contentHash 一起寫：這批卡就是從這一版內容切出來的。
    // 下次按「重新同步」時拿它跟當場抓到的網頁比，一樣就直接回報「沒變」，
    // 不必再花一輪 LLM 重切卡、也不會冒出兩批 LLM 產物之間的假差異。
    ...(bodyHash ? { contentHash: bodyHash, appliedContentHash: bodyHash } : {}),
    // 手動套用變更＝這個來源現在是好的，把失敗標記一起清掉。
    // 不清的話只能等下一次排程成功檢查才會清，而設成「不偵測」的來源永遠不會被排程撈到
    // → 體檢紅字永久卡著。
    ...buildSourceClearFailure(source.data.status),
  })
  await clearSourceOutdated(db, sourceId)

  return {
    sourceId,
    added,
    updated,
    deleted,
    kept,
    errors,
    chunkCount: newChunkCount,
  }
})
