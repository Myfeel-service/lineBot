import { v4 as uuidv4 } from 'uuid'
import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { addTagsToUser, removeTagsFromUser } from '~~/server/utils/tagging'
import { TAG_DISCOVERY_COLLECTION } from '~~/server/utils/tag-discovery'
import {
  DISCOVERY_CATEGORY_COLORS,
  HISTORY_SAMPLE_NAMES,
  MANUAL_DISCOVERY_MIN_GAP_MS,
  MAX_DISCOVERY_HISTORY,
  MAX_DISMISSED_NAMES,
  normalizeTagName,
  sanitizeTagCode,
  TAG_MERGE_UNDO_SUBCOLLECTION,
  type TagMergeUndoDoc,
  type TagDiscoveryDecision,
  type TagDiscoveryDecisionAction,
  type TagDiscoveryDoc,
  type TagDiscoveryProposal,
} from '~~/shared/tag-discovery'
import type { TagDoc } from '~~/shared/types/tag-broadcast'

/**
 * POST /api/tag/discovery — 對一條「AI 發現的新標籤」提案做決定
 *
 * Body: { action: 'adopt' | 'dismiss' | 'undo-dismiss' | 'rescan', proposalId?: string }
 *
 * adopt＝建立標籤（aiMode 一律 'suggest'＝先建議，同範本原則：跑準了再自行升 auto）
 *        ＋直接幫「聊過這個主題的那批客人」貼上（sourceType 'ai'，tagLogs 有紀錄、可撤）。
 *        貼這批人不再逐一問過：他們就是提案的證據本身（真的聊過才進名單）。
 * dismiss＝從收件匣移除並記進 dismissedNames——之後的掃描永不再提（含同義）。
 * undo-dismiss＝把某條「忽略」的否決票撤回，讓這個主題有機會再被提（見下方函式的註解）。
 *
 * 三種都會留下一筆決策紀錄（`history`）——老闆 08-28：「之前建議的紀錄要保留，
 * 也要保留當時的決策是建立還是不要建立」。⛔ 紀錄跟「從 pending 移除」寫在同一個
 * transaction 裡：分兩次寫的話，中間掛掉就會出現「提案不見了、也沒有人決定過」的黑洞。
 *
 * ⛔ 提案的認領走 transaction：兩個管理員同時按「建立」，只有一個成功，
 *    否則同一個主題會長出兩顆同名標籤。
 */
