/**
 * AI 回覆的人工回饋事件流 `aiFeedbackEvents` ——「答錯學習」的資料地基。
 *
 * handoff 事件流只涵蓋「AI 自己知道答不出」；「AI 自信地答錯」只有人看得出來。
 * 這裡收兩種訊號：
 *   - wrong_answer：客服在對話頁按「AI 答錯了」——會進知識缺口掃描聚類（比 handoff 更強的訊號，
 *     且帶當時命中的 chunkIds，直接指向該修哪張卡）。
 *   - draft_applied：客服把 AI 建議草稿填入回覆框——採用率是草稿品質的長期指標。
 *
 * 保留期同 aiHandoffEvents（240 天 TTL，expireAt 欄位；TTL policy 兩專案各手動設一次）。
 *
 * `D-135`（2026-10-18）起 wrong_answer 多記「錯在哪」（reason）：只有「資料寫錯」那一種、而且只有客服
 * 選出來的那一條（pickedChunks）會列進知識庫待辦；只有「知識庫沒寫」那一種進缺口聚類。舊標記沒有 reason，兩邊都不算。
 * `D-136`（2026-10-19）：「資料沒錯，是 AI 弄錯了」列在超管「全站異常總覽」、「這題應該交給真人」列在 AI 設定的
 * 敏感詞卡（見 pendingMarks）；處理好了蓋 handledAt。
 */
import { createHash } from 'node:crypto'
import { Timestamp, type Firestore } from 'firebase-admin/firestore'
import { isWrongAnswerReason, type WrongAnswerReason } from '~~/shared/types/ai-knowledge'

export const AI_FEEDBACK_EVENTS_COLLECTION = 'aiFeedbackEvents'

const EVENT_TTL_DAYS = 240
const MAX_QUERY_LEN = 500

export type AiFeedbackType = 'wrong_answer' | 'draft_applied'

export interface AiFeedbackEventInput {
  workspaceId: string
  userId: string
  type: AiFeedbackType
  /** 當時的客人問句（aiMeta.lastQuery） */
  query: string
  /** 當時命中的知識卡（aiMeta.lastSourceChunkIds）——答錯時直接指向該修哪張卡 */
  chunkIds: string[]
  /**
   * 這一次 AI 回合的識別（`aiTurns` 的 doc id）。**新路徑一律帶這個**。
   *
   * 舊做法用 `aiMeta.updatedAt` 的毫秒當識別，代價是「只有最新那一次標得到」：
   * 客人再問一題 aiMeta 就被覆寫，先前標記的 doc id 再也算不出來 → 取消不掉。
   * 綁在回合上就沒有這個問題（回合是 append-only 的，不會被蓋掉）。
   */
  turnId?: string
  /**
   * 舊路徑的識別（aiMeta.updatedAt 毫秒）。turnId 有值時忽略。
   * 保留是為了那些**這功能上線前就送出**、訊息上沒有 aiTurnId 的舊回覆仍標得到。
   */
  interactionAtMs?: number
  /** wrong_answer 才有：錯在哪（`D-135`）。沒有＝2026-10-18 以前的舊標記 */
  reason?: WrongAnswerReason
  /**
   * reason=wrong_data 時，客服選出來「寫錯的那一條」＋標記當下的內容指紋（見 chunkContentFingerprint）。
   * ⛔ 不是 chunkIds（那是當時撈到的全部，AI 不一定用了；以前全部標紅＝把沒錯的也逼人去改）
   */
  pickedChunks?: Array<{ chunkId: string; contentHash: string }>
  /** 誰標的（uid）。以前沒記，事後連「要問誰」都不知道 */
  markedBy?: string
}

/** 這一次回答標過「答錯」了嗎、錯在哪（脈絡卡的兩支端點共用：ai-context、ai-turn） */
export interface WrongMarkState {
  marked: boolean
  /** null＝沒標、或 2026-10-18 以前的舊標記（那時候不問錯在哪） */
  reason: WrongAnswerReason | null
}

