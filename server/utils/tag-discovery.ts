/**
 * AI 發現新標籤——掃描器（規格與紅線見 shared/tag-discovery.ts 檔頭）。
 *
 * 跟 ai-tag-suggest 的分工：那支是「每場對話結束後，從既有標籤挑要不要貼」；
 * 這支是「每週一次，把兩週的對話攤開來看，找還沒有標籤的主題」。
 * 兩支共用同一個開關（autoTagSuggest.enabled）＝「AI 讀對話」的同一份授權，
 * 不另開第二顆開關讓人搞不清楚差別。
 *
 * 成本形狀（08-11 讀取費鐵律逐條對過）：
 * - 每輪（10 分鐘）每個開著的工作區只花 1 次 tagDiscovery 讀取判斷「該不該掃」，
 *   間隔不到 6.5 天就直接走人。
 * - 真的掃：sessions 用游標窗口＋上限（⛔ 不全掃），逐場讀訊息有場數與則數上限，
 *   全部有截斷就 log（不讓「掃不完」被讀成「沒有主題」）。
 * - **一次掃描只打一次 LLM**（不是一場一次），走 runWithLlmBudget 吃月額度。
 */
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore'
import { generateJson, runWithLlmBudget } from './gemini'
import { getAiSettings } from './ai-settings'
import { recordAiUsage, type UsageDelta } from './ai-usage'
import { lineUserFirestoreDocId } from '~~/shared/line-workspace'
import { nextScannerHealth, readScannerHealth } from '~~/shared/scanner-health'
import { recordScannerFailure } from './scanner-health'
import { fetchUserDisplayNames } from './user-display-names'
import { pickCustomerLines, sessionWindow, type TranscriptRow } from '~~/shared/tag-transcript'
import {
  DISCOVERY_INTERVAL_MS,
  DISCOVERY_WINDOW_MS,
  MAX_PENDING_DISCOVERIES,
  MAX_PROPOSALS_PER_SCAN,
  MIN_DISTINCT_USERS,
  pickSampleNames,
  sanitizeDiscoveryProposalsDetailed,
  type DiscoveryScanOutcome,
  type RawDiscoveryTopic,
  type TagDiscoveryDoc,
  type TagDiscoveryProposal,
} from '~~/shared/tag-discovery'
import { randomUUID } from 'node:crypto'

export const TAG_DISCOVERY_COLLECTION = 'tagDiscovery'

/** 一次掃描最多納入幾場對話（兩週窗口內最新的優先；超過就截斷並 log） */
const MAX_SESSIONS_PER_SCAN = 240
/** 一場最多讀幾則訊息（只取客人說的話，見 digest） */
const MESSAGES_PER_SESSION = 20
/** 一場的摘要行長度上限（token 預算：240 行 × ~40 token ≈ 1 萬 input token） */
const DIGEST_LINE_MAX = 160
/** 併發讀訊息的批量（240 場串行要一分多鐘，Lambda 裡等不起） */
const TRANSCRIPT_CONCURRENCY = 8
/** 每條建議存幾位客人的名字當證據（畫面上顯示「包括 A、B 等 N 位」） */
const SAMPLE_NAMES_PER_PROPOSAL = 3
/** 為了湊滿上面那 3 個，要撈幾位候選進來挑（沒設暱稱的 LINE 用戶很常見） */
const SAMPLE_NAME_CANDIDATES = 8

/** 一場對話的摘要：這位客人（在這場）說了什麼 */
interface SessionDigest {
  userDocId: string
  text: string
}

