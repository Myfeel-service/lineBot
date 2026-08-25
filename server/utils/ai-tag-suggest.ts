/**
 * AI 讀對話自動貼標——建議式（D-24，CRM-EVAL-20260822 P1）。
 *
 * 對話結束後，AI 讀那場對話一次，從工作區**現有的標籤清單**挑 0～3 個建議，
 * 寫進 userTagSuggestions 收件匣；人按「採用」才真的貼（tag-suggestions.post.ts）。
 * 第一版刻意不直接貼：貼錯標籤的下游是「下次推播發錯人」。
 *
 * 成本與安全的設計決定：
 * - **排程批次掃、不掛 webhook**：對話關閉點分散在手動關閉／24h 換場／cron 收殮三處，
 *   掛任何一處都會漏另外兩處；排程用「closed + lastActivityAt 游標」一網打盡
 *   （關閉時 lastActivityAt 會蓋成關閉時間，現有複合索引反向掃即可，零新索引）。
 * - **每場對話最多一次 LLM**（不是每則訊息），走 runWithLlmBudget 吃月額度上限。
 * - **開關剛打開時從「現在」開始**：不追歷史——幾千場舊對話 × 一次 LLM 是純浪費，
 *   而且舊對話的建議品質沒人驗證過。
 * - ⛔ **模型不生 ID**：prompt 只給「還能建議的候選標籤」，回來的 id 再過一次白名單，
 *   清單外的一律丟棄（沿用腳本 AI 生成的鐵律）。
 * - ⛔ **判過的不再重生**：已貼上（userTags）、忽略過（dismissedTagIds）、已在 pending
 *   的都不進候選——否則同一個建議每場對話都回來一次，收件匣永遠清不完。
 * - token 記進 aiUsage 的 import* 分項（背景資料處理桶，同知識缺口掃描的口徑）；
 *   ⛔ 不記 invocations／answered——那是「回答客人」的分母，混進來會把成績單灌水。
 */
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore'
import { generateJson, runWithLlmBudget } from './gemini'
import { getAiSettings } from './ai-settings'
import { addTagsToUser } from './tagging'
import { recordAiUsage, type UsageDelta } from './ai-usage'
import { INACTIVE_TAG_CODE } from './inactive-tag'
import { lineUserFirestoreDocId } from '~~/shared/line-workspace'
import { nextScannerHealth, readScannerHealth } from '~~/shared/scanner-health'
import { recordScannerFailure } from './scanner-health'
import { isCustomerActionMessage } from '~~/shared/customer-action'
import type { UserTagSuggestionDoc, UserTagSuggestionPending } from '~~/shared/types/tag-broadcast'

/** 每輪每工作區最多處理幾場（10 分鐘一輪 ⇒ 一天可消化 ~1,100 場，遠超實際量） */
const SESSIONS_PER_ROUND = 8
/** 每場最多讀幾則訊息進逐字稿 */
const TRANSCRIPT_LIMIT = 30
/** 一場最多建議幾個標籤 */
const MAX_SUGGESTIONS_PER_SESSION = 3
/** 收件匣上限：沒人清就先不加（避免建議越積越多變成沒人看的紅點牆） */
const MAX_PENDING_PER_USER = 5
/** prompt 裡最多放幾個候選標籤（標籤上百的工作區截斷，控 token） */
const MAX_TAGS_IN_PROMPT = 60
/**
 * 每顆標籤的判斷條件放進 prompt 的字數上限。
 *
 * ⛔ **必須等於標籤編輯器 `aiCriteria` 的 maxlength**（app/pages/admin/[workspaceId]/tags.vue）：
 * 先前是 80、輸入框卻讓人打 200 → 認真寫的判斷條件被默默丟掉一半，而畫面一個字都沒講。
 * 讓人打得下的就要全部讀進來，不留隱藏規則。
 */
const CRITERIA_IN_PROMPT_MAX = 200

export const AI_TAG_SUGGEST_SOURCE_REF = 'ai-tag-suggest'

export interface TagCatalogItem {
  id: string
  name: string
  /** AI 的判斷條件（TagDoc.aiCriteria）。⛔ 不是 description——那欄是給團隊看的，AI 不讀 */
  criteria: string
  /** suggest＝進收件匣等人採用；auto＝判到直接貼（TagDoc.aiMode，off 的根本不會進 catalog） */
  mode: 'suggest' | 'auto'
}

/**
 * 白名單過濾（純函式，可測）：模型回來的 tagId 只留「候選集合內、且不重複」的，
 * 並套上限。候選集合本身已排除已貼／忽略／pending——這裡是最後一道防線
 * （模型幻覺出清單外的 id、或同一個 id 回兩次）。
 */
