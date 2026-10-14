import { FieldValue, Timestamp, type DocumentReference } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { KNOWLEDGE_CHUNKS_COLLECTION } from '~~/server/utils/ai-knowledge-chunks'
import { KNOWLEDGE_SOURCES_COLLECTION } from '~~/server/utils/ai-knowledge-sources'
import { writeAuditLog, auditTimeText } from '~~/server/utils/audit-log'
import type { KnowledgeChunkStatus } from '~~/shared/types/ai-knowledge'

/**
 * 解除鎖定之後，什麼時候會換回來源的版本（`C-308`②）——照資料種類不同，畫面照這個講：
 *  - next_sync：試算表，下一次同步（每小時，或按「立即同步」）
 *  - next_change：網址，網頁下一次有變動時
 *  - next_replace：檔案不會自己更新，下次「換新版」時照新版
 *  - never：手寫／貼上的文字，沒有來源會蓋過它（解鎖只是拿掉記號）
 */
type UnlockAppliesOn = 'next_sync' | 'next_change' | 'next_replace' | 'never'

function unlockAppliesOn(sourceType: string): UnlockAppliesOn {
  if (sourceType === 'gsheet') return 'next_sync'
  if (sourceType === 'url') return 'next_change'
  if (sourceType === 'file') return 'next_replace'
  return 'never'
}

const UNLOCK_NOTE: Record<UnlockAppliesOn, string> = {
  next_sync: '解除了鎖定，下一次同步會換回表格上的內容',
  next_change: '解除了鎖定，網頁下次有變動時會換回網頁上的內容',
  next_replace: '解除了鎖定；檔案不會自己更新，下次換新版時這條會照新版',
  never: '解除了鎖定（這條是手寫的，沒有來源會蓋過它）',
}

