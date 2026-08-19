/**
 * 總覽卡（isOverview）重生——resync-apply 與 gsheet 同步共用（C-49C）。
 *
 * 修掉的三個病（健檢 P1-5）：
 * 1. 子卡刪光後總覽卡留著，繼續對客人唸已下架的品項——而它走較寬鬆的回答門檻，
 *    「你們有賣什麼」幾乎必中。現在子卡不足 2 張就把舊總覽收進回收桶。
 * 2. 重生時把停用/過期/索引失敗/回收桶的子卡也算進去 → 總覽說得出、細節卡查不到，
 *    AI 前後矛盾。現在只餵「可用」(indexed 且不在回收桶) 的子卡。
 * 3. gsheet 型錄的總覽永遠停在第一次匯入的版本。現在同步有增刪改就重生。
 *
 * 呼叫端記得只在「這輪真的動過卡」時呼叫——沒動也重生是白花一次 LLM＋embedding
 * （健檢「白花錢五處」之一）。手動編輯過的總覽卡永遠不自動覆蓋。
 */
import { v4 as uuidv4 } from 'uuid'
import type { Firestore } from 'firebase-admin/firestore'
import { summarizeAsOverviewCard } from './ai-knowledge-chunker'
import {
  buildChunkSoftDeletePatch,
  createKnowledgeChunk,
  KNOWLEDGE_CHUNKS_COLLECTION,
  updateKnowledgeChunk,
} from './ai-knowledge-chunks'
import { recordAiUsage } from './ai-usage'

export async function regenerateOverviewCard(
  db: Firestore,
  workspaceId: string,
  sourceId: string,
): Promise<void> {
  const snap = await db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .where('sourceId', '==', sourceId)
    .get()

  let existingOverview: { id: string; manuallyEdited: boolean; status: string } | null = null
  const childCards: Array<{ title: string; content: string; tags: string[] }> = []
  /**
   * 「暫時說不出話」的子卡（pending / failed）：不能拿來合成總覽（內容可能還沒索引好），
   * 但**存在**這件事要記著——見下面的退休守門。
   */
  let transientChildren = 0
  for (const d of snap.docs) {
    const data = d.data() as any
    if (data?.deletedAt != null) continue // 回收桶不參與（也不把回收桶裡的舊總覽當現任）
    if (data?.isOverview === true) {
      existingOverview = {
        id: d.id,
        manuallyEdited: data?.manuallyEditedAt != null,
        status: String(data?.status ?? 'pending'),
      }
      continue
    }
    const st = String(data?.status ?? '')
    if (st === 'pending' || st === 'failed') transientChildren++
    // 只餵「可用」子卡：停用/到期/索引失敗的卡不該出現在「你們有賣什麼」的答案裡
    if (st !== 'indexed') continue
    childCards.push({
      title: String(data?.title ?? ''),
      content: String(data?.content ?? ''),
      tags: Array.isArray(data?.tags) ? data.tags.map(String) : [],
    })
  }

  // 手動編輯過的總覽卡：尊重人工版本，不自動覆蓋
  if (existingOverview?.manuallyEdited) return

  /**
   * ⛔子卡「暫時」不可用時什麼都不做（C-49C）：Gemini 一次故障就會讓整批子卡變 failed，
   * 若照 childCards<2 判定就會把總覽卡收進回收桶——之後 retry 把子卡修好了，
   * 但重生只在「同步有增刪改」時觸發，下一次同步是「沒變」→ 總覽永遠回不來。
   * 有 pending/failed 子卡＝狀態未定，等它們塵埃落定的那一輪再處理。
   */
  if (transientChildren > 0 && childCards.length < 2) return

  // 子卡真的沒了：舊總覽收進回收桶（不能留著——型錄改版清空後它會繼續唸已下架品項）
  if (childCards.length < 2) {
    if (existingOverview) {
      await db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(existingOverview.id)
        .update(buildChunkSoftDeletePatch(existingOverview.status))
        .catch(e => console.warn('[overview] retire failed:', e))
    }
    return
  }

  const ov = await summarizeAsOverviewCard(
    childCards.map(c => ({ ...c, sourceId: null })),
  )
  if (!ov) return

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