export default defineEventHandler(async (event) => {
  const { uid, workspaceId, token } = await requireWorkspaceAccess(event, 'agent')

  const body = await readBody(event)
  const action = String(body?.action ?? '')
  const db = getDb()
  const docRef = db.collection(TAG_DISCOVERY_COLLECTION).doc(workspaceId)

  /**
   * 「立即掃描一次」（D-30②）：只做標記，由 cron（10 分鐘一輪）撿走。
   * ⛔ 不同步跑：掃描要讀兩百多場對話＋一次 LLM，塞進 HTTP 請求會撞閘道逾時
   *   （preview-chunks 那次的前例）。
   * ⛔ 有最小間隔地板：這顆按鈕會花錢，連點就是成本槓桿。
   */
  if (action === 'rescan') {
    const snap = await docRef.get()
    const doc = (snap.data() ?? null) as TagDiscoveryDoc | null
    const lastTouchMs = Math.max(Number(doc?.lastScanMs ?? 0), Number(doc?.rescanRequestedMs ?? 0))
    if (lastTouchMs && Date.now() - lastTouchMs < MANUAL_DISCOVERY_MIN_GAP_MS) {
      // ⛔ 回 200＋queued:false，不要回 4xx：這不是錯誤，是「剛掃過、不用再掃」
      return { queued: false, reason: 'too_soon', minGapMs: MANUAL_DISCOVERY_MIN_GAP_MS }
    }
    await docRef.set({
      workspaceId,
      rescanRequestedMs: Date.now(),
      updatedAt: FieldValue.serverTimestamp(),
      ...(snap.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
    }, { merge: true })
    return { queued: true }
  }

  const proposalId = String(body?.proposalId ?? '').trim()

  /**
   * 取消忽略（`C-94`）：把否決票撤回。
   *
   * ⛔ **不會把提案放回收件匣**，因為放不回去——決策紀錄刻意不存 `userDocIds`
   * （50 筆 × 幾百個 id 會把文件推向 1MB 上限），沒有名單的提案按「建立」會幫 0 位客人
   * 貼上，比不能還原更糟。所以這裡做的是「讓這個主題重新有資格被提」：
   * 下次掃描時如果還有夠多客人在聊，它會自己回來（聊的人散掉了就不會，這是誠實的結果）。
   */
  if (action === 'undo-dismiss') {
    const done = await db.runTransaction(async (tx) => {
      const snap = await tx.get(docRef)
      const doc = (snap.data() ?? null) as TagDiscoveryDoc | null
      const history = Array.isArray(doc?.history) ? doc!.history : []
      const entry = history.find(h => h.id === proposalId && h.action === 'dismiss' && !h.undoneAtMs)
      if (!entry) return false

      // 名字比對走 normalize：否決名單存的是原樣，而「在看 除濕機」跟「在看除濕機」是同一個
      const key = normalizeTagName(entry.name)
      const dismissed = Array.isArray(doc?.dismissedNames) ? doc!.dismissedNames : []
      tx.set(docRef, {
        dismissedNames: dismissed.filter(n => normalizeTagName(n) !== key),
        // ⛔ 不刪這筆紀錄：這個決定發生過、也被推翻過，兩件事都是紀錄的一部分
        history: history.map(h => (h.id === entry.id ? { ...h, undoneAtMs: Date.now() } : h)),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true })
      return true
    })

    if (!done) throw createError({ statusCode: 404, statusMessage: '找不到這筆忽略紀錄（可能已經取消過了）' })
    return { undone: true }
  }

  /**
   * ══ 解除合併（`C-180`）════════════════════════════════════════
   *
   * 為什麼非有不可：按下「改貼到現有標籤」之後，那個主題名會**永久**進「不再建議」名單
   * （不記的話下週同一條原封不動回來）。少了這條路，併錯了就再也叫不回來——
   * 我自己加的一道單向門。知識庫那邊的產品名合併早就有「解除」，這裡要跟上。
   *
   * 兩種力道，因為是兩個不同的後悔：
   *  · `unmerge`＝整件事推翻：把**這次合併貼上的那幾位**身上的標籤摘掉 ＋ 放回可再提。
   *  · `unblock`＝只放回可再提，**標籤留在客人身上**（「併得沒錯，但這主題值得單獨開一顆」）。
   *
   * ⛔ 兩者記在**不同欄位**：合成一欄的話，「標籤到底還在不在那些人身上」就看不出來了。
   * ⛔ `unblock` 不吃掉 `unmerge`：放回可再提之後仍然可以改變主意把標籤拉回來。
   */
  if (action === 'unmerge' || action === 'unblock') {
    if (!proposalId) throw createError({ statusCode: 400, statusMessage: '需要 proposalId' })

    const snap = await docRef.get()
    const doc = (snap.data() ?? null) as TagDiscoveryDoc | null
    const history = Array.isArray(doc?.history) ? doc!.history : []
    const entry = history.find(h => h.id === proposalId && h.action === 'merge')
    if (!entry) throw createError({ statusCode: 404, statusMessage: '找不到這筆合併紀錄' })
    if (action === 'unmerge' && entry.unmergedAtMs) {
      throw createError({ statusCode: 409, statusMessage: '這筆合併已經解除過了' })
    }

    /**
     * 先摘標籤再寫紀錄。
     * ⛔ 順序不能反：先把紀錄標成「已解除」、摘標卻失敗的話，畫面會說解除完成、
     * 標籤其實還在那些人身上，而且按鈕已經消失＝再也修不回來。
     */
    let removed = 0
    let missing = 0
    if (action === 'unmerge') {
      const undoSnap = await docRef.collection(TAG_MERGE_UNDO_SUBCOLLECTION).doc(proposalId).get()
      const undo = (undoSnap.data() ?? null) as TagMergeUndoDoc | null
      /**
       * ⛔ 沒有還原資料就**不要假裝解除成功**：那是合併當時那份小文件沒寫成
       * （或這筆是這個功能上線前併的）。摘 0 位卻回「已解除」＝畫面說謊。
       */
      if (!undo || !Array.isArray(undo.userDocIds)) {
        throw createError({
          statusCode: 409,
          statusMessage: '這筆合併沒有留下還原資料（可能是這個功能上線前併的），只能到好友頁手動把標籤拿掉',
        })
      }
      const targetTagId = String(undo.tagId || entry.tagId || '')
      for (let i = 0; i < undo.userDocIds.length; i += 10) {
        const chunk = undo.userDocIds.slice(i, i + 10)
        const results = await Promise.all(chunk.map(userDocId =>
          removeTagsFromUser(userDocId, [targetTagId], 'ai', `tag-discovery:unmerge:${proposalId}`, workspaceId)
            .then(r => r.removed.length)
            .catch((e) => { console.warn('[tag-discovery] unmerge failed:', userDocId, e); return -1 }),
        ))
        for (const n of results) {
          if (n > 0) removed += n
          // 0＝那位身上早就沒有這顆了（有人手動摘掉／標籤被刪）；-1＝這位出錯了
          else missing += 1
        }
      }
    }

    const done = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(docRef)
      const freshDoc = (fresh.data() ?? null) as TagDiscoveryDoc | null
      const freshHistory = Array.isArray(freshDoc?.history) ? freshDoc!.history : []
      const target = freshHistory.find(h => h.id === proposalId && h.action === 'merge')
      if (!target) return false

      // 兩種力道都會把名字放回「可以再被提」（名字比對走 normalize，同 undo-dismiss）
      const key = normalizeTagName(target.name)
      const dismissed = Array.isArray(freshDoc?.dismissedNames) ? freshDoc!.dismissedNames : []
      const stamp = action === 'unmerge' ? { unmergedAtMs: Date.now() } : { unblockedAtMs: Date.now() }
      tx.set(docRef, {
        dismissedNames: dismissed.filter(n => normalizeTagName(n) !== key),
        // ⛔ 不刪這筆紀錄：這個決定發生過、也被推翻過，兩件事都是紀錄的一部分
        history: freshHistory.map(h => (h.id === proposalId ? { ...h, ...stamp } : h)),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true })
      return true
    })
    if (!done) throw createError({ statusCode: 404, statusMessage: '找不到這筆合併紀錄（可能剛被同事處理過）' })

    // ⛔ 四個數字照實回：摘了幾位、幾位身上本來就沒有了——合起來講會蓋掉「有人手動動過」
    return action === 'unmerge'
      ? { unmerged: true, removed, missing, name: entry.name }
      : { unblocked: true, name: entry.name }
  }

  if ((action !== 'adopt' && action !== 'dismiss' && action !== 'merge') || !proposalId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'action(adopt|merge|dismiss|undo-dismiss|rescan) 與 proposalId 必填',
    })
  }

  /**
   * `merge`＝改貼到既有標籤（`C-178`）。目標標籤要**先驗過再認領提案**：
   * ⛔ 順序反過來的話，標籤 id 是錯的（已刪／別的工作區）時，提案已經從收件匣摘走了
   * ——那條建議連同它的客人名單就這樣消失，而且什麼都沒貼到。
   */
  let mergeTarget: { id: string; name: string } | null = null
  if (action === 'merge') {
    const targetId = String(body?.tagId ?? '').trim()
    if (!targetId) throw createError({ statusCode: 400, statusMessage: 'merge 要帶 tagId（要貼到哪一顆）' })
    const targetSnap = await db.collection('tags').doc(targetId).get()
    if (!targetSnap.exists || targetSnap.data()?.workspaceId !== workspaceId) {
      throw createError({ statusCode: 404, statusMessage: '找不到要貼上的那顆標籤（可能剛被刪掉）' })
    }
    mergeTarget = { id: targetId, name: String(targetSnap.data()?.name ?? '') }
  }

  // ── 認領：transaction 內把提案從 pending 摘走，同時留下決策紀錄 ──────
  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef)
    const doc = (snap.data() ?? null) as TagDiscoveryDoc | null
    const pending = Array.isArray(doc?.pending) ? doc!.pending : []
    const target = pending.find(p => p.id === proposalId)
    if (!target) return null

    const history = Array.isArray(doc?.history) ? doc!.history : []
    const patch: Record<string, unknown> = {
      pending: pending.filter(p => p.id !== proposalId),
      history: [...history, toDecision(target, action, uid, token?.email)].slice(-MAX_DISCOVERY_HISTORY),
      updatedAt: FieldValue.serverTimestamp(),
    }
    /**
     * `merge` 也要記進否決名單（`C-178`）。
     *
     * ⛔ 少了這一步，這個主題下週會**原封不動再被提一次**：掃描的排除名單只認
     * 「既有標籤名」與「否決過的名」，而「在看無線麥克風」併進「在看收音麥克風」之後，
     * 前者這個名字從來沒有變成標籤、也沒有被否決過——於是同一條建議每週回來一次，
     * 而每次按下去的正確動作都是再併一次。收件匣遲早沒人看。
     */
    if (action === 'dismiss' || action === 'merge') {
      // 否決名單 FIFO 上限：塞爆文件比漏擋一個舊主題更糟
      const dismissed = Array.isArray(doc?.dismissedNames) ? doc!.dismissedNames : []
      patch.dismissedNames = [...dismissed, target.name].slice(-MAX_DISMISSED_NAMES)
    }
    tx.set(docRef, patch, { merge: true })
    return target
  })

  if (!claimed) {
    throw createError({ statusCode: 404, statusMessage: '這條建議已被處理過（可能是同事剛按掉了）' })
  }
  if (action === 'dismiss') return { dismissed: true }

  // ── adopt＝建一顆新的；merge＝用既有那顆（上面已驗過存在且同工作區）────
  const tag = mergeTarget ?? await createTagFromProposal(db, workspaceId, uid, claimed)

  // 幫聊過的那批客人貼上。⛔ 單人失敗不整批放棄：貼標是冪等的（addTagsToUser 會略過已存在），
  // 剩下沒貼到的頂多少幾位，比「標籤建了卻回 500」好收拾
  let tagged = 0
  /** merge 專用：這次真的被貼上的人（解除合併就是照這份把標籤摘回來） */
  const mergedUserDocIds: string[] = []
  const userDocIds = Array.isArray(claimed.userDocIds) ? claimed.userDocIds : []
  for (let i = 0; i < userDocIds.length; i += 10) {
    const chunk = userDocIds.slice(i, i + 10)
    const results = await Promise.all(chunk.map(userDocId =>
      /**
       * 來源標成 merge：日後查「這批人怎麼被貼上的」分得出是建新的還是併進來的。
       * ⛔ 併入的記號要**帶提案 id**（`C-180`）：同一顆標籤可能被併進兩次
       * （先「無線麥克風」再「錄音麥克風」），共用一個字串的話解除時分不出是哪一批。
       */
      addTagsToUser(
        userDocId,
        [tag.id],
        'ai',
        action === 'merge' ? `tag-discovery:merge:${claimed.id}` : 'tag-discovery',
        workspaceId,
      )
        .then(r => (r.added.length ? userDocId : null))
        .catch((e) => { console.warn('[tag-discovery] apply failed:', userDocId, e); return null }),
    ))
    for (const userDocId of results) {
      if (userDocId) mergedUserDocIds.push(userDocId)
    }
    tagged += results.filter(Boolean).length
  }

  /**
   * 合併要留還原資料（`C-180`）——「解除合併」唯一的依據。
   *
   * ⛔ 存的是**真的被貼上的那幾位**（`added`），不是提案的全部人：本來就有這顆標籤的
   * 那幾位不是這次合併給的，解除時動他們就是把別人的資料改掉。
   * ⛔ 寫失敗不讓整支 500：標籤已經貼好了，這份只是後悔藥；但要 log，
   * 否則「為什麼這筆沒有解除按鈕」查不出來。
   */
  if (action === 'merge') {
    await docRef.collection(TAG_MERGE_UNDO_SUBCOLLECTION).doc(claimed.id).set({
      workspaceId,
      tagId: tag.id,
      userDocIds: mergedUserDocIds,
      mergedAtMs: Date.now(),
    } satisfies TagMergeUndoDoc).catch(e =>
      console.warn('[tag-discovery] 合併還原資料寫入失敗（這筆將無法解除）:', workspaceId, claimed.id, e))
  }

  /**
   * 把結果補回那筆紀錄（標籤 id 讓畫面連得到名單、實際貼上幾位是事後才知道的數字）。
   *
   * ⛔ 為什麼是「事後補」而不是等結果再一起寫：紀錄必須跟「從 pending 摘走」同一個
   * transaction，否則中間掛掉就是提案消失卻查不到誰處理的。這裡補失敗最多是那筆紀錄
   * 少了標籤連結，決策本身仍然留著——這是兩害相權後刻意選的失敗形狀。
   */
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef)
    const history = Array.isArray((snap.data() as TagDiscoveryDoc | undefined)?.history)
      ? (snap.data() as TagDiscoveryDoc).history! : []
    if (!history.some(h => h.id === claimed.id)) return
    tx.set(docRef, {
      history: history.map(h => (h.id === claimed.id ? { ...h, tagId: tag.id, taggedCount: tagged } : h)),
    }, { merge: true })
  }).catch(e => console.warn('[tag-discovery] history patch failed:', workspaceId, e))

  // ⛔ merge 回 `merged` 不是 `created`：畫面那句 toast 不可以說「已建立」——沒有建立任何東西
  return action === 'merge'
    ? { merged: { id: tag.id, name: tag.name }, tagged, proposed: userDocIds.length }
    : { created: { id: tag.id, name: tag.name }, tagged, proposed: userDocIds.length }
})