/**
 * POST /api/ai/knowledge/:chunkId/settings
 * Body: { enabled?: boolean; activeUntil?: string | null }
 *
 * 卡片的「供 AI 使用」開關與有效期限（與內容編輯分開：不動 embedding、不重新索引）。
 *   - enabled=false：status 'indexed' → 'disabled'（embedding 保留，重新啟用免重算）
 *   - enabled=true ：status 'disabled' → 'indexed'；一併清掉過期紀錄；已過去的期限順手清掉
 *                    （否則排程 10 分鐘內又把它關回去，使用者會以為開關壞了）
 *   - activeUntil：'YYYY-MM-DD' = 有效到該日結束（台灣時間 23:59:59）；null = 清除（永久）。
 *     把日期改到未來時，若卡片是「到期自動停用」狀態 → 視為要重新上架，自動重新啟用；
 *     手動關掉的卡則尊重開關、維持停用。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'knowledge.write')
  const chunkId = String(getRouterParam(event, 'chunkId') ?? '').trim()
  if (!chunkId) throw createError({ statusCode: 400, statusMessage: 'chunkId required' })

  const body = await readBody(event).catch(() => ({}))
  const hasEnabled = typeof body?.enabled === 'boolean'
  const hasActiveUntil = 'activeUntil' in (body ?? {})
  // 解除手動編輯鎖（C-44）：鎖住的卡不吃表格/網頁更新，是「表格改了永遠不生效」
  // 唯一的來源；這裡給一條明確的解鎖路（解鎖後下一輪同步就會覆蓋回來源版本）。
  const hasClearLock = body?.clearManualLock === true
  if (!hasEnabled && !hasActiveUntil && !hasClearLock) {
    throw createError({ statusCode: 400, statusMessage: '至少要帶 enabled、activeUntil 或 clearManualLock' })
  }

  // 解析有效期限：當日結束（台灣時間）才到期，符合「設 8/15 = 8/15 整天都有效」的直覺
  let activeUntilTs: Timestamp | null | undefined
  if (hasActiveUntil) {
    if (body.activeUntil === null || body.activeUntil === '') {
      activeUntilTs = null
    }
    else {
      const raw = String(body.activeUntil)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        throw createError({ statusCode: 400, statusMessage: 'activeUntil 格式須為 YYYY-MM-DD' })
      }
      const d = new Date(`${raw}T23:59:59.999+08:00`)
      if (Number.isNaN(d.getTime())) throw createError({ statusCode: 400, statusMessage: 'activeUntil 不是有效日期' })
      activeUntilTs = Timestamp.fromDate(d)
    }
  }

  const db = getDb()
  const ref = db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(chunkId)
  const snap = await ref.get()
  if (!snap.exists) throw createError({ statusCode: 404, statusMessage: 'chunk not found' })
  const chunk = snap.data() as any
  if (chunk.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: 'chunk not found' })
  }

  // 回收桶的卡不接受開關/期限操作：它的 status 是 disabled 沒錯，但那是「已刪除」不是「停用」。
  // 不擋的話，API 直接 enable 會讓一張已刪除的卡復活上線，30 天後又被 purge 排程真刪掉。
  if (chunk.deletedAt != null) {
    throw createError({ statusCode: 400, statusMessage: '這條知識在回收桶裡，請先還原再操作' })
  }

  const status = String(chunk.status ?? 'pending') as KnowledgeChunkStatus
  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() }

  if (hasEnabled) {
    if (body.enabled === false) {
      // 只有「可用」的卡有得關；pending/failed 本來就不會被 AI 引用
      if (status !== 'indexed' && status !== 'disabled') {
        throw createError({ statusCode: 400, statusMessage: '這條知識目前不是「可用」狀態，不需停用' })
      }
      update.status = 'disabled' satisfies KnowledgeChunkStatus
    }
    else {
      if (status !== 'indexed' && status !== 'disabled') {
        throw createError({ statusCode: 400, statusMessage: '這條知識還沒學好，無法啟用' })
      }
      // 按鈕叫「重新學習」（`C-309`：以前叫人按不存在的「重新索引」）
      if (!chunk.embedding) {
        throw createError({ statusCode: 400, statusMessage: '這條知識還沒學好，請先按「重新學習」' })
      }
      update.status = 'indexed' satisfies KnowledgeChunkStatus
      update.expiredAt = FieldValue.delete()
      // 期限已過而使用者按「啟用」= 想重新上架 → 順手清掉舊期限，避免排程馬上又關回去
      const untilMs = typeof chunk.activeUntil?.toMillis === 'function' ? chunk.activeUntil.toMillis() : 0
      if (untilMs && untilMs <= Date.now() && activeUntilTs === undefined) {
        update.activeUntil = FieldValue.delete()
      }
    }
  }

  /**
   * 解鎖要真的生效（`C-308`②）：以前只清這一條的鎖，可是試算表同步看到「表格沒變」就整份跳過——
   * 鎖解了、這條還是停在後台改的版本，「有 N 條不會跟著表格更新」也照舊顯示，要等表格別處改過才會換回來。
   * 試算表：把那一份的內容指紋清掉，下一次同步整份比對一次（manualKeptCount 也在那時重算）。
   * 其他種類照 appliesOn 講什麼時候生效（網頁要等下次變動、檔案要等換新版、手寫的沒有來源）。
   */
  let appliesOn: UnlockAppliesOn | undefined
  let sheetToRecompare: DocumentReference | null = null
  if (hasClearLock) {
    update.manuallyEditedAt = null
    let sourceType = ''
    if (chunk.sourceId) {
      const sourceRef = db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(String(chunk.sourceId))
      const sourceSnap = await sourceRef.get()
      const src = sourceSnap.exists ? sourceSnap.data() as { workspaceId?: string, type?: string } : undefined
      if (src?.workspaceId === workspaceId) {
        sourceType = String(src.type ?? '')
        if (sourceType === 'gsheet') sheetToRecompare = sourceRef
      }
    }
    appliesOn = unlockAppliesOn(sourceType)
  }

  if (activeUntilTs !== undefined) {
    update.activeUntil = activeUntilTs === null ? FieldValue.delete() : activeUntilTs
    if (activeUntilTs && activeUntilTs.toMillis() > Date.now()) {
      // 日期改到未來：若這張是「到期自動停用」的卡 → 視為重新上架。
      // ⛔沒有向量的卡不能標 indexed（與上面「啟用」那條同一道守門）：
      // 到期排程現在對 failed 卡也寫 disabled，所以「內容改過→重算失敗→到期下架」的卡
      // 會落在這條路上；標 indexed 的話畫面顯示可用、檢索卻永遠撈不到（findNearest 需要向量），
      // 而 retry 只撈 pending/failed → 沒有任何機制救得回來的殭屍卡。
      if (status === 'disabled' && chunk.expiredAt && body?.enabled !== false) {
        if (!chunk.embedding) {
          throw createError({ statusCode: 400, statusMessage: '這條知識還沒學好，請先按「重新學習」再延長期限' })
        }
        update.status = 'indexed' satisfies KnowledgeChunkStatus
        update.expiredAt = FieldValue.delete()
      }
    }
  }

  await ref.update(update)
  // ⚠️ 先解鎖再清指紋：反過來的話，中間剛好跑一輪同步會「整份比對、這條還鎖著、指紋又寫回去」，解鎖照樣不生效
  if (sheetToRecompare) {
    await sheetToRecompare.update({ contentHash: '', updatedAt: FieldValue.serverTimestamp() })
  }
  const after = (await ref.get()).data() as any

  /*
   * 稽核（`C-254`）：這支管的是「這張卡要不要給 AI 用」與「用到哪一天」。
   * ⭐ 停用一張卡的症狀跟刪掉一模一樣（AI 就是不再拿它回答），所以一樣要留紀錄。
   * ⚠️ `clearManualLock` 解鎖之後，來源的版本會**蓋回這一條**——那是人手改過的內容會消失的那條路，
   *    ⛔ 一定要寫進備註，而且照資料種類講什麼時候會蓋（`C-308`②）。
   */
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'knowledge.settings',
    targetId: chunkId,
    before: { cardStatus: String(chunk.status ?? ''), activeUntil: auditTimeText(chunk.activeUntil) },
    after: { cardStatus: String(after?.status ?? ''), activeUntil: auditTimeText(after?.activeUntil) },
    note: appliesOn
      ? `${String(chunk.title ?? '')}：${UNLOCK_NOTE[appliesOn]}`
      : String(chunk.title ?? ''),
  }, db)

  return {
    id: chunkId,
    status: String(after?.status ?? '') as KnowledgeChunkStatus,
    activeUntilMs: typeof after?.activeUntil?.toMillis === 'function' ? after.activeUntil.toMillis() : 0,
    expiredAtMs: typeof after?.expiredAt?.toMillis === 'function' ? after.expiredAt.toMillis() : 0,
    /** 有帶 clearManualLock 才有：解鎖之後什麼時候換回來源的版本，畫面照這個講（`C-308`②） */
    ...(appliesOn ? { appliesOn } : {}),
  }
})
