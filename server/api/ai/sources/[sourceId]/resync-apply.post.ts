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
  promoteExtractedToApplied,
} from '~~/server/utils/ai-knowledge-sources'
import { invalidateKnowledgeChunkCount } from '~~/server/utils/ai-knowledge-quota'
import { assertMaintenanceBudget } from '~~/server/utils/ai-usage'
import { regenerateOverviewCard } from '~~/server/utils/ai-overview'
import {
  countDivergentKeeps,
  loadDiffExemptIds,
  type DiffAction,
  type DiffEntry,
} from '~~/server/utils/ai-knowledge-resync'
import { applyResyncEntries } from '~~/server/utils/ai-knowledge-resync-apply'
import { writeAuditLog } from '~~/server/utils/audit-log'

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
 * 套用本身（額度、驗證、逐條改）跟每天排程的自動更新共用 `applyResyncEntries`（`C-368`）。
 * 套用後：清掉 outdatedAt 旗標、更新 source.lastFetchedAt / chunkCount。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'sources.write')
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

  const { added, updated, deleted, kept, quotaSkipped, errors } = await applyResyncEntries(db, {
    workspaceId,
    sourceId,
    entries,
    decisions,
    // 有 applyId 就用決定性 id（重按覆寫同一張，不重複建卡）；舊 client 沒帶則照舊隨機
    chunkIdFor: e => (applyId ? deterministicChunkId(e.id) : uuidv4()),
  })

  // 列表頁來源：依套用後的子卡片重新合成總覽卡（覆蓋舊的；手動編輯過則保留）。
  // 只在真的動過卡時重生（C-49D）：全選保留＝什麼都沒改，也重生等於白付一次總覽 LLM＋embedding
  if (source.data.generateOverview && (added || updated || deleted)) {
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
  /**
   * 可豁免項目一律以**伺服器自己存的那份**為準（`C-153`），不看 body 上的 `cosmetic`：
   * 這個決定會永久推進指紋，而指紋一推進，這次保留的差異就再也沒有人看得到。
   * 帳本綁 contentHash，對不上（例如排程中途又抓了一次）就回空集合＝不豁免。
   */
  const exemptIds = await loadDiffExemptIds(db, sourceId, bodyHash)
  const divergentKeeps = countDivergentKeeps(entries, decisions, exemptIds)
  // ⛔ 空間不夠沒建的新增也一樣（`C-308`⑪）：網頁上有、知識庫沒有，指紋推進了就再也比不出這幾條
  const fingerprintSafe = errors.length === 0 && divergentKeeps === 0 && quotaSkipped === 0
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
    // 「這份在講什麼」（`C-316`）：網頁內容套用了，舊摘要作廢（/code-review 第 4 條）
    ...(added || updated || deleted ? { summary: [], summaryAt: null } : {}),
  })
  /**
   * 存「這批知識是照哪一版網頁做的」原文（`C-368`）：之後才比得出網頁改了哪幾行。
   * ⚠️ 條件比指紋寬一格：**選了「保留舊版／略過」也存**。那是他看過這一版網頁之後做的決定——
   *    下次只該問「網頁又改了哪裡」，不該把他決定過的那幾條再端出來（`D-139` 老闆嫌的「一直叫我更新」）。
   *    指紋照 `C-44` 不推進，所以精確比對那條捷徑不會說「已是最新」；逐行比才會。
   * ⛔ 有沒套成功的、或空間不夠少加的就不存：那幾行要下次還比得出來，才補得上。
   */
  if (bodyHash && errors.length === 0 && quotaSkipped === 0) await promoteExtractedToApplied(db, sourceId, bodyHash)
  // 「有變動」旗標：全部套完（含保留決定）就清——使用者剛剛親手看過這份 diff；
  // 若卡片仍與網頁不同，排程下一輪確認到變動會再標回來，不會永久消失。
  // 逐卡有失敗時不清：這次套用沒完成，提示留著。空間不夠沒建完也一樣（空出位置之後再套一次才收得進來）。
  if (errors.length === 0 && quotaSkipped === 0) {
    await clearSourceOutdated(db, sourceId)
  }
  // 張數變了：額度的 60 秒快取要立刻作廢，不然接下來一分鐘內的匯入看到的還是套用前的張數
  if (added || deleted) invalidateKnowledgeChunkCount(workspaceId)

  /*
   * 稽核（`C-254`）。⛔ `errors` 一定要記：部分失敗的那幾張留在舊版而使用者以為全套用了，
   * 正是這個專案一再付代價的「沉默地少做一件事」。
   * ⚠️ `divergentKeeps` 是「卡片故意跟網頁不一樣」的張數——它會擋住指紋推進，
   *    也是之後「為什麼一直說有變動」的答案。
   */
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'source.resyncApply',
    targetId: sourceId,
    after: { name: String(source.data.name ?? ''), added, updated, deleted, failedItemsCount: errors.length, ...(quotaSkipped ? { quotaSkipped } : {}) },
    note: `${String(source.data.name ?? '')}：新增 ${added}、覆蓋 ${updated}、刪除 ${deleted}、保留 ${kept}`
      // ⛔ 空間不夠沒建的要講（`C-308`⑪）：只寫「新增 3」，看的人會以為網頁上的新內容都收了
      + (quotaSkipped ? `；AI 知識量滿了，還有 ${quotaSkipped} 條新的沒有加進來` : '')
      + (errors.length ? `；⚠️ 有 ${errors.length} 條沒套用成功，還停在舊版` : '')
      + (divergentKeeps ? `；有 ${divergentKeeps} 條刻意保留成跟來源不一樣` : ''),
  }, db)

  return {
    sourceId,
    added,
    updated,
    deleted,
    kept,
    /** AI 知識量不夠、這次沒建的新增條數（`C-308`⑪）；0＝都收了。畫面要講「還有 N 條沒加進來」 */
    quotaSkipped,
    errors,
    chunkCount: newChunkCount,
    divergentKeeps,
    fingerprintAdvanced: !!bodyHash && fingerprintSafe,
  }
})
