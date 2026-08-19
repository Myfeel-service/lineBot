import { createHash } from 'node:crypto'
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
  buildChunkSoftDeletePatch,
  createKnowledgeChunk,
  KNOWLEDGE_CHUNKS_COLLECTION,
  normalizeChunkInput,
  updateKnowledgeChunk,
  validateChunkInput,
} from '~~/server/utils/ai-knowledge-chunks'
import { summarizeAsOverviewCard } from '~~/server/utils/ai-knowledge-chunker'
import { assertMaintenanceBudget, recordAiUsage } from '~~/server/utils/ai-usage'
import { countDivergentKeeps, loadOldChunksForDiff, type DiffAction, type DiffEntry } from '~~/server/utils/ai-knowledge-resync'

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
  // 維運額度前置檢查（C-45）：套用會跑 embedding＋總覽 LLM
  await assertMaintenanceBudget(workspaceId)
  const sourceId = String(getRouterParam(event, 'sourceId') ?? '').trim()
  if (!sourceId) throw createError({ statusCode: 400, statusMessage: 'sourceId required' })

  const body = await readBody(event)
  const entries = Array.isArray(body?.entries) ? body.entries as DiffEntry[] : []
  const decisions = body?.decisions as Record<string, DiffAction> | undefined
  if (!entries.length || !decisions) {
    throw createError({ statusCode: 400, statusMessage: '請提供 entries 與 decisions' })
  }
  /**
   * applyId（C-43 冪等鍵）：150 張卡的套用會超過閘道 30 秒——Lambda 其實做完了，
   * 前端卻收到逾時、使用者再按一次。有 applyId 時 add_new 的 chunkId 用它決定性導出，
   * 重按同一次套用會覆寫同一批 doc 而不是用新 uuid 再生一批重複卡。
   */
  const applyId = String(body?.applyId ?? '').trim().slice(0, 64)
  const deterministicChunkId = (entryId: string) =>
    createHash('sha256').update(`resync:${sourceId}:${applyId}:${entryId}`).digest('hex').slice(0, 32)

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
          // 有 applyId 就用決定性 id（重按覆寫同一張，不重複建卡）；舊 client 沒帶則照舊隨機
          chunkId: applyId ? deterministicChunkId(entry.id) : uuidv4(),
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
        // 進回收桶（軟刪除）而非真刪：診斷 diff 誤選「刪除」、或縮水誤判時還有 30 天可還原
        await db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(entry.oldChunk.id)
          .update(buildChunkSoftDeletePatch())
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
  /**
   * ⛔指紋只有在「卡片真的同步到這一版網頁」時才能推進（C-44）：
   * - 有任何「保留了與網頁不同的內容」的決定（手編卡預設保留就是最常見的一種）→ 不推進。
   *   推進等於宣告已同步，下次重新同步直接回「已是最新」、排程也不再提醒——
   *   卡片寫 100、網頁寫 120，這個差異從此蒸發，只剩一顆不顯眼的「強制重切」能救。
   * - 有逐卡失敗（errors）→ 不推進、也不清「有變動」旗標：部分失敗不能記成完整成功。
   * 不推進的代價只是下次重新同步要再跑一輪比對——方向安全。
   */
  const divergentKeeps = countDivergentKeeps(entries, decisions)
  const fingerprintSafe = errors.length === 0 && divergentKeeps === 0
  const newChunkCount = await countSourceChunks(db, workspaceId, sourceId)
  await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).update({
    chunkCount: newChunkCount,
    lastFetchedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    // appliedContentHash 與 contentHash 一起寫：這批卡就是從這一版內容切出來的。
    // 下次按「重新同步」時拿它跟當場抓到的網頁比，一樣就直接回報「沒變」，
    // 不必再花一輪 LLM 重切卡、也不會冒出兩批 LLM 產物之間的假差異。
    // textHash（抹掉數字後的指紋）跟著作廢：這條路上沒有原文可以重算，留著舊值會讓
    // 兩道指紋對應到不同版本，排程下次數字一動就誤判成「文字改過了」而誤報變動。
    // 清成空值＝沒有基準，排程會退回逐字比對，並在下一個「內容沒變」的檢查輪重建它。
    ...(bodyHash && fingerprintSafe ? { contentHash: bodyHash, appliedContentHash: bodyHash, textHash: '' } : {}),
    // 手動套用變更＝這個來源現在是好的，把失敗標記一起清掉。
    // 不清的話只能等下一次排程成功檢查才會清，而設成「不偵測」的來源永遠不會被排程撈到
    // → 體檢紅字永久卡著。逐卡有失敗時不清（還不算「好」）。
    ...(errors.length === 0 ? buildSourceClearFailure(source.data.status) : {}),
  })
  // 「有變動」旗標：全部套完（含保留決定）就清——使用者剛剛親手看過這份 diff；
  // 若卡片仍與網頁不同，排程下一輪確認到變動會再標回來，不會永久消失。
  // 逐卡有失敗時不清：這次套用沒完成，提示留著。
  if (errors.length === 0) {
    await clearSourceOutdated(db, sourceId)
  }

  return {
    sourceId,
    added,
    updated,
    deleted,
    kept,
    errors,
    chunkCount: newChunkCount,
    divergentKeeps,
    fingerprintAdvanced: !!bodyHash && fingerprintSafe,
  }
})