export const NOT_MARKED: WrongMarkState = { marked: false, reason: null }

export function wrongMarkOf(snap: { exists: boolean; data(): unknown }): WrongMarkState {
  if (!snap.exists) return NOT_MARKED
  const r = (snap.data() as { reason?: unknown } | undefined)?.reason
  return { marked: true, reason: isWrongAnswerReason(r) ? r : null }
}

/** 知識內容的第一段，壓成一行、最多 40 字（`D-135`：「是哪一條寫錯了？」每條附這一行才選得出來） */
export function chunkSnippet(content: unknown): string {
  const oneLine = String(content ?? '').replace(/\s+/g, ' ').trim()
  return oneLine.length > 40 ? `${oneLine.slice(0, 40)}…` : oneLine
}

/**
 * 一條知識內容的指紋：「標記之後改好了沒」看這個有沒有變（`D-135`）。
 *
 * 以前看 updatedAt：改標題、重新學習、試算表同步都會動到它——10/13 那次同事只改了一個標題，
 * 紅色就全消失了。空白差異不算改（多按一次 Enter 不等於修好）。
 */
export function chunkContentFingerprint(content: unknown): string {
  const normalized = String(content ?? '').replace(/\s+/g, ' ').trim()
  return createHash('sha1').update(normalized).digest('hex').slice(0, 16)
}

type FeedbackKey = Pick<AiFeedbackEventInput, 'workspaceId' | 'userId' | 'type' | 'turnId' | 'interactionAtMs'>

/**
 * 固定 doc id：type + 對話 + 「哪一次」。Firestore doc id 不可含 '/'。
 *
 * 「可以算得出來」是刻意的：後台要能問「這一次標過答錯了嗎」與「把它取消掉」，
 * 兩件事都只需要這個 id，不必另外查詢或再存一份狀態。
 *
 * 「哪一次」優先用 turnId（回合不會被覆寫，舊回合也算得出來）；沒有才退回舊的時間戳規則，
 * 讓上線前標記過的事件仍指得回同一筆（換規則卻不相容＝那些人的取消鈕全部失效）。
 */
export function aiFeedbackDocId(evt: FeedbackKey): string {
  const safeUser = evt.userId.replace(/[^\w-]/g, '_')
  const turnId = String(evt.turnId ?? '').trim()
  if (turnId) return `${evt.type}_${evt.workspaceId}_${safeUser}_t${turnId.replace(/[^\w-]/g, '_')}`
  return `${evt.type}_${evt.workspaceId}_${safeUser}_${evt.interactionAtMs ?? 0}`
}

/**
 * 取消一筆回饋（客服按錯「AI 答錯了」）。
 *
 * 直接刪掉那筆事件就夠：缺口聚類每輪都是重新掃事件流、沒有「已消費」標記
 * （見 ai-knowledge-suggest.ts 的 scanKnowledgeGaps），所以刪掉之後下一輪就不再算它。
 * 已經被聚成建議的那一條不會回頭撤掉——建議本來就要人審核，忽略即可。
 *
 * 回傳是否真的刪到（false = 本來就沒標記過，前端不必當成錯誤）。
 */
export async function deleteAiFeedbackEvent(
  db: Firestore,
  evt: FeedbackKey,
): Promise<boolean> {
  const ref = db.collection(AI_FEEDBACK_EVENTS_COLLECTION).doc(aiFeedbackDocId(evt))
  const snap = await ref.get()
  // 跨租戶保護：doc id 已含 workspaceId，但仍比對欄位，避免將來 id 規則變動時形成破口
  if (!snap.exists) return false
  if (snap.data()?.workspaceId !== evt.workspaceId) return false
  await ref.delete()
  return true
}

/** 一條知識被標「寫錯了」的彙總：被標幾次、最後一次是什麼時候、最後一次標記時的內容指紋 */
export interface WrongAnswerMark {
  count: number
  lastMarkedAtMs: number
  /** 最後一次標記當下的內容指紋；現在的內容跟它一樣＝還沒改 */
  contentHash: string
}

