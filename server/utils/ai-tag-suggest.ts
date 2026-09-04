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
import { recordTagSuggestionEvents } from './tag-suggestion-log'
import { INACTIVE_TAG_CODE } from './inactive-tag'
import { lineUserFirestoreDocId } from '~~/shared/line-workspace'
import { nextScannerHealth, readScannerHealth } from '~~/shared/scanner-health'
import { recordScannerFailure } from './scanner-health'
import { pickCustomerLines, sessionWindow, type SessionWindow, type TranscriptRow } from '~~/shared/tag-transcript'
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

/**
 * 同一句理由被套到兩顆以上標籤 → 只留第一顆。
 *
 * 為什麼要有：一場最多可以建議 3 顆，模型會為了湊滿而把同一個依據重複用。線上實例——
 * Yangyang 的「問過發票」「在等開賣」「問過出貨進度」三顆，理由是同一句「客人詢問出貨
 * 時間，希望提早出貨」，他從沒提過發票也沒在等開賣（吳崑嶽 4 條有 3 條同款）。
 * 一句話同時是三種不同意圖的依據，本身就是「這是湊的」的訊號。
 *
 * ⛔ 只比對**非空**的理由：理由留空是另一種毛病（沒有依據可看），不該在這裡被順手吃掉，
 *   否則兩個問題混在一起，將來查不出是哪個。
 */
export function dropDuplicateReasons<T extends { reason: string }>(items: T[]): { kept: T[], dropped: T[] } {
  const seen = new Set<string>()
  const kept: T[] = []
  const dropped: T[] = []
  for (const item of items) {
    const key = item.reason.replace(/[\s　。，、．,.!?！？「」『』()（）:：;；-]/g, '').toLowerCase()
    if (key && seen.has(key)) { dropped.push(item); continue }
    if (key) seen.add(key)
    kept.push(item)
  }
  return { kept, dropped }
}