/**
 * 提案 → 決策紀錄。
 *
 * ⛔ `userDocIds` 刻意不帶進來（見 shared 的欄位註解）：一條提案掛得到兩百多位客人，
 * 50 筆紀錄就是幾百 KB，會把整份文件推向 1MB 上限、連 pending 都讀不出來。
 * ⛔ `undefined` 不可以進 Firestore（會丟錯）→ email 沒有就整個欄位不放。
 */
function toDecision(
  p: TagDiscoveryProposal,
  action: TagDiscoveryDecisionAction,
  uid: string,
  email?: string,
): TagDiscoveryDecision {
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    criteria: p.criteria,
    usage: p.usage ?? '',
    reason: p.reason ?? '',
    userCount: Array.isArray(p.userDocIds) ? p.userDocIds.length : 0,
    sampleNames: (Array.isArray(p.sampleNames) ? p.sampleNames : []).slice(0, HISTORY_SAMPLE_NAMES),
    proposedAtMs: Number(p.proposedAtMs ?? 0),
    decidedAtMs: Date.now(),
    action,
    decidedBy: uid,
    ...(email ? { decidedByEmail: email } : {}),
  }
}

/** 建立標籤（code 唯一性在這裡守：提案的 code 撞號就加序號，再不行退回隨機尾碼） */
async function createTagFromProposal(
  db: FirebaseFirestore.Firestore,
  workspaceId: string,
  uid: string,
  proposal: TagDiscoveryProposal,
) {
  const base = sanitizeTagCode(proposal.code) || `ai_found_${uuidv4().slice(0, 8)}`
  let code = base
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await db.collection('tags')
      .where('workspaceId', '==', workspaceId)
      .where('code', '==', code)
      .limit(1)
      .get()
    if (existing.empty) break
    code = attempt < 1 ? `${base}_2` : `${base}_${uuidv4().slice(0, 6)}`
  }

  const id = uuidv4()
  const now = FieldValue.serverTimestamp()
  const doc: TagDoc = {
    workspaceId,
    code,
    name: proposal.name,
    category: proposal.category,
    color: DISCOVERY_CATEGORY_COLORS[proposal.category] ?? '#6B7280',
    description: proposal.usage || proposal.reason || '',
    aiMode: 'suggest', // 先建議、人工把關；跑準了老闆自己升 auto（同範本原則）
    aiCriteria: proposal.criteria,
    status: 'active',
    createdBy: uid,
    createdAt: now,
    updatedAt: now,
  }
  await db.collection('tags').doc(id).set(doc)
  return { id, name: proposal.name }
}