/** 聚合要讀的事件欄位（Firestore 讀回來的樣子） */
export interface WrongAnswerMarkEvent {
  type?: string
  reason?: string
  pickedChunks?: Array<{ chunkId?: string; contentHash?: string }>
  createdAtMs: number
}

/**
 * 把回饋事件聚合成「哪一條知識被標寫錯了幾次」（`D-135`）。
 *
 * 只算 reason=wrong_data、而且客服選了是哪一條的（pickedChunks）。
 * ⛔ 不再拿 chunkIds（當時撈到的全部）來算：以前一次標記就把 5 條全標紅，AI 實際只用了其中一兩條；
 *    正式站標過的 3 次都不是卡寫錯，卻每次都把撈到的那幾條列成「正在答錯客人」。
 * 舊標記（沒有 reason）一律不算——那時候不問錯在哪，算進來就是回到「全部標紅」。
 */
export function aggregateWrongAnswerMarks(
  events: WrongAnswerMarkEvent[],
  sinceMs: number,
): Map<string, WrongAnswerMark> {
  const byChunk = new Map<string, WrongAnswerMark>()
  // 舊到新：同一條被標好幾次時，指紋要留最後一次的（最後一次標的時候那段內容還是錯的）
  const ordered = [...events].sort((a, b) => a.createdAtMs - b.createdAtMs)
  for (const e of ordered) {
    if (e.type !== 'wrong_answer' || e.reason !== 'wrong_data') continue
    if (e.createdAtMs < sinceMs) continue
    for (const p of e.pickedChunks ?? []) {
      const id = String(p?.chunkId ?? '').trim()
      if (!id) continue
      const cur = byChunk.get(id) ?? { count: 0, lastMarkedAtMs: 0, contentHash: '' }
      cur.count++
      cur.lastMarkedAtMs = Math.max(cur.lastMarkedAtMs, e.createdAtMs)
      cur.contentHash = String(p?.contentHash ?? '')
      byChunk.set(id, cur)
    }
  }
  return byChunk
}

/**
 * 這條被標「寫錯了」之後，內容還沒改嗎？（`D-135`：看內容指紋，不看 updatedAt）
 *
 * 「改了就自動離開清單」是刻意的：不另外存一份「已處理」狀態，就不會有「修好了但清單還掛著」的第二種真相。
 * 以前看 updatedAt，改標題、重新學習、試算表同步都算「改過」——10/13 只改了標題，紅色就全消失了。
 * 標記時沒拿到指紋（讀卡失敗）→ 當成還沒改，寧可多掛著也不要假裝修好。
 *
 * 知識庫工作台與右下角小幫手**共用這一支**：兩邊講的必須是同一件事。
 */
export function isChunkUnfixedSinceMark(currentContent: unknown, mark: WrongAnswerMark): boolean {
  if (!mark.contentHash) return true
  return chunkContentFingerprint(currentContent) === mark.contentHash
}

// ── 兩種「記下來了」的標記要有人看（`D-136`，2026-10-19）──────────────────────────────
// 「資料沒錯，是 AI 弄錯了」要我們（平台）修系統 → 超管「全站異常總覽」；
// 「這題應該交給真人」要管理員加敏感詞 → AI 設定的敏感詞卡＋小幫手。
// 以前畫面說「記下來了」，卻沒有任何地方會再出現＝一句做不到的承諾。
// 看過、處理好了就蓋 handledAt；同一次回答重新標記（改選原因）是整筆覆寫，handledAt 跟著消失＝又是一筆待處理。

/** 列「待處理標記」要讀的事件欄位 */
export interface PendingMarkEvent {
  id: string
  workspaceId?: string
  userId?: string
  type?: string
  reason?: string
  query?: string
  createdAtMs: number
  handled: boolean
}