export function buildDiscoveryPrompt(digests: SessionDigest[], excludeNames: string[]): string {
  /**
   * ⛔ 每行要標**這場是第幾位客人**（`C-130` 第二個根因，2026-09-03 自我複審抓到）。
   *
   * 門檻是「至少 4 位**不同客人**」，但先前每行只有 `S0:`、`S1:`——模型完全看不出
   * S4 與 S17 是同一個人，於是列了 7 場以為過關，守門員按客人去重後只剩 3 位，
   * 整條照樣被判 `too_few_users` 丟掉。MYFEEL 兩週 228 場只來自 163 位客人，
   * 這種「同一人多場」是常態不是例外，所以人數要讓模型自己算得出來。
   */
  const userIndex = new Map<string, number>()
  const lines = digests.map((d, i) => {
    if (!userIndex.has(d.userDocId)) userIndex.set(d.userDocId, userIndex.size + 1)
    return `S${i}（客人#${userIndex.get(d.userDocId)}）: ${d.text}`
  }).join('\n')
  const exclude = excludeNames.filter(Boolean).join('、') || '（無）'
  const maxIndex = Math.max(0, digests.length - 1)
  return [
    '你是 LINE 官方帳號的顧客分眾顧問。下面是最近兩週多場客服對話中「客人說過的話」，'
    + '每行一場：`S編號（客人#編號）`——**同一個「客人#」就是同一位客人的不同場對話**。',
    '',
    `任務：找出「很多客人都在聊、但店家還沒有對應標籤」的主題，提出最多 ${MAX_PROPOSALS_PER_SCAN} 個值得建立的新標籤。`,
    '',
    '規則：',
    '- 只提「從對話就看得出來」的意圖、興趣或行為（想買什麼品類、想送禮、問運費、抱怨過…）。會員等級、消費金額這種對話裡看不出來的不要提。',
    '- 粒度是「品類」不是「型號」：提「在看除濕機」，不要提「在看某品牌 6L 除濕機」。',
    `- 每個主題至少要有 ${MIN_DISTINCT_USERS} 位**不同客人**（看「客人#」，同一位客人的多場只算一位）；不夠的不要硬湊。`,
    /**
     * ⛔⛔ 這條與下面範例裡 sessions 的長度**必須撐得過 MIN_DISTINCT_USERS**（2026-09-03）。
     *
     * 線上「一直沒有新標籤」的根因就在這裡：舊版只說「把支持的場次編號列進 sessions」，
     * 而輸出範例寫的是 `"sessions":[0,3,17]`＝**三個**。模型跟的是範例的形狀，於是每次都
     * 只回 3 個編號，被 `sanitizeDiscoveryProposalsDetailed` 判 `too_few_users` 整條丟掉
     * ——9/2 那次掃描「模型提了 3 個、留下 0 個」，三條全是這個死法。
     * 規則與範例互相矛盾時，模型跟的是範例，所以兩邊都要改。
     */
    '- sessions 要列出**所有**支持這個主題的場次編號，不是舉幾個例子：這串數字是我們唯一用來算「幾位不同客人聊過」的依據，列少了整條建議會被判人數不足而丟掉。',
    /**
     * ⛔ 範圍也要講（自我複審抓到）：範例裡的數字若比實際場數大，模型會跟著它的量級寫，
     * 而 `sanitizeDiscoveryProposalsDetailed` 對超出範圍的編號是**默默丟掉**
     * （`ctx.sessionUserIds[Number(s)]` 回 undefined），人數又被無聲扣掉一次。
     */
    `- 場次編號只能用上面真的出現過的（S0 到 S${maxIndex}），不要寫沒出現過的數字。`,
    `- 這些名稱已存在或已被店家否決，不要再提（含同義換句話說）：${exclude}`,
    '- criteria 用「什麼算＋什麼不算」的寫法（80 字內）；usage 一句話講這顆標籤拿來做什麼；reason 一句話講為什麼現在建議（給店家看的白話）。',
    '- code 用英文小寫加底線（例：intent_dehumidifier）。',
    '- 沒有夠強的主題就回空陣列，不要為了湊數而提。',
    '',
    '對話摘要：',
    lines,
    '',
    // ⛔ 範例的 sessions 一定要多於 MIN_DISTINCT_USERS（見上面那條規則的註解），別改回 3 個；
    //    ⛔ 也刻意用小數字——範例的量級會被模型模仿，寫大數字會誘導它產出超出範圍的編號
    '輸出 JSON：{"topics":[{"name":"...","code":"...","category":"interest|behavior|member_status|activity|custom","criteria":"...","usage":"...","reason":"...","sessions":[0,2,5,9,11,14]}]}',
  ].join('\n')
}

function tsToMs(raw: unknown): number {
  const v = raw as { toMillis?: () => number } | null | undefined
  return typeof v?.toMillis === 'function' ? v.toMillis() : 0
}

/**
 * 排程入口（掛 cron/run-tasks）。
 */