export function filterSuggestible(
  llmTagIds: string[],
  candidateIds: Set<string>,
  max: number = MAX_SUGGESTIONS_PER_SESSION,
): string[] {
  const out: string[] = []
  for (const raw of llmTagIds) {
    const id = String(raw ?? '').trim()
    if (!id || !candidateIds.has(id) || out.includes(id)) continue
    out.push(id)
    if (out.length >= max) break
  }
  return out
}

/** 逐字稿一行的形狀（抽出來讓測試不用碰 Firestore doc） */
export interface TranscriptTurn {
  role: 'customer' | 'shop'
  text: string
}

export function buildSuggestPrompt(catalog: TagCatalogItem[], transcript: TranscriptTurn[]): string {
  const tagLines = catalog
    .map(t => `- id: ${t.id}｜名稱: ${t.name}${t.criteria ? `｜判斷條件: ${t.criteria.slice(0, CRITERIA_IN_PROMPT_MAX)}` : ''}`)
    .join('\n')
  const convoLines = transcript
    .map(t => `${t.role === 'customer' ? '客' : '店'}: ${t.text}`)
    .join('\n')
  return [
    '你是客服系統的顧客分眾助手。根據下面「一場 LINE 對話」與「可用標籤清單」，判斷這位客人適合貼哪些標籤。',
    '',
    '規則：',
    `- 只能從清單中選，輸出標籤的 id；清單外的一律不要。最多 ${MAX_SUGGESTIONS_PER_SESSION} 個，沒把握就回空陣列。`,
    '- 只挑對話裡有明確依據的：客人自己說出來的需求、意圖、身分。店家（店:）說的話不能當依據。',
    '- reason 用一句話（30 字內）寫出依據，給店家看的白話文。',
    '',
    '可用標籤：',
    tagLines,
    '',
    '對話（客: = 客人，店: = 我們）：',
    convoLines,
    '',
    '輸出 JSON：{"tags": [{"id": "...", "reason": "..."}]}',
  ].join('\n')
}

function tsToMs(raw: unknown): number {
  const v = raw as { toMillis?: () => number } | null | undefined
  return typeof v?.toMillis === 'function' ? v.toMillis() : 0
}

/**
 * 排程入口（掛 cron/run-tasks）。回傳統計給排程紀錄。
 */