export function buildSuggestPrompt(catalog: TagCatalogItem[], customerLines: string[]): string {
  const tagLines = catalog
    .map(t => `- id: ${t.id}｜名稱: ${t.name}${t.criteria ? `｜判斷條件: ${t.criteria.slice(0, CRITERIA_IN_PROMPT_MAX)}` : ''}`)
    .join('\n')
  return [
    '你是客服系統的顧客分眾助手。下面是「一場 LINE 對話裡客人說過的話」與「可用標籤清單」，判斷這位客人適合貼哪些標籤。',
    '',
    '規則：',
    `- 只能從清單中選，輸出標籤的 id；清單外的一律不要。最多 ${MAX_SUGGESTIONS_PER_SESSION} 個，沒把握就回空陣列。`,
    /**
     * ⛔ 這句取代舊版的「店家（店:）說的話不能當依據」。逐字稿現在只有客人的話
     * （見 pickCustomerLines 的註解），所以要改成「你看不到我們說了什麼，也不要推測」
     * ——留著舊句子會讓模型以為店家的話只是「不能當依據」但仍可參考。
     */
    '- 依據只能是客人自己說出來的需求、意圖、身分。我們（店家、機器人、推播通知）發出去的訊息刻意不放進來，所以你看不到我們說了什麼，也不要憑推測補上。',
    '- 標籤的判斷條件裡寫「…的不算」的排除句，優先於你自己的推論：命中排除句就不要選那顆。',
    `- reason 用一句話（30 字內）寫出依據，給店家看的白話文。**每顆標籤各自寫自己的依據**——同一句理由不可以套在兩顆以上的標籤上（那表示其中一顆是湊的，寧可少選）。`,
    '',
    '可用標籤：',
    tagLines,
    '',
    '客人說過的話（由舊到新）：',
    customerLines.map(t => `客: ${t}`).join('\n'),
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
      /**
       * 這一輪「什麼都沒建議」的原因分類（`C-131`）。
       *
       * ⛔ 為什麼一定要存進資料、不能只寫 log：時間過濾上線後，「這場沒有客人講的話」
       * 從罕見變成常見路徑——沒有這份計數，部署後「建議量掉了」跟「過濾把該有的也濾掉了」
       * 完全分不出來，而當初查出 `C-131` 的那種逐條稽核不可能天天做。
       * 同 `feedback_filters_must_report_what_they_dropped`：三種「沒有」下一步不同，要分型別。
       */
      const skips = { noWindow: 0, tooFewLines: 0, noCandidates: 0, failed: 0 }

      for (const sessDoc of sessSnap.docs) {
        const sess = sessDoc.data()
        batchMaxMs = Math.max(batchMaxMs, tsToMs(sess.lastActivityAt))
        if (!catalog.length) continue // 沒有可建議的標籤，游標照走（別讓佇列卡死）

        /**
         * 這一場的時間範圍——逐字稿只讀這個範圍內的訊息（見 shared/tag-transcript）。
         * ⛔ 算不出範圍就跳過這一場（並記一筆），不可以退回「不限時間」：那就是回到
         *   「翻幾個月前舊帳」的老毛病，而且比原本更寬鬆。
         */
        const win = sessionWindow(sess)
        if (!win) {
          skips.noWindow += 1
          console.warn('[tag-suggest] 這場算不出時間範圍，跳過：', sessDoc.id)
          continue
        }

        // 單場失敗只跳過這一場：建議是錦上添花，卡住整條佇列才是事故
        try {
          const processed = await suggestForSession(db, workspaceId, String(sess.userId ?? ''), sessDoc.id, win, catalog, usage)
          stats.sessions += 1
          stats.suggested += processed.suggested
          stats.autoApplied += processed.autoApplied
          if (processed.skip === 'too_few_lines') skips.tooFewLines += 1
          if (processed.skip === 'no_candidates') skips.noCandidates += 1
        }
        catch (e) {
          skips.failed += 1
          console.warn('[tag-suggest] session failed:', sessDoc.id, e)
        }
      }

      await stateRef.set({
        cursorMs: batchMaxMs,
        /** 最後一輪的成績單（畫面與日後查證都靠它，見上面 skips 的註解） */
        lastRound: {
          atMs: Date.now(),
          sessions: sessSnap.docs.length,
          suggested: stats.suggested,
          autoApplied: stats.autoApplied,
          ...skips,
        },
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true })

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
        /**
         * 走到這裡＝人自己手動貼了 AI 也正在建議的那顆標籤，**這是 AI 判對了**，
         * 只是客服習慣自己加而沒按採用鈕。⛔ 不記的話這些會從分子憑空消失，
         * 採用率被低報成「AI 老是猜不中」。
         */
        const superseded = pending.filter(p => tagIds.includes(p.tagId)).map(p => p.tagId)
        await recordTagSuggestionEvents(db, workspaceId, 'superseded', snap.id, superseded)
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
  /** 這一場的時間範圍；逐字稿只讀這個範圍內的訊息（見 shared/tag-transcript） */
  win: SessionWindow,
  catalog: TagCatalogItem[],
  usage: UsageDelta,
): Promise<{
  suggested: number
  autoApplied: number
  /** 沒產出建議時的原因（呼叫端要分型別計數，不能只當成 0 筆） */
  skip?: 'no_candidates' | 'too_few_lines'
}> {
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
    !tagged.has(t.id) && !dismissed.has(t.id)
    /**
     * ⛔ 「這顆已經在收件匣等人決定」與「收件匣滿了」**都只擋得住「先建議」型**。
     *
     * 拿它們擋 auto 型會**靜靜卡死**：`D-54` 的 13 顆標籤 09-03 先退回「先建議」、
     * 09-04 中午又全部切成「AI 判到直接貼」，於是線上 64 位客人身上留著 116 條
     * 切換前產生的舊建議——那顆標籤現在明明是「判到就貼」，卻因為舊建議還掛在收件匣，
     * AI 每一輪都跳過它。結果是 **AI 不會自己貼、人也沒在按，兩邊都不會發生**，
     * 而畫面上只看得到一個不會減少的「待審 N 位」。
     * 現在的規則：auto 型照判，判到就貼上，並把收件匣那條收掉（見下面 autoIds 那段）。
     */
    && !(t.mode === 'suggest' && (pendingIds.has(t.id) || inboxFull)))
  if (!candidates.length) return { ...none, skip: 'no_candidates' as const }

  /**
   * 逐字稿＝**這一場裡客人說過的話**（規則與踩雷全在 pickCustomerLines 的註解）。
   * ⛔ 查詢照舊只撈最近 30 則、不加時間條件：篩選在記憶體做，讀取數不變也不用新索引。
   */
  const msgSnap = await db.collection('conversations').doc(convDocId)
    .collection('messages')
    .orderBy('timestamp', 'desc')
    .limit(TRANSCRIPT_LIMIT)
    .get()
  const customerLines = pickCustomerLines(
    msgSnap.docs.slice().reverse().map(d => d.data() as TranscriptRow),
    win,
  )

  // 客人至少要講過兩句話才值得花一次 LLM（貼圖問候、單句「謝謝」這種場跳過）
  if (customerLines.length < 2) return { ...none, skip: 'too_few_lines' as const }

  const prompt = buildSuggestPrompt(candidates, customerLines)
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

  /**
   * 順序是 **①白名單（不套上限）→ ②同理由去重 → ③才套上限**。
   *
   * ⛔ 三步不可以換順序：先套上限的話，湊數的重複項會**先佔掉名額**——模型回
   * [A(理由r1) B(r1) C(r1) D(r2)] 時，上限 3 會先砍掉 D（唯一一個依據不同的），
   * 去重再把 B、C 殺掉，最後只剩 A，而正確答案是 A＋D 兩顆。
   * 這是 2026-09-03 自我複審抓到的（第一版就是先砍後去重）。
   */
  const whitelisted = filterSuggestible(
    rawTags.map(t => String(t?.id ?? '')),
    new Set(candidates.map(c => c.id)),
    rawTags.length || 1, // ⛔ 這裡刻意不套 MAX_SUGGESTIONS_PER_SESSION，留給第③步
  )
  const { kept, dropped } = dropDuplicateReasons(
    whitelisted.map(id => ({ id, reason: reasonById.get(id) ?? '' })),
  )
  const accepted = kept.slice(0, MAX_SUGGESTIONS_PER_SESSION).map(k => k.id)

  /**
   * ⛔ 刷掉東西要說得出丟了什麼，而且**兩種丟法要分開講**（`C-68` 同款病）：
   * 只報「同理由丟掉 2 顆」會讓人以為其他都留著，而其實還有一顆是撞上限被砍的。
   */
  const overLimit = kept.length - accepted.length
  if (dropped.length || overLimit > 0) {
    const nameById = new Map(candidates.map(c => [c.id, c.name]))
    const parts = [
      dropped.length
        ? `同一句理由套多顆丟掉 ${dropped.length} 顆（${dropped.map(d => `${nameById.get(d.id) ?? d.id}：「${d.reason}」`).join('、')}）`
        : '',
      overLimit > 0
        ? `撞一場 ${MAX_SUGGESTIONS_PER_SESSION} 顆上限再丟掉 ${overLimit} 顆（${kept.slice(MAX_SUGGESTIONS_PER_SESSION).map(k => nameById.get(k.id) ?? k.id).join('、')}）`
        : '',
    ].filter(Boolean)
    console.warn(`[tag-suggest] ${convDocId} 模型提了 ${rawTags.length} 顆、留下 ${accepted.length} 顆：${parts.join('；')}`)
  }
  if (!accepted.length) return none

  // ── 依標籤的三段設定分流（D-27）────────────────────────
  const modeById = new Map(candidates.map(c => [c.id, c.mode]))
  const autoIds = accepted.filter(id => modeById.get(id) === 'auto')
  const suggestIds = accepted.filter(id => modeById.get(id) !== 'auto')

  // auto：直接貼。sourceType='ai' ＝客人單頁看得出是 AI 貼的、tagLogs 有紀錄、隨時可撤；
  // 週報「這週被貼最多」也吃 tagLogs，貼歪了每週一看得到
  let autoApplied = 0
  /**
   * 這位客人**現在**還在等人決定的建議。auto 貼上後可能會少幾條（見下面），
   * ⛔ 後面寫回收件匣時一律用這一份，不可以再用最上面讀到的 `pending`——
   * 那會把剛剛收掉的那幾條原封不動寫回去（自己造出一個永遠清不掉的待審）。
   */
  let pendingNow = pending
  if (autoIds.length) {
    const { added } = await addTagsToUser(convDocId, autoIds, 'ai', 'ai-tag-suggest:auto', workspaceId)
    autoApplied = added.length
    // 成效底帳只記真的貼上的（added）：冪等略過的那些 AI 沒有真的改變任何事
    if (added.length) {
      await recordTagSuggestionEvents(db, workspaceId, 'auto_applied', convDocId, added, { sessionId })
    }
    /**
     * 這顆先前還掛在收件匣等人按（那時它還是「先建議」）→ 現在 AI 自己貼上了，
     * 那條建議就沒有意義了，要收掉。⛔ 不收的話畫面會一直寫「待審 N 位」，
     * 而它指向的那個決定**已經被系統自己做掉了**——正是這輪要修的那種假待辦。
     * 結局在底帳裡記成 `auto_applied`（上面那筆），不另記 applied：沒有人按過。
     */
    const clearedByAuto = pendingNow.filter(p => added.includes(p.tagId))
    if (clearedByAuto.length) {
      pendingNow = pendingNow.filter(p => !added.includes(p.tagId))
      await sugRef.set({
        pending: pendingNow,
        hasPending: pendingNow.length > 0,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true })
      console.warn(`[tag-suggest] ${convDocId} 收掉 ${clearedByAuto.length} 條舊建議：那幾顆已改成「直接貼」且這次判到，AI 自己貼上了`)
    }
  }

  // suggest：進收件匣（容量再守一次：上面只擋「已滿」，這裡擋「加了會爆」）
  const room = MAX_PENDING_PER_USER - pendingNow.length
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
      pending: [...pendingNow, ...newPending],
      hasPending: true, // pending 的鏡像（列表等值查詢用）——這裡剛加了東西，必為 true
      dismissedTagIds: [...dismissed],
      updatedAt: FieldValue.serverTimestamp(),
      ...(sugSnap.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
    }
    await sugRef.set(docPatch, { merge: true })
    // 「AI 提過幾次」＝採用率的分母。⛔ 記的是真的進了收件匣的（toAdd），
    // 不是模型回來的（accepted）——被收件匣容量擋下來的那些沒人看得到，不該算它判過
    await recordTagSuggestionEvents(db, workspaceId, 'suggested', convDocId, toAdd, { sessionId })
  }
  return { suggested: toAdd.length, autoApplied }
}