export async function scanTagDiscovery(db: Firestore): Promise<{
  workspaces: number
  scanned: number
  proposed: number
}> {
  const stats = { workspaces: 0, scanned: 0, proposed: 0 }
  const wsSnap = await db.collection('workspaces').select().get()

  for (const wsDoc of wsSnap.docs) {
    const workspaceId = wsDoc.id
    try {
      const settings = await getAiSettings(workspaceId, db)
      if (!settings.autoTagSuggest?.enabled) continue
      stats.workspaces += 1

      const docRef = db.collection(TAG_DISCOVERY_COLLECTION).doc(workspaceId)
      const snap = await docRef.get()
      const doc = (snap.data() ?? null) as TagDiscoveryDoc | null
      const lastScanMs = Number(doc?.lastScanMs ?? 0)
      /** 使用者按過「立即掃描一次」而且還沒被消化 → 這一輪跳過間隔閘門 */
      const rescanPending = Number(doc?.rescanRequestedMs ?? 0) > lastScanMs
      const pending = Array.isArray(doc?.pending) ? doc!.pending : []
      const dismissedNames = Array.isArray(doc?.dismissedNames) ? doc!.dismissedNames : []

      // 間隔未到、而且沒有人按「立即掃描」→ 走人（每輪只花上面那 1 次讀取）
      if (!rescanPending && Date.now() - lastScanMs < DISCOVERY_INTERVAL_MS) continue
      // 收件匣滿了就不掃：提了也放不進去，白燒一次 LLM。老闆清掉之後下一輪自然會掃
      if (pending.length >= MAX_PENDING_DISCOVERIES) {
        // ⛔ 但手動要求要消掉：不清的話畫面會**永遠**顯示「已排進佇列，約 10 分鐘內會掃」
        //   （discoveryTiming 判的就是 rescanRequestedMs > lastScanMs），而它其實永遠不會跑。
        if (rescanPending) {
          await docRef.set({ rescanRequestedMs: FieldValue.delete() }, { merge: true })
            .catch(e => console.warn('[tag-discovery] clear rescan marker failed:', workspaceId, e))
        }
        continue
      }

      const result = await scanOneWorkspace(db, workspaceId, pending, dismissedNames)
      stats.scanned += 1
      stats.proposed += result.proposed

      // 這一輪真的跑完了＝健康；先前有記錄在案的失敗才需要寫（清掉）
      const healed = nextScannerHealth(readScannerHealth(doc as unknown as Record<string, unknown>), { ok: true })

      await docRef.set({
        workspaceId,
        pending: [...pending, ...result.proposals],
        dismissedNames,
        lastScanMs: Date.now(),
        /**
         * 這次到底發生什麼事（`C-94`）。⛔ **提 0 個的時候更要寫**：
         * 先前這種情況資料上只留下一個新的 `lastScanMs`，畫面只能講一句
         * 「沒有發現足夠明確的新主題」，跟「壞掉了」分不出來，而老闆連按幾次
         * 「立即掃描」得到的都是同一句話。
         */
        lastScan: result.outcome,
        // 消化掉手動要求（不清的話下一輪會再掃一次，等於一次按鈕掃兩輪）
        ...(rescanPending ? { rescanRequestedMs: FieldValue.delete() } : {}),
        ...(healed ? { health: healed } : {}),
        updatedAt: FieldValue.serverTimestamp(),
        ...(snap.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
      }, { merge: true })
    }
    catch (e) {
      /**
       * ⛔ `C-68` 的教訓：這裡吞掉錯誤是對的（一個工作區壞掉不該拖垮其他人），
       * 但**吞掉之後要留下痕跡**——否則掃描每輪都炸、`lastScanMs` 永遠是 0，
       * 標籤頁那行小字會印「第一次掃描還沒跑」，讀起來像「再等一下」。
       */
      console.warn('[tag-discovery] workspace failed:', workspaceId, e)
      await recordScannerFailure(db.collection(TAG_DISCOVERY_COLLECTION).doc(workspaceId), e)
      /**
       * 🔴 **手動要求一定要在這裡消掉，否則是無限重跑。**
       *
       * 失敗時 `lastScanMs` 與 `rescanRequestedMs` 兩個都沒寫 → 下一輪（10 分鐘後）
       * `rescanPending` 仍然成立，於是**跳過 6.5 天閘門把整包掃描再跑一次**：
       * 撈整批會話 ＋ 打一次 LLM，每 10 分鐘一次、永遠不會停。
       * 這個 repo 有讀取費暴衝的前科（見記憶 `project_firestore_read_cost_20260811`），
       * 而 `C-78` 已經證實這條路真的會 throw（generateJson 遇到 MAX_TOKENS 截斷就丟）。
       *
       * 清掉＝「試過了、失敗了」：失敗本身由 recordScannerFailure 留痕，
       * 標籤頁那條細條會轉成紅色的「一直失敗」，比假裝還在排隊誠實。
       */
      await db.collection(TAG_DISCOVERY_COLLECTION).doc(workspaceId)
        .set({ rescanRequestedMs: FieldValue.delete() }, { merge: true })
        .catch(err => console.warn('[tag-discovery] clear rescan marker failed:', workspaceId, err))
    }
  }

  return stats
}

async function scanOneWorkspace(
  db: Firestore,
  workspaceId: string,
  pending: TagDiscoveryProposal[],
  dismissedNames: string[],
): Promise<{ proposed: number; proposals: TagDiscoveryProposal[]; outcome: DiscoveryScanOutcome }> {
  /** 樣本就不夠的那種「沒有」：連 LLM 都不會打，講「AI 沒找到主題」是不實陳述 */
  const tooFewSessions = (sessionCount: number, userCount: number, truncated = false) => ({
    proposed: 0,
    proposals: [] as TagDiscoveryProposal[],
    outcome: {
      atMs: Date.now(),
      kind: 'too_few_sessions',
      sessionCount,
      userCount,
      rawCount: 0,
      keptCount: 0,
      dropped: [],
      ...(truncated ? { truncated: true } : {}),
    } satisfies DiscoveryScanOutcome,
  })

  /**
   * 窗口＝**固定往前兩週**（不是「上次掃描之後」——那句舊註解跟程式不符，已校正）。
   * 一次 LLM 的量，跟 tag-suggest「不追歷史」的考量不同：那支是一場一次 LLM，追歷史是幾千次。
   *
   * ⛔ **排序必須是 `desc`（取窗口內最新的那批）**，2026-09-03 校正（`C-132`）。
   * 先前是 `asc` ＝取**最舊**的 240 場，而 log 寫「其餘下次掃」——那句是錯的：
   * 下一輪的窗口還是「現在往前兩週」，再取最舊那批，永遠補不到後面那些。
   * MYFEEL 當時兩週內已有 228 場、上限 240，再多一點就會變成「這功能只看得到
   * 兩週前那半段」，而它要回答的正是「客人**現在**在聊什麼」。
   * `(workspaceId, status, lastActivityAt DESC)` 索引已存在＝零新索引。
   */
  const sinceMs = Math.max(Date.now() - DISCOVERY_WINDOW_MS, 0)
  const sessSnap = await db.collection('conversationSessions')
    .where('workspaceId', '==', workspaceId)
    .where('status', '==', 'closed')
    .where('lastActivityAt', '>', Timestamp.fromMillis(sinceMs))
    .orderBy('lastActivityAt', 'desc')
    .limit(MAX_SESSIONS_PER_SCAN)
    .get()
  /**
   * 截斷要**存進資料**，不能只 log（`C-94` 的規則、`C-132` 補的洞）：
   * 畫面只拿 `sessionCount` 的話，「只看了最新 240 場」跟「窗口裡就只有這些」
   * 長得一模一樣，而前者代表這輪的結論本來就不完整。
   */
  const truncated = sessSnap.docs.length >= MAX_SESSIONS_PER_SCAN
  if (truncated) {
    console.warn(`[tag-discovery] ${workspaceId} 窗口內對話超過 ${MAX_SESSIONS_PER_SCAN} 場，只取最新那批（較舊的這輪看不到）`)
  }

  // 客人真的講過話的場才有東西可看。⛔ 撈回來是新→舊，翻成舊→新讓 S0 仍然是最舊的一場
  const sessions = sessSnap.docs
    .slice().reverse()
    .map(d => d.data())
    .filter(s => s.hasInbound !== false && String(s.userId ?? ''))
  if (sessions.length < MIN_DISTINCT_USERS) {
    return tooFewSessions(sessions.length, new Set(sessions.map(s => String(s.userId))).size, truncated)
  }

  // 逐場抽「客人說的話」摘要（分批併發，別串行等一分鐘）
  const digests: SessionDigest[] = []
  for (let i = 0; i < sessions.length; i += TRANSCRIPT_CONCURRENCY) {
    const chunk = sessions.slice(i, i + TRANSCRIPT_CONCURRENCY)
    const results = await Promise.all(chunk.map(async (sess) => {
      const userDocId = lineUserFirestoreDocId(String(sess.userId), workspaceId)
      /**
       * ⛔ **這一場的時間範圍算不出來就跳過這一場**（2026-09-03，`C-132`）。
       *
       * 先前這裡完全沒有時間範圍，直接拿「這位客人最近 20 則」當這一場的摘要，
       * 跟 `C-131` 是同一個 bug 的另一半，而且在這支還多兩個後果：
       * ①**同一位客人在窗口裡有三場，就產出三行一模一樣的摘要**——模型看成三場獨立支持，
       *   守門員再按客人去重成一位，於是判 `too_few_users` 整條丟掉（正是 `C-130` 在追的症狀）。
       *   MYFEEL 兩週 228 場只來自 163 位客人＝約 65 場是這種重複。
       * ②同一批訊息被重複讀（一位客人 N 場就讀 N 次），純浪費讀取費。
       */
      const win = sessionWindow(sess)
      if (!win) return null
      try {
        const msgSnap = await db.collection('conversations').doc(userDocId)
          .collection('messages')
          .orderBy('timestamp', 'desc')
          .limit(MESSAGES_PER_SESSION)
          .get()
        // 只留這一場裡客人打的字（規則與踩雷見 shared/tag-transcript）
        const texts = pickCustomerLines(
          msgSnap.docs.slice().reverse().map(d => d.data() as TranscriptRow),
          win,
        ).filter(t => t.length >= 2)
        if (!texts.length) return null
        const line = texts.join(' / ').slice(0, DIGEST_LINE_MAX)
        return { userDocId, text: line } satisfies SessionDigest
      }
      catch (e) {
        console.warn('[tag-discovery] transcript failed:', userDocId, e)
        return null
      }
    }))
    digests.push(...results.filter((r): r is SessionDigest => !!r))
  }
  const distinctUsers = new Set(digests.map(d => d.userDocId)).size
  if (distinctUsers < MIN_DISTINCT_USERS) return tooFewSessions(digests.length, distinctUsers, truncated)

  // 排除名單＝所有既有標籤名（不分 aiMode——同名就是重複，不管誰在判）＋pending＋否決過的
  const tagSnap = await db.collection('tags').where('workspaceId', '==', workspaceId).get()
  const takenNames = [
    ...tagSnap.docs.map(d => String(d.data()?.name ?? '')),
    ...pending.map(p => p.name),
    ...dismissedNames,
  ].filter(Boolean)

  const prompt = buildDiscoveryPrompt(digests, takenNames)
  const { data, inputTokens, outputTokens } = await runWithLlmBudget(workspaceId, () =>
    generateJson<{ topics?: RawDiscoveryTopic[] }>(prompt, {
      // 跨兩百行摘要做歸納命名，比「從清單挑選」難一階 → 用 flash 不用 lite；一週一次，費用可忽略
      model: 'gemini-2.5-flash',
      temperature: 0,
      // 實測三個提案的輸出約 1,800 字元，1500 tokens 邊界很窄；放寬一級避免偶爾截斷
      // （截斷＝JSON parse 失敗＝這輪整個工作區報錯，代價遠大於多幾個 token）
      maxOutputTokens: 2400,
      /**
       * ⛔⛔ **不要拿掉 thinkingBudget: 0，也不要調高**（2026-08-26 拿真實資料四組對照實測）。
       *
       * 我一度懷疑「0 對『讀 240 行做歸納』太苛，所以才提 0 個」——**方向剛好相反**：
       *   · 保持 0（現況）→ finishReason=STOP，正常提出 3 個主題
       *   · 拿掉 0（給模型思考額度）→ **finishReason=MAX_TOKENS，JSON 被截斷**
       * 而 generateJson 解析失敗會 throw，等於整個工作區這輪掃描報錯。
       * 照那個懷疑去「修」會把本來會動的功能弄壞。
       */
      thinkingBudget: 0,
    }))

  // 背景資料處理桶（import* ⊆ 總量子集慣例，同知識缺口掃描）；⛔ 不記 invocations/answered
  const usage: UsageDelta = {
    importInputTokens: inputTokens,
    importOutputTokens: outputTokens,
    inputTokens,
    outputTokens,
  }
  await recordAiUsage(workspaceId, usage, db).catch(e => console.warn('[tag-discovery] usage record failed:', e))

  const room = MAX_PENDING_DISCOVERIES - pending.length
  const rawTopics = Array.isArray(data?.topics) ? data.topics : []
  const { kept: cleaned, dropped } = sanitizeDiscoveryProposalsDetailed(rawTopics, {
    sessionUserIds: digests.map(d => d.userDocId),
    takenNames,
    maxProposals: Math.min(MAX_PROPOSALS_PER_SCAN, Math.max(0, room)),
  })

  /**
   * 三種「沒有新的」要分得出來，因為下一步完全不同：
   * 樣本太少＝等對話累積（上面已回）／AI 覺得沒主題＝這通常就是正確答案／
   * AI 有提但被擋掉＝可以去看看是不是擋錯了（例如否決名單裡有一條當初按錯的）。
   */
  const outcome: DiscoveryScanOutcome = {
    atMs: Date.now(),
    kind: cleaned.length ? 'proposed' : rawTopics.length ? 'all_filtered' : 'no_topics',
    sessionCount: digests.length,
    userCount: distinctUsers,
    rawCount: rawTopics.length,
    keptCount: cleaned.length,
    dropped,
    ...(truncated ? { truncated: true } : {}),
  }

  /**
   * ⛔ **守門刷掉東西要留下痕跡**（08-26 查「線上為什麼提 0 個」時發現的洞）。
   *
   * 08-25 那次掃描 health 乾淨、`lastScanMs` 也寫了＝**正常跑完**，所以不是壞掉；
   * 模型有回東西，是全部被 `sanitizeDiscoveryProposals` 刷掉了——但當時**一個字都沒記**，
   * 完全無從查起。這是 `C-68` 同一種病（靜靜地什麼都沒說），只是這次發生在守門員身上。
   * 只在「模型有提、但活下來變少」時才 log，正常情況不吵。
   *
   * `C-94` 起原因**同時寫進 `lastScan.dropped`**（畫面看得到），這行 log 留著給
   * 查伺服器紀錄的人——但已經不是唯一的痕跡了。
   */
  if (rawTopics.length !== cleaned.length) {
    console.warn(
      `[tag-discovery] ${workspaceId} 模型提了 ${rawTopics.length} 個、守門後剩 ${cleaned.length} 個`
      + `：${dropped.map(d => `${d.name}(${d.reason})`).join('、') || '（被刷掉的都沒有名稱）'}`,
    )
  }

  /**
   * 每條建議抓幾位客人的名字當證據（掃描時抓一次，見 shared 的欄位註解）。
   *
   * ⛔ 抓 `SAMPLE_NAME_CANDIDATES` 位而不是剛好 3 位：LINE 用戶沒設暱稱是常態
   * （`displayName` 存空字串），前三位剛好都空白的話整條建議會退回「23 位客人聊過」，
   * 證據就這樣默默消失。多抓幾位讓 pickSampleNames 挑得出有名字的。
   * ⛔ 全部提案**合併成一次 getAll**：一條一次是好幾趟來回，而同一位客人出現在
   * 兩條建議裡還會被讀兩次。
   */
  const candidateIds = [...new Set(
    cleaned.flatMap(p => p.userDocIds.slice(0, SAMPLE_NAME_CANDIDATES)),
  )]
  const nameById = await fetchUserDisplayNames(db, candidateIds)

  const proposals: TagDiscoveryProposal[] = cleaned.map(p => ({
    ...p,
    sampleNames: pickSampleNames(
      p.userDocIds.slice(0, SAMPLE_NAME_CANDIDATES).map(id => nameById[id]),
      SAMPLE_NAMES_PER_PROPOSAL,
    ),
    id: randomUUID(), // ⛔ id 是伺服器產的，模型只產內容
    proposedAtMs: Date.now(),
  }))
  return { proposed: proposals.length, proposals, outcome }
}