export async function scanTagSuggestions(db: Firestore): Promise<{
  workspaces: number
  sessions: number
  suggested: number
  autoApplied: number
}> {
  const stats = { workspaces: 0, sessions: 0, suggested: 0, autoApplied: 0 }
  const wsSnap = await db.collection('workspaces').select().get()

  for (const wsDoc of wsSnap.docs) {
    const workspaceId = wsDoc.id
    try {
      const settings = await getAiSettings(workspaceId, db)
      if (!settings.autoTagSuggest?.enabled) continue
      stats.workspaces += 1

      const stateRef = db.collection('cronState').doc(`tag-suggest-${workspaceId}`)
      const stateSnap = await stateRef.get()
      const state = stateSnap.data() as { cursorMs?: number } | undefined
      /**
       * `C-68` 的治本：這支迴圈的 catch 會把錯誤吞掉（單一工作區壞掉不該拖垮其他人），
       * 但吞掉之後畫面上什麼都不會說——缺索引害它每輪都炸、兩天沒人發現。
       * 現在失敗會記在自己的狀態文件上，異常提醒中心讀得到（見 shared/scanner-health.ts）。
       * ⛔ 不可以改用「游標有沒有前進」判斷：追上進度後本來就不會寫入。
       */
      const health = readScannerHealth(stateSnap.data() as Record<string, unknown> | undefined)

      // 開關剛打開：游標定在「現在」，之後結束的對話才進建議。不追歷史（見檔頭）。
      if (!state?.cursorMs) {
        await stateRef.set({ cursorMs: Date.now(), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
        continue
      }

      // 關閉時 lastActivityAt＝關閉時間；(workspaceId, status, lastActivityAt DESC) 索引反向掃
      const sessSnap = await db.collection('conversationSessions')
        .where('workspaceId', '==', workspaceId)
        .where('status', '==', 'closed')
        .where('lastActivityAt', '>', Timestamp.fromMillis(state.cursorMs))
        .orderBy('lastActivityAt', 'asc')
        .limit(SESSIONS_PER_ROUND)
        .get()
      if (sessSnap.empty) continue

      /**
       * 標籤目錄＝**老闆指定要讓 AI 判的那幾顆**（aiMode ∈ suggest/auto），不再是全部標籤。
       *
       * ⛔ D-27 的核心修正：先前拿「所有 active 標籤」當候選，但實務上多數標籤是事件紀錄
       * （問卷-XX、客服-產品型號、活動-XX），AI 從對話裡根本判斷不出「有沒有填過問卷」，
       * 硬猜就是雜訊。缺 aiMode 欄位的舊標籤天然不命中 in 查詢＝預設 off，行為零改變。
       * 候選變少同時讓判斷更穩、prompt 更便宜。
       */
      const tagSnap = await db.collection('tags')
        .where('workspaceId', '==', workspaceId)
        .where('aiMode', 'in', ['suggest', 'auto'])
        .get()
      const catalog: TagCatalogItem[] = tagSnap.docs
        .filter(d => d.data()?.status === 'active' && d.data()?.code !== INACTIVE_TAG_CODE)
        .slice(0, MAX_TAGS_IN_PROMPT)
        .map(d => ({
          id: d.id,
          name: String(d.data()?.name ?? ''),
          criteria: String(d.data()?.aiCriteria ?? ''),
          mode: d.data()?.aiMode === 'auto' ? 'auto' as const : 'suggest' as const,
        }))
        .filter(t => t.name)

      const usage: UsageDelta = {}
      let batchMaxMs = state.cursorMs

      for (const sessDoc of sessSnap.docs) {
        const sess = sessDoc.data()
        batchMaxMs = Math.max(batchMaxMs, tsToMs(sess.lastActivityAt))
        if (!catalog.length) continue // 沒有可建議的標籤，游標照走（別讓佇列卡死）

        // 單場失敗只跳過這一場：建議是錦上添花，卡住整條佇列才是事故
        try {
          const processed = await suggestForSession(db, workspaceId, String(sess.userId ?? ''), sessDoc.id, catalog, usage)
          stats.sessions += 1
          stats.suggested += processed.suggested
          stats.autoApplied += processed.autoApplied
        }
        catch (e) {
          console.warn('[tag-suggest] session failed:', sessDoc.id, e)
        }
      }

      await stateRef.set({ cursorMs: batchMaxMs, updatedAt: FieldValue.serverTimestamp() }, { merge: true })

      if (usage.inputTokens || usage.outputTokens) {
        await recordAiUsage(workspaceId, usage, db).catch(e => console.warn('[tag-suggest] usage record failed:', e))
      }

      // 這一輪走完了＝健康；先前有記錄在案的失敗才需要寫（清掉）
      const healed = nextScannerHealth(health, { ok: true })
      if (healed) await stateRef.set({ health: healed }, { merge: true })
    }
    catch (e) {
      console.warn('[tag-suggest] workspace failed:', workspaceId, e)
      await recordScannerFailure(db.collection('cronState').doc(`tag-suggest-${workspaceId}`), e)
    }
  }

  return stats
}

/**
 * 標籤已經貼上了（不管是誰貼的）→ 把對應的建議從收件匣剪掉。
 *
 * 為什麼一定要有：客服看到建議「VIP」，但他習慣走「管理標籤」自己加——建議會永遠留在
 * 收件匣裡，列表上那顆「AI 建議」琥珀章就變成永不消失的假警報，久了沒人理它。
 * 呼叫點＝所有手動貼標的入口（單人／批次）；採用／忽略那支自己會處理。
 *
 * ⛔ 只在「這些客人真的有待處理建議」時才寫（先讀後寫），否則每次貼標都白寫一筆。
 */
export async function prunePendingForAppliedTags(
  db: Firestore,
  workspaceId: string,
  userDocIds: string[],
  tagIds: string[],
): Promise<number> {
  if (!userDocIds.length || !tagIds.length) return 0
  let pruned = 0
  try {
    for (let i = 0; i < userDocIds.length; i += 300) {
      const refs = userDocIds.slice(i, i + 300).map(id => db.collection('userTagSuggestions').doc(id))
      const snaps = await db.getAll(...refs)
      for (const snap of snaps) {
        if (!snap.exists) continue
        const doc = snap.data() as UserTagSuggestionDoc
        if (doc.workspaceId !== workspaceId) continue
        const pending = Array.isArray(doc.pending) ? doc.pending : []
        const remaining = pending.filter(p => !tagIds.includes(p.tagId))
        if (remaining.length === pending.length) continue
        await snap.ref.set({
          pending: remaining,
          hasPending: remaining.length > 0,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true })
        pruned += pending.length - remaining.length
      }
    }
  }
  catch (e) {
    // 剪枝失敗不該讓貼標本身失敗（標籤已經貼上了才走到這）
    console.warn('[tag-suggest] prune failed:', e)
  }
  return pruned
}

/**
 * 手動移除標籤＝「這位客人不要這顆」，記進 dismissedTagIds 讓 AI 永不再提。
 *
 * ⛔ 沒有這條會出現拉鋸戰：auto 標籤被 AI 貼上 → 客服判斷不對手動拆掉 → 下一場對話
 * AI 又貼回來 → 客服再拆……人永遠贏不了排程。手動移除就是人給的否決票，要記住。
 * （想恢復＝手動貼回去；貼回去之後它已在身上，AI 本來就不會再動它。）
 *
 * 只記「AI 有在判的標籤」（aiMode ∈ suggest/auto）：拆問卷、客服這類 off 標籤
 * 不需要建否決紀錄，別為每次日常移標多寫一份文件。
 * 失敗只記 log——否決票寫不進去不該讓移除本身失敗。
 */
export async function recordManualRemovalAsDismissed(
  db: Firestore,
  workspaceId: string,
  userDocIds: string[],
  tagIds: string[],
): Promise<void> {
  if (!userDocIds.length || !tagIds.length) return
  try {
    // 只留 AI 有在判的標籤
    const tagSnaps = await db.getAll(...[...new Set(tagIds)].map(id => db.collection('tags').doc(id)))
    const aiTagIds = tagSnaps
      .filter(s => s.exists && s.data()?.workspaceId === workspaceId)
      .filter(s => s.data()?.aiMode === 'suggest' || s.data()?.aiMode === 'auto')
      .map(s => s.id)
    if (!aiTagIds.length) return

    for (const userDocId of userDocIds) {
      const ref = db.collection('userTagSuggestions').doc(userDocId)
      const snap = await ref.get()
      const doc = (snap.data() ?? null) as UserTagSuggestionDoc | null
      if (doc && doc.workspaceId !== workspaceId) continue
      const dismissed = new Set(Array.isArray(doc?.dismissedTagIds) ? doc!.dismissedTagIds : [])
      const before = dismissed.size
      aiTagIds.forEach(id => dismissed.add(id))
      // pending 裡若正好掛著同一顆建議，一併清掉（人都拆了，建議再掛著只是雜訊）
      const pending = Array.isArray(doc?.pending) ? doc!.pending : []
      const remaining = pending.filter(p => !dismissed.has(p.tagId))
      if (dismissed.size === before && remaining.length === pending.length) continue
      await ref.set({
        workspaceId,
        userId: userDocId,
        pending: remaining,
        hasPending: remaining.length > 0,
        dismissedTagIds: [...dismissed],
        updatedAt: FieldValue.serverTimestamp(),
        ...(snap.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
      }, { merge: true })
    }
  }
  catch (e) {
    console.warn('[tag-suggest] record manual removal failed:', e)
  }
}

/**
 * 單場處理：組逐字稿 → 算候選 → LLM → 白名單過濾 → 依標籤的三段設定分流
 * （suggest → 收件匣等人採用；auto → 直接貼，來源記 ai）。
 */
async function suggestForSession(
  db: Firestore,
  workspaceId: string,
  lineUserId: string,
  sessionId: string,
  catalog: TagCatalogItem[],
  usage: UsageDelta,
): Promise<{ suggested: number; autoApplied: number }> {
  const none = { suggested: 0, autoApplied: 0 }
  if (!lineUserId) return none
  const convDocId = lineUserFirestoreDocId(lineUserId, workspaceId)

  // 收件匣現況與「永不再提」名單（忽略過＋手動移除過的都在 dismissedTagIds）
  const sugRef = db.collection('userTagSuggestions').doc(convDocId)
  const sugSnap = await sugRef.get()
  const sugDoc = (sugSnap.data() ?? null) as UserTagSuggestionDoc | null
  const pending = Array.isArray(sugDoc?.pending) ? sugDoc!.pending : []
  const inboxFull = pending.length >= MAX_PENDING_PER_USER
  const dismissed = new Set(Array.isArray(sugDoc?.dismissedTagIds) ? sugDoc!.dismissedTagIds : [])
  const pendingIds = new Set(pending.map(p => p.tagId))

  // 已貼上的不再建議（userId 等值查詢，單欄位索引，鍵含租戶前綴天生隔離）
  const taggedSnap = await db.collection('userTags').where('userId', '==', convDocId).get()
  const tagged = new Set(taggedSnap.docs.map(d => String(d.data()?.tagId ?? '')))

  const candidates = catalog.filter(t =>
    !tagged.has(t.id) && !dismissed.has(t.id) && !pendingIds.has(t.id)
    // ⛔ 收件匣滿了只擋「建議型」候選（沒位置放了）；auto 型不進收件匣，不受它牽制——
    //    否則「建議堆著沒人清」會連帶讓全自動標籤也停擺
    && !(inboxFull && t.mode === 'suggest'))
  if (!candidates.length) return none

  // 逐字稿：客人的動作紀錄（「客人點了…」）不是客人說的話，不進逐字稿
  const msgSnap = await db.collection('conversations').doc(convDocId)
    .collection('messages')
    .orderBy('timestamp', 'desc')
    .limit(TRANSCRIPT_LIMIT)
    .get()
  const transcript: TranscriptTurn[] = msgSnap.docs.slice().reverse()
    .map(d => d.data() as { direction?: string; text?: string; messageType?: string })
    .filter(m => !isCustomerActionMessage(m.messageType))
    .map(m => ({
      role: m.direction === 'incoming' ? 'customer' as const : 'shop' as const,
      text: String(m.text ?? '').trim().slice(0, 300),
    }))
    .filter(t => t.text)

  // 客人至少要講過兩句話才值得花一次 LLM（貼圖問候、單句「謝謝」這種場跳過）
  if (transcript.filter(t => t.role === 'customer').length < 2) return none

  const prompt = buildSuggestPrompt(candidates, transcript)
  const { data, inputTokens, outputTokens } = await runWithLlmBudget(workspaceId, () =>
    generateJson<{ tags?: Array<{ id?: string; reason?: string }> }>(prompt, {
      model: 'gemini-2.5-flash-lite', // 從候選清單挑選是簡單任務；建議式有人把關，先用便宜的
      temperature: 0,
      maxOutputTokens: 400,
      thinkingBudget: 0, // 短 JSON 輸出：thinking 會吃掉 output 配額把 JSON 截斷（見 gemini.ts）
    }))

  // 背景資料處理桶（import* ⊆ 總量的子集慣例，同知識缺口掃描）
  usage.importInputTokens = (usage.importInputTokens ?? 0) + inputTokens
  usage.importOutputTokens = (usage.importOutputTokens ?? 0) + outputTokens
  usage.inputTokens = (usage.inputTokens ?? 0) + inputTokens
  usage.outputTokens = (usage.outputTokens ?? 0) + outputTokens

  const rawTags = Array.isArray(data?.tags) ? data.tags : []
  const reasonById = new Map(rawTags.map(t => [String(t?.id ?? '').trim(), String(t?.reason ?? '').trim().slice(0, 60)]))
  const accepted = filterSuggestible(rawTags.map(t => String(t?.id ?? '')), new Set(candidates.map(c => c.id)))
  if (!accepted.length) return none

  // ── 依標籤的三段設定分流（D-27）────────────────────────
  const modeById = new Map(candidates.map(c => [c.id, c.mode]))
  const autoIds = accepted.filter(id => modeById.get(id) === 'auto')
  const suggestIds = accepted.filter(id => modeById.get(id) !== 'auto')

  // auto：直接貼。sourceType='ai' ＝客人單頁看得出是 AI 貼的、tagLogs 有紀錄、隨時可撤；
  // 週報「這週被貼最多」也吃 tagLogs，貼歪了每週一看得到
  let autoApplied = 0
  if (autoIds.length) {
    const { added } = await addTagsToUser(convDocId, autoIds, 'ai', 'ai-tag-suggest:auto', workspaceId)
    autoApplied = added.length
  }

  // suggest：進收件匣（容量再守一次：上面只擋「已滿」，這裡擋「加了會爆」）
  const room = MAX_PENDING_PER_USER - pending.length
  const toAdd = suggestIds.slice(0, Math.max(0, room))
  if (toAdd.length) {
    const newPending: UserTagSuggestionPending[] = toAdd.map(tagId => ({
      tagId,
      reason: reasonById.get(tagId) ?? '',
      sessionId,
      suggestedAtMs: Date.now(),
    }))
    const docPatch: Partial<UserTagSuggestionDoc> = {
      workspaceId,
      userId: convDocId,
      pending: [...pending, ...newPending],
      hasPending: true, // pending 的鏡像（列表等值查詢用）——這裡剛加了東西，必為 true
      dismissedTagIds: [...dismissed],
      updatedAt: FieldValue.serverTimestamp(),
      ...(sugSnap.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
    }
    await sugRef.set(docPatch, { merge: true })
  }
  return { suggested: toAdd.length, autoApplied }
}
