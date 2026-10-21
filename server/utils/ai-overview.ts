/**
 * 總覽卡（isOverview）重生——resync-apply、網址自動更新與 gsheet 同步共用（C-49C）。
 *
 * 修掉的三個病（健檢 P1-5）：
 * 1. 子卡刪光後總覽卡留著，繼續對客人唸已下架的品項——而它走較寬鬆的回答門檻，
 *    「你們有賣什麼」幾乎必中。現在子卡不足 2 張就把舊總覽收進回收桶。
 * 2. 重生時把停用/過期/索引失敗/回收桶的子卡也算進去 → 總覽說得出、細節卡查不到，
 *    AI 前後矛盾。現在只餵「可用」(indexed 且不在回收桶) 的子卡。
 * 3. gsheet 型錄的總覽永遠停在第一次匯入的版本。現在同步有增刪改就重生。
 *
 * 呼叫端記得只在「這輪真的動過卡」時呼叫——沒動也重生是白花一次 LLM＋embedding
 * （健檢「白花錢五處」之一）。
 *
 * **總覽分兩段（`C-369`，2026-10-21 老闆拍板）**：系統照子卡做的那一段（`overviewAuto`）每次重做；
 * 店家自己寫的那一段（`ownerNote`）系統不動。內容＝兩段接起來。
 * 以前「手動編輯過的總覽卡永遠不自動覆蓋」——MYFEEL 首頁那張 7/31 改過，「目前有賣的商品」就一直停在 7 月。
 * 現在整張手改過的舊總覽在下一次重做時拆一次：AI 只挑出哪幾句是店家自己的話（不改寫），
 * 商品清單換成現在的，原本整張存在 `legacyManualContent` 備查。拆不成（AI 掛了）就照舊保留、不動。
 */
import { v4 as uuidv4 } from 'uuid'
import type { Firestore } from 'firebase-admin/firestore'
import { pickOwnerNoteSentences, splitOwnerNoteSentences, summarizeAsOverviewCard } from './ai-knowledge-chunker'
import {
  buildChunkSoftDeletePatch,
  createKnowledgeChunk,
  KNOWLEDGE_CHUNKS_COLLECTION,
  updateKnowledgeChunk,
} from './ai-knowledge-chunks'
import { recordAiUsage } from './ai-usage'
import { callsOf, usageFromCalls } from './ai-usage-calls'
import { assertKnowledgeChunkQuota, invalidateKnowledgeChunkCount } from './ai-knowledge-quota'
import { writeAuditLog } from './audit-log'

/**
 * 這一輪做了什麼。同步那兩條路不看；「匯入完才問要不要做總表」那支（`D-123`②）要靠它講結果——
 * ⛔ 沒做出來（子卡不夠、AI 沒給、手改過）不可以回成功：按了「做一張」卻什麼都沒有，人只會以為按了沒用。
 */
export type OverviewRegenOutcome = 'created' | 'updated' | 'retired' | 'kept_manual' | 'skipped'

/** 總覽的內容＝系統做的那段＋店家寫的那段（`C-369`）。店家沒寫就只有系統那段 */
export function composeOverviewContent(auto: string, ownerNote: string): string {
  const note = String(ownerNote ?? '').trim()
  return note ? `${String(auto ?? '').trim()}\n\n${note}` : String(auto ?? '').trim()
}

interface ExistingOverview {
  id: string
  manuallyEdited: boolean
  status: string
  content: string
  /** undefined＝舊的總覽（沒拆過） */
  ownerNote: string | undefined
}

