/**
 * 照一份 diff 的決定把知識改掉（`C-368` 從 `resync-apply.post.ts` 抽出來）。
 *
 * 為什麼抽：手動「立即更新」跟每天排程的自動更新要走**同一套**——
 * 額度怎麼算、刪的空出位置先給新增、驗證怎麼擋、手改過的鎖怎麼清，兩條路各寫一份遲早會分岔
 * （這個專案已經付過「排程那條少了摺疊」`C-157` 的代價）。
 * 指紋、總覽、操作紀錄、「有變動」旗標是呼叫端的事：兩條路的規矩不一樣（手動要看使用者選了什麼）。
 */
import type { Firestore } from 'firebase-admin/firestore'
import { listChunksBySource } from './ai-knowledge-sources'
import { chunkCountsTowardQuota, getKnowledgeChunkQuota } from './ai-knowledge-quota'
import {
  buildChunkSoftDeletePatch,
  createKnowledgeChunk,
  KNOWLEDGE_CHUNKS_COLLECTION,
  normalizeChunkInput,
  updateKnowledgeChunk,
  validateChunkInput,
} from './ai-knowledge-chunks'
import type { DiffAction, DiffEntry } from './ai-knowledge-resync'

export interface ApplyEntriesResult {
  added: number
  updated: number
  deleted: number
  kept: number
  /** AI 知識量不夠、這次沒建的新增條數（`C-308`⑪） */
  quotaSkipped: number
  errors: Array<{ entryId: string; message: string }>
  /** 給「看是哪些」用（`C-368` 自動更新那一行紀錄） */
  addedTitles: string[]
  updatedTitles: string[]
  removedTitles: string[]
}

export async function applyResyncEntries(
  db: Firestore,
  opts: {
    workspaceId: string
    sourceId: string
    entries: DiffEntry[]
    decisions: Record<string, DiffAction | undefined>
    /** 新增那幾條的知識編號（手動：applyId 導出的決定性編號；排程：網頁版本導出的） */
    chunkIdFor: (entry: DiffEntry) => string
  },
): Promise<ApplyEntriesResult> {
  const { workspaceId, sourceId, entries, decisions, chunkIdFor } = opts

  // entries 可能是瀏覽器送回來的：任何引用舊卡的動作（覆寫 / 刪除 / questions 回填）都必須
  // 先驗證該卡確實屬於本 workspace + 本 source,否則帶任意 chunkId 就能跨租戶刪改。
  // 下面算額度還要知道哪幾張是草稿，同一次讀取一起拿，不多讀一輪
  const sourceChunks = (await listChunksBySource(db, workspaceId, sourceId)).filter(c => !c.isOverview)
  const ownedChunkIds = new Set(sourceChunks.map(c => c.id))
  // 刪了空得出位置的＝有算額度的那幾張（同一把尺見 chunkCountsTowardQuota；listChunksBySource 已排除回收桶）
  const quotaChunkIds = new Set(sourceChunks.filter(c => chunkCountsTowardQuota(c)).map(c => c.id))

  /**
   * 方案知識量（`C-296` 審查 → `C-308`⑪ 改成跟加入同一個規矩）：**收到滿為止**。
   * 為什麼要守：匯入時空間不夠可以只收前幾條，可是之後按「重新同步」，沒收的那幾條會變成「新增」——
   * 不看額度就等於繞過方案上限。以前是「淨增加超過剩下的空間就整次 403」：覆蓋、刪除也一起不做，
   * 他只看到「失敗」，網頁上改了的價錢一條都沒更新。現在：
   *  · 先套刪除、覆蓋、保留（不佔空間；刪掉有算額度的那幾條還會空出位置——⛔ 草稿除外，本來就沒算）；
   *  · 新增照清單順序建到滿為止，沒建的數成 `quotaSkipped` 回給畫面、寫進操作紀錄；
   *  · 同一次套用重按（applyId 一樣）時，上一次已經建好的那條是原地覆寫，不佔新的位置。
   * 不限張數的方案、或讀不到方案（同 assertKnowledgeChunkQuota 的 fail-open）＝全部建。
   */
  const quota = await getKnowledgeChunkQuota(workspaceId, db).catch(() => null)
  let room: number | null = !quota || quota.limit == null ? null : Math.max(0, quota.limit - quota.used)

  const r: ApplyEntriesResult = {
    added: 0, updated: 0, deleted: 0, kept: 0, quotaSkipped: 0, errors: [],
    addedTitles: [], updatedTitles: [], removedTitles: [],
  }

  // 先跑「不新增」的決定（刪掉的空出位置要先算給新增用），再照原本順序跑新增
  const ordered = [
    ...entries.filter(e => decisions[e.id] !== 'add_new'),
    ...entries.filter(e => decisions[e.id] === 'add_new'),
  ]
  for (const entry of ordered) {
    const action = decisions[entry.id]
    if (!action) {
      r.kept++
      continue
    }
    if (entry.oldChunk && !ownedChunkIds.has(entry.oldChunk.id)) {
      r.errors.push({ entryId: entry.id, message: '這條知識不屬於這份資料，已略過' })
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
        r.kept++
        continue
      }
      if (action === 'add_new' && entry.newChunk) {
        // 新內容也由 client 提供:過品質/格式驗證（trim、5000 上限、過短 placeholder）
        const input = normalizeChunkInput(entry.newChunk)
        const verr = validateChunkInput(input)
        if (verr) {
          r.errors.push({ entryId: entry.id, message: verr })
          continue
        }
        const chunkId = chunkIdFor(entry)
        // 上一次（同一個編號）已經建好的：原地覆寫，不佔新的位置
        const overwrite = ownedChunkIds.has(chunkId)
        if (!overwrite && room !== null) {
          if (room <= 0) {
            r.quotaSkipped++
            continue
          }
          room--
        }
        await createKnowledgeChunk(db, {
          workspaceId,
          chunkId,
          title: input.title,
          content: input.content,
          tags: input.tags,
          questions: input.questions ?? [],
          sourceId,
        })
        r.added++
        r.addedTitles.push(input.title)
        continue
      }
      if (action === 'use_new' && entry.oldChunk && entry.newChunk) {
        const input = normalizeChunkInput(entry.newChunk)
        const verr = validateChunkInput(input)
        if (verr) {
          r.errors.push({ entryId: entry.id, message: verr })
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
        r.updated++
        r.updatedTitles.push(input.title)
        continue
      }
      if (action === 'delete_old' && entry.oldChunk) {
        // 進回收桶（軟刪除）而非真刪：診斷 diff 誤選「刪除」、或縮水誤判時還有 30 天可還原
        await db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(entry.oldChunk.id)
          .update(buildChunkSoftDeletePatch())
        r.deleted++
        r.removedTitles.push(entry.oldChunk.title)
        // 有算額度的那條進了回收桶＝空出一個位置給等一下的新增（草稿本來就沒算，空不出來）
        if (room !== null && quotaChunkIds.has(entry.oldChunk.id)) room++
        continue
      }
      r.errors.push({ entryId: entry.id, message: `invalid action "${action}" for kind "${entry.kind}"` })
    }
    catch (err: any) {
      r.errors.push({
        entryId: entry.id,
        message: String(err?.statusMessage || err?.message || 'unknown error').slice(0, 200),
      })
    }
  }
  return r
}
