import { v4 as uuidv4 } from 'uuid'
import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { addTagsToUser } from '~~/server/utils/tagging'
import { TAG_DISCOVERY_COLLECTION } from '~~/server/utils/tag-discovery'
import {
  DISCOVERY_CATEGORY_COLORS,
  HISTORY_SAMPLE_NAMES,
  MANUAL_DISCOVERY_MIN_GAP_MS,
  MAX_DISCOVERY_HISTORY,
  MAX_DISMISSED_NAMES,
  normalizeTagName,
  sanitizeTagCode,
  type TagDiscoveryDecision,
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

  if ((action !== 'adopt' && action !== 'dismiss') || !proposalId) {
    throw createError({ statusCode: 400, statusMessage: 'action(adopt|dismiss|undo-dismiss|rescan) 與 proposalId 必填' })
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
    if (action === 'dismiss') {
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

  // ── adopt：建標籤 ────────────────────────────────────────────
  const tag = await createTagFromProposal(db, workspaceId, uid, claimed)

  // 幫聊過的那批客人貼上。⛔ 單人失敗不整批放棄：貼標是冪等的（addTagsToUser 會略過已存在），
  // 剩下沒貼到的頂多少幾位，比「標籤建了卻回 500」好收拾
  let tagged = 0
  const userDocIds = Array.isArray(claimed.userDocIds) ? claimed.userDocIds : []
  for (let i = 0; i < userDocIds.length; i += 10) {
    const chunk = userDocIds.slice(i, i + 10)
    const results = await Promise.all(chunk.map(userDocId =>
      addTagsToUser(userDocId, [tag.id], 'ai', 'tag-discovery', workspaceId)
        .then(r => r.added.length)
        .catch((e) => { console.warn('[tag-discovery] apply failed:', userDocId, e); return 0 }),
    ))
    tagged += results.reduce((a, b) => a + b, 0)
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

  return { created: { id: tag.id, name: tag.name }, tagged, proposed: userDocIds.length }
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
  action: 'adopt' | 'dismiss',
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