export async function regenerateOverviewCard(
  db: Firestore,
  workspaceId: string,
  sourceId: string,
): Promise<OverviewRegenOutcome> {
  const snap = await db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .where('sourceId', '==', sourceId)
    .get()

  let existingOverview: ExistingOverview | null = null
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
        content: String(data?.content ?? ''),
        ownerNote: typeof data?.ownerNote === 'string' ? data.ownerNote : undefined,
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

  /**
   * ⛔子卡「暫時」不可用時什麼都不做（C-49C）：Gemini 一次故障就會讓整批子卡變 failed，
   * 若照 childCards<2 判定就會把總覽卡收進回收桶——之後 retry 把子卡修好了，
   * 但重生只在「同步有增刪改」時觸發，下一次同步是「沒變」→ 總覽永遠回不來。
   * 有 pending/failed 子卡＝狀態未定，等它們塵埃落定的那一輪再處理。
   */
  if (transientChildren > 0 && childCards.length < 2) return 'skipped'

  // 子卡真的沒了：舊總覽收進回收桶（不能留著——型錄改版清空後它會繼續唸已下架品項）。
  // 整張手改過、還沒拆的照舊留著（那是店家的字，不替他丟）；拆過的跟系統做的一樣退休
  if (childCards.length < 2) {
    if (existingOverview && !existingOverview.manuallyEdited) {
      await db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(existingOverview.id)
        .update(buildChunkSoftDeletePatch(existingOverview.status))
        .catch(e => console.warn('[overview] retire failed:', e))
      return 'retired'
    }
    return existingOverview ? 'kept_manual' : 'skipped'
  }

  /**
   * 店家自己寫的那段（`C-369`）：
   * - 拆過的（有 ownerNote）→ 照用
   * - 整張手改過、還沒拆的 → 這一次拆：AI 挑出哪幾句是店家自己的話（只挑、不改寫）
   * - 都不是（整張系統做的）→ 沒有
   * 拆不成就照舊保留整張、不動——寧可清單舊一點，也不要把店家寫的話弄丟。
   */
  let ownerNote = existingOverview?.ownerNote ?? ''
  let splitFrom: string | null = null
  if (existingOverview?.manuallyEdited && existingOverview.ownerNote === undefined) {
    try {
      const sentences = splitOwnerNoteSentences(existingOverview.content)
      const picked = await pickOwnerNoteSentences(sentences)
      if (sentences.length) await recordAiUsage(workspaceId, usageFromCalls('build', callsOf(picked)))
      ownerNote = picked.keep.map(i => sentences[i]!).join('')
      splitFrom = existingOverview.content
    }
    catch (e) {
      console.warn(`[overview] ${workspaceId}/${sourceId} 手改過的總覽沒拆成，照舊保留:`, (e as Error)?.message)
      return 'kept_manual'
    }
  }

  /**
   * 要**新建**一張（不是改既有那張）＝多佔一條空間，先看空間、再花 AI 的錢。
   * ⛔ 2026-10-17 全站對過：試算表同步、網址套用改動自動重做總表時沒檢查，滿了照樣長出來
   *    （前面算空間時也沒預留這一條），每份型錄可以多收 1 條。手動「做一張總表」的端點本來就有擋。
   * 空間滿了就這輪不做：子卡照收，等空出空間、下次同步有改動時會再試。
   */
  if (!existingOverview) {
    try {
      await assertKnowledgeChunkQuota(workspaceId, 1, db)
    }
    catch (e) {
      if ((e as { statusCode?: number })?.statusCode !== 403) throw e
      console.warn(`[overview] ${workspaceId}/${sourceId} AI 知識量滿了，這輪不新建總表`)
      return 'skipped'
    }
  }

  const ov = await summarizeAsOverviewCard(
    childCards.map(c => ({ ...c, sourceId: null })),
  )
  if (!ov) return existingOverview?.manuallyEdited && splitFrom ? 'kept_manual' : 'skipped'

  await recordAiUsage(workspaceId, usageFromCalls('build', callsOf(ov)))

  const parts = {
    overviewAuto: ov.card.content,
    ownerNote,
  }
  const content = composeOverviewContent(ov.card.content, ownerNote)

  if (existingOverview) {
    await updateKnowledgeChunk(db, {
      chunkId: existingOverview.id,
      title: ov.card.title,
      content,
      tags: ov.card.tags,
      questions: ov.card.questions ?? [],
      contentChanged: true,
      manualEdit: false,
    })
    await db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(existingOverview.id).update({
      ...parts,
      // 拆完就不是「整張手改過」了：之後清單照資料重做，店家的話在 ownerNote 裡
      manuallyEditedAt: null,
      ...(splitFrom !== null ? { legacyManualContent: splitFrom } : {}),
    })
    if (splitFrom !== null) {
      // 系統動了店家改過的東西：一定要記（`C-254`），講清楚原文去哪找
      await writeAuditLog({
        workspaceId,
        uid: '',
        actor: 'system',
        action: 'knowledge.put',
        targetId: existingOverview.id,
        after: { title: ov.card.title },
        note: `總覽「${ov.card.title}」：商品清單改成跟著資料自動更新${ownerNote ? '，你寫的介紹留在最後一段' : ''}；你原本改過的整段另外存著，要還原可以找回來`,
      }, db).catch(e => console.warn('[overview] 操作紀錄沒寫成（不影響總覽）:', e))
    }
    return 'updated'
  }
  const chunkId = uuidv4()
  await createKnowledgeChunk(db, {
    workspaceId,
    chunkId,
    title: ov.card.title,
    content,
    tags: ov.card.tags,
    questions: ov.card.questions ?? [],
    isOverview: true,
    sourceId,
  })
  await db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(chunkId).update(parts)
    .catch(e => console.warn('[overview] 兩段欄位沒寫成（下次重做會補）:', e))
  // 條數快取 60 秒：不作廢的話，緊接著的空間檢查會少算剛長出來的這一條
  invalidateKnowledgeChunkCount(workspaceId)
  return 'created'
}