export interface PendingMark {
  id: string
  workspaceId: string
  /** 對話文件 id（開對話用） */
  userId: string
  query: string
  createdAtMs: number
}

function createdAtMsOf(raw: unknown): number {
  if (!raw) return 0
  const v = raw as { toMillis?: () => number; seconds?: number; _seconds?: number }
  if (typeof v.toMillis === 'function') return v.toMillis()
  const sec = v.seconds ?? v._seconds
  return typeof sec === 'number' ? sec * 1000 : 0
}

export function toPendingMarkEvent(doc: { id: string; data(): unknown }): PendingMarkEvent {
  const d = (doc.data() ?? {}) as Record<string, unknown>
  return {
    id: doc.id,
    workspaceId: typeof d.workspaceId === 'string' ? d.workspaceId : undefined,
    userId: typeof d.userId === 'string' ? d.userId : undefined,
    type: typeof d.type === 'string' ? d.type : undefined,
    reason: typeof d.reason === 'string' ? d.reason : undefined,
    query: typeof d.query === 'string' ? d.query : undefined,
    createdAtMs: createdAtMsOf(d.createdAt),
    handled: Boolean(d.handledAt),
  }
}

/** 某一種原因、還沒處理的標記，新的在前 */
export function pendingMarks(events: readonly PendingMarkEvent[], reason: WrongAnswerReason, sinceMs = 0): PendingMark[] {
  return events
    .filter(e => e.type === 'wrong_answer' && e.reason === reason && !e.handled && e.createdAtMs >= sinceMs)
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .map(e => ({
      id: e.id,
      workspaceId: e.workspaceId ?? '',
      userId: e.userId ?? '',
      query: String(e.query ?? '').slice(0, 200),
      createdAtMs: e.createdAtMs,
    }))
}

/**
 * 標成「處理好了」。⛔ 原因要對得上（不能借這支把別種標記收掉）；給了 workspaceId 就要同一個工作區
 * （店家那支一定給；超管那支跨工作區、不給）。回傳是否真的蓋到。
 */
export async function markFeedbackHandled(
  db: Firestore,
  id: string,
  opts: { reason: WrongAnswerReason; workspaceId?: string; uid: string },
): Promise<boolean> {
  const docId = String(id ?? '').trim()
  if (!docId || docId.includes('/')) return false
  const ref = db.collection(AI_FEEDBACK_EVENTS_COLLECTION).doc(docId)
  const snap = await ref.get()
  if (!snap.exists) return false
  const d = snap.data() as { type?: string; reason?: string; workspaceId?: string; handledAt?: unknown }
  if (d.type !== 'wrong_answer' || d.reason !== opts.reason) return false
  if (opts.workspaceId && d.workspaceId !== opts.workspaceId) return false
  if (d.handledAt) return true
  await ref.update({ handledAt: Timestamp.now(), handledBy: opts.uid })
  return true
}

export async function logAiFeedbackEvent(db: Firestore, evt: AiFeedbackEventInput): Promise<void> {
  const now = Timestamp.now()
  await db.collection(AI_FEEDBACK_EVENTS_COLLECTION).doc(aiFeedbackDocId(evt)).set({
    workspaceId: evt.workspaceId,
    userId: evt.userId,
    type: evt.type,
    query: String(evt.query ?? '').slice(0, MAX_QUERY_LEN),
    chunkIds: (evt.chunkIds ?? []).slice(0, 5),
    // ⛔ 沒有就整格不寫（firebase-admin 沒開 ignoreUndefinedProperties，帶 undefined 整筆寫失敗）
    ...(evt.reason ? { reason: evt.reason } : {}),
    ...(evt.pickedChunks?.length ? { pickedChunks: evt.pickedChunks.slice(0, 1) } : {}),
    ...(evt.markedBy ? { markedBy: evt.markedBy } : {}),
    createdAt: now,
    expireAt: Timestamp.fromMillis(now.toMillis() + EVENT_TTL_DAYS * 24 * 60 * 60 * 1000),
  })
}
