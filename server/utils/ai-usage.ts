/**
 * AI 用量統計。這裡有**兩套計數,用途不同,刻意不共用同一把尺**：
 *
 * ① `aiUsage/{workspaceId}_{yyyyMM}` —— **成本報表**。對齊台灣日曆月,讓用量監控頁
 *    能按月比較、對得上財務期間。記 token、次數、轉真人率等所有欄位。
 *
 * ② `quotaUsage/{workspaceId}_{periodStart}` —— **則數額度攔截**。對齊訂閱週期（錨定日）,
 *    只記計費則數。換一期 = 換一顆 doc,所以「額度歸零」不需要任何寫入或排程,
 *    也不會出現「月底升級 → 額度被同月份的免費用量吃掉」。
 *
 * ⛔ **`billable`（要扣客人額度嗎）與 `answered`（AI 自己答完了嗎）是兩件事,不要合併。**
 *    2026-09-07 `D-69` 拍板「反問澄清也算一則」之後兩者正式分家：反問要扣額度（billable）
 *    但**不是**「答完了」（answered）——混用的話，要嘛反問收不到錢、要嘛 AI 表現頁的
 *    「自己搞定率」被反問灌水。桶 ① 記 answered 看品質，桶 ② 記 billable 收錢。
 *
 * 兩者都用 Firestore 原子 increment 避免 race；失敗只 log,不阻塞回覆。
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import { getDb } from './firebase'
import { getWorkspaceSubscription } from './billing'
import { GEMINI_MODEL_PRICES } from './ai-cost-buckets'
import { AI_BUDGET_ERROR_REASON } from './ai-usage-calls'
import { capMapSize } from './bounded-cache'
import { aiCallsTowardCeiling } from '~~/shared/billing/call-ceiling'
import { taipeiYyyyMm } from '~~/shared/time'
import { aiBudgetMessage, aiBudgetResumeLabel } from '~~/shared/ai-budget'
import type { AiBudgetKind, AiCostBucketId, AiModelTokenCounts, AiUsageDoc } from '~~/shared/types/ai-knowledge'

export const AI_USAGE_COLLECTION = 'aiUsage'
export const QUOTA_USAGE_COLLECTION = 'quotaUsage'

// 月結桶用台灣時區（台灣固定 UTC+8、無 DST）。月中切換與 UTC 同鍵,故當月用量 doc
// 不斷檔;僅月底 8 小時邊界改依台灣時間歸月。
export function currentYyyyMm(date = new Date()): string {
  return taipeiYyyyMm(date)
}

function usageDocId(workspaceId: string, yyyyMm: string): string {
  return `${workspaceId}_${yyyyMm}`
}

function quotaDocId(workspaceId: string, periodStart: string): string {
  return `${workspaceId}_${periodStart}`
}

/** 本期（訂閱週期）已用則數 —— 額度攔截與方案卡進度條都看這個數字。 */
export async function getQuotaAnswered(
  workspaceId: string,
  periodStart: string,
  db: Firestore = getDb(),
): Promise<number> {
  const snap = await db.collection(QUOTA_USAGE_COLLECTION).doc(quotaDocId(workspaceId, periodStart)).get()
  return snap.exists ? Number(snap.data()?.answered ?? 0) : 0
}

/**
 * 把**計費則數**記進「本期」額度桶。週期由訂閱決定（讀取時就地推算,60s 快取）。
 * 訂閱讀不到就跳過——寧可漏記一則,也不要因為記帳失敗而擋掉客人的回覆。
 *
 * doc 裡的欄位仍叫 `answered`（沿用既有資料,額度桶每期換一顆、不必回填），
 * 但語意自 2026-09-07 起是「計費則數」＝答出 ＋ 反問，不含「答不出轉真人」。
 */
async function recordQuotaAnswered(workspaceId: string, answered: number, db: Firestore): Promise<void> {
  try {
    const sub = await getWorkspaceSubscription(workspaceId, db)
    if (!sub?.currentPeriodStart) return
    await db.collection(QUOTA_USAGE_COLLECTION).doc(quotaDocId(workspaceId, sub.currentPeriodStart)).set({
      workspaceId,
      periodStart: sub.currentPeriodStart,
      periodEnd: sub.currentPeriodEnd,
      planId: sub.planId,
      answered: FieldValue.increment(answered),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
  }
  catch (e) {
    console.error('[ai-usage] recordQuotaAnswered failed:', e)
  }
}

export interface UsageDelta {
  inputTokens?: number
  outputTokens?: number
  embeddingTokens?: number
  invocations?: number
  /**
   * **要扣客人幾則額度**（唯一驅動 quotaUsage 額度桶的欄位）。
   *
   * 2026-09-07 `D-69` 拍板的口徑：AI 出手回答一次算一則，**反問澄清也算**，
   * 只有「這題我不確定，幫你請真人回覆」不算。2026-10-19 `D-132` 補齊沒講到的幾種。
   * 所以它跟 {@link answered} 不同——**每一種回覆扣不扣**（改的時候這張表要一起改）：
   *
   *   | 客人收到的                                   | 記帳                                              | 扣則 |
   *   |----------------------------------------------|---------------------------------------------------|------|
   *   | AI 答出                                      | `answered: 1, billable: 1`                        | 扣   |
   *   | AI 反問（含出貨題「請問是哪一個商品」`C-344`） | `disambiguations: 1, billable: 1`（沒有 answered） | 扣   |
   *   | 反問後客人點選項、AI 答出                     | `followupAnswered: 1, billable: 1`                | 扣   |
   *   | 寒暄（謝謝→不客氣、你好、再見）              | `answered: 1, billable: 1`                        | 扣（`D-132`②） |
   *   | 問的商品不在清單（「目前的商品資料裡沒有…」） | `answered: 1, billable: 1`                        | 扣（`D-132`②） |
   *   | 出貨時程題直接答（`C-343`）                    | `answered: 1, billable: 1`                        | 扣   |
   *   | 跟本店無關、AI 婉拒（「超出範圍」那句）       | `answered: 1, unbilledAnswered: 1`                | **不扣**（`D-132`②：其實就是答不出來） |
   *   | 答不出轉真人／敏感詞／AI 壞掉                  | `handoffs: 1`                                     | 不扣（對外的賣點） |
   *   | 額度用完、或這個月 AI 被叫太多次（`C-8`）被擋下 | `handoffs: 1, quotaBlocked: 1`                    | 不扣 |
   *   | 查他那一筆訂單：先送一般規則、再轉真人        | `handoffs: 1`                                     | 不扣（`D-132`①：結局是轉真人） |
   *   | 客人指名「找真人」                            | `handoffs: 1, directHandoffs: 1`                  | 不扣 |
   *   | 客人只傳照片：AI 讀圖、問「想了解什麼」＋猜的按鈕 | `disambiguations: 1, billable: 1`（在 handler）  | 扣（`D-132`③，照反問算） |
   *   | 只傳照片但 AI 猜不出、或額度用完（只問一句不附猜的按鈕） | 不記次數（讀圖只記 token）              | 不扣 |
   *   | 客人只丟訂單資料，機器人問「想詢問什麼」（`D-133`） | 不記（不是 AI）                              | 不扣 |
   *   | 讀圖寫給客服看的說明、轉真人摘要、意圖分類   | 只記 token                                        | 不扣 |
   *   | playground 測試                               | 一律不帶（測試不該扣客人的錢）                    | 不扣 |
   *
   *   反問後的答出：次數欄位刻意不計避免品質率灌水，但**錢照收**——客人確實拿到了答案。
   *
   * ⛔ 別把它接回 `answered`：那顆是品質指標，動它會讓 AI 表現頁的「自己搞定率」失真。
   */
  billable?: number
  answered?: number
  /**
   * `answered` 之中**不扣則**的那幾次（`D-132`②）：跟本店無關、AI 婉拒回答的那句。
   * 品質那邊它仍是「AI 自己收尾」（answered＋handoffs＋disambiguations＝invocations 的恆等式不動），
   * 錢這邊不收。answerWithAi 看到它就不補 billable；`monthlyBillable()` 還原整月時要扣掉它。
   */
  unbilledAnswered?: number
  handoffs?: number
  disambiguations?: number
  /**
   * 匯入 / 整理（切卡、normalize）的 token 分項。**同時也要計入 inputTokens/outputTokens**
   * （quota 以總量計），這兩個欄位只是讓報表能區分「答題」與「匯入」的成本。
   */
  importInputTokens?: number
  importOutputTokens?: number
  /** AI answered 後 30 分鐘內客人又被轉真人 — 品質 proxy（回答沒解決問題） */
  answeredThenHandoffs?: number
  /**
   * 小幫手「提議了一個操作」幾次（`C-31` Phase 2）。
   * 與 {@link agentExecuted} 成對，是目前唯一看得出「它提得準不準」的訊號——
   * 提很多次卻很少被按確定＝它在亂提議，那比「它不會做事」更糟（會訓練人不看就按取消）。
   * ⛔ 兩個都記在後台自用的那一側：這不是客人用掉的東西。
   */
  agentProposed?: number
  /** 使用者按了確定、而且真的執行成功幾次 */
  agentExecuted?: number
  /**
   * handoffs 的子集（比照 importInputTokens ⊆ inputTokens 的子集慣例）：
   * 客人一開口就指名真人（「找真人」捷徑，含傳圖後被引導語叫來的）——**AI 根本沒出手**。
   * 沒有這個分項的話，這種「客人偏好」會被算進 AI 的成績單，把自己搞定率往下拉
   * （2026-08-10 實測：90 次轉真人有 13 次是這種）。恆等式不動：仍同時記 handoffs。
   */
  directHandoffs?: number
  /**
   * handoffs 的子集（同 {@link directHandoffs} 的子集慣例）：額度用完、或這個月 AI 被叫太多次（`C-8` 呼叫上限）
   * 被擋下來，**AI 沒出手**就轉真人的那幾次。恆等式不動：仍同時記 invocations 與 handoffs。
   *
   * 為什麼要分出來：呼叫上限數的是「AI 真的被叫了幾次」（`aiCallsTowardCeiling`）。不扣掉這幾次的話，
   * 則數用完那段期間每則訊息都還在累積次數，訂閱換期、則數歸零之後，這個月的次數早就被灌過上限——
   * AI 一恢復就又以「被叫太多次」停下來，店家看到的原因是錯的。只從 2026-10-20 部署後起算。
   */
  quotaBlocked?: number
  /**
   * 「先問清楚」（反問澄清）之後客人點選、AI 成功答出來的次數。
   * followup 路徑刻意不記 invocations/answered（避免灌水），代價是反問的成果全隱形——
   * 這顆補回「反問到底有沒有用」的能見度。只從部署後起算。
   */
  followupAnswered?: number
  /**
   * 測試對話（playground / 內部測試）的 token —— 獨立記帳，不併進上方真客人 token。
   * 讓成本報表能把真客人與測試分開；測試不計次數/率，故只有 token 分項。
   */
  testInputTokens?: number
  testOutputTokens?: number
  testEmbeddingTokens?: number
  /** 後台自用觸發次數：playground 試打 ＋ 後台小幫手對話（與真客人 invocations 分開記）。 */
  testInvocations?: number
  /**
   * 知識庫「建索引」的 embedding（reindex / bulk-create / 逐卡 index）——屬「建置成本」，
   * 跟客人查詢的 query embedding 分開記。不算進客人對話成本，但仍是工作區真實花費
   * （故仍計入 token 護欄 getCurrentMonthTokens）。切卡/整理的 LLM 花費另由 importInput/OutputTokens 記。
   */
  buildEmbeddingTokens?: number
  /**
   * 整理知識庫那桶（import 進出＋建索引向量）裡，**背景工作**用掉的部分（`C-413`）：AI 貼標建議、標籤發現、
   * 知識缺口掃描。子集慣例同 importInputTokens ⊆ inputTokens——只拿來拆每月上限的帳，算錢照舊。
   * ⛔ 不要手寫：一律用 `ai-usage-calls.ts` 的 `asBackgroundUsage` 包，它從同一筆的整理桶數字算出來。
   */
  backgroundTokens?: number
  /**
   * 後台自用那桶（test*）裡，**被「後台自用」那本帳擋的那幾件**用掉的部分（`C-414`）：小幫手、擬推播文案、
   * 圖文選單底圖、節慶建議。子集慣例同上；測試對話、AI 產生腳本這些沒被擋的不算進來（數了卻不擋＝擋錯人）。
   * ⛔ 不要手寫：一律用 `ai-usage-calls.ts` 的 `asAssistUsage` 包。
   */
  assistTokens?: number
  /**
   * 生成 token 照模型拆的明細（`D-130`②）：上面那幾個總數的**子集**，算錢時照各模型單價。
   * ⛔ 不要手寫：一律用 `ai-usage-calls.ts` 的 `usageFromCalls` 產生，它保證總數與明細寫在同一桶、數字一致。
   */
  modelTokens?: Partial<Record<AiCostBucketId, AiModelTokenCounts>>
}

const COST_BUCKETS: readonly AiCostBucketId[] = ['conversation', 'build', 'test']

/** 模型明細 → Firestore 的巢狀 increment（只收認得的桶與模型 key，其他丟掉） */
function modelTokenIncrements(mt: UsageDelta['modelTokens']): Record<string, unknown> | null {
  if (!mt) return null
  const out: Record<string, Record<string, Record<string, FieldValue>>> = {}
  for (const bucket of COST_BUCKETS) {
    const byModel = mt[bucket]
    if (!byModel) continue
    for (const [key, t] of Object.entries(byModel)) {
      if (!(key in GEMINI_MODEL_PRICES)) continue
      const inc: Record<string, FieldValue> = {}
      const i = Number(t?.input ?? 0) || 0
      const o = Number(t?.output ?? 0) || 0
      if (i > 0) inc.input = FieldValue.increment(i)
      if (o > 0) inc.output = FieldValue.increment(o)
      if (Object.keys(inc).length) (out[bucket] ??= {})[key] = inc
    }
  }
  return Object.keys(out).length ? out : null
}

/**
 * 把這次 AI 介入的用量記帳：報表月結桶（全部欄位）+ 額度週期桶（只記 billable）。
 *
 * ⛔ **這支永遠不丟錯**（連 rejected promise 都不會）：記帳失敗只 log，不可以拖垮主流程。
 *    以前 `db` 是預設參數 `getDb()`、算 doc id 也在 try 外面——任何一步出錯都會變成 rejected，
 *    呼叫端沒接 `.catch` 的話就會把一則正常的回覆變成錯誤（2026-10-19 `C-338` 補記帳時一併收進 try）。
 */
export async function recordAiUsage(
  workspaceId: string,
  delta: UsageDelta,
  db?: Firestore,
): Promise<void> {
  // 什麼都沒花（例如這次一個 AI 呼叫都沒發生）就不寫：空寫一次也是一筆資料庫寫入費
  const hasAny = Object.entries(delta ?? {}).some(([k, v]) => k !== 'modelTokens' && typeof v === 'number' && v !== 0)
  if (!hasAny) return
  try {
    await writeAiUsage(workspaceId, delta, db ?? getDb())
  }
  catch (e) {
    console.error('[ai-usage] recordAiUsage failed:', e)
  }
}

async function writeAiUsage(workspaceId: string, delta: UsageDelta, db: Firestore): Promise<void> {
  // 額度桶只吃 billable（不是 answered）——攔截看的是它,不是月結桶。
  // 兩者的差別見 UsageDelta.billable 的說明；⛔ 改回 answered 會讓反問白做工、
  // 或讓「AI 自己答完的比率」被反問灌水,兩邊都錯。
  // 兩顆 doc 互不相干,並行寫（這段在回覆路徑上,不該串著等）。
  const quotaWrite = delta.billable
    ? recordQuotaAnswered(workspaceId, delta.billable, db)
    : Promise.resolve()

  const yyyyMm = currentYyyyMm()
  const ref = db.collection(AI_USAGE_COLLECTION).doc(usageDocId(workspaceId, yyyyMm))
  const updates: Record<string, unknown> = {
    workspaceId,
    period: yyyyMm,
    updatedAt: FieldValue.serverTimestamp(),
  }
  if (delta.inputTokens) updates.inputTokens = FieldValue.increment(delta.inputTokens)
  if (delta.outputTokens) updates.outputTokens = FieldValue.increment(delta.outputTokens)
  if (delta.embeddingTokens) updates.embeddingTokens = FieldValue.increment(delta.embeddingTokens)
  if (delta.invocations) updates.invocations = FieldValue.increment(delta.invocations)
  if (delta.agentProposed) updates.agentProposed = FieldValue.increment(delta.agentProposed)
  if (delta.agentExecuted) updates.agentExecuted = FieldValue.increment(delta.agentExecuted)
  // 計費則數也進月結桶：額度桶每期換一顆、只回答得了「這一期用了多少」，
  // 但成本／超管報表要按月看「這個月收了幾則」。兩顆桶各記各的，不互相推算。
  if (delta.billable) updates.billable = FieldValue.increment(delta.billable)
  if (delta.answered) updates.answered = FieldValue.increment(delta.answered)
  if (delta.unbilledAnswered) updates.unbilledAnswered = FieldValue.increment(delta.unbilledAnswered)
  if (delta.handoffs) updates.handoffs = FieldValue.increment(delta.handoffs)
  if (delta.disambiguations) updates.disambiguations = FieldValue.increment(delta.disambiguations)
  if (delta.importInputTokens) updates.importInputTokens = FieldValue.increment(delta.importInputTokens)
  if (delta.importOutputTokens) updates.importOutputTokens = FieldValue.increment(delta.importOutputTokens)
  if (delta.answeredThenHandoffs) updates.answeredThenHandoffs = FieldValue.increment(delta.answeredThenHandoffs)
  if (delta.directHandoffs) updates.directHandoffs = FieldValue.increment(delta.directHandoffs)
  if (delta.quotaBlocked) updates.quotaBlocked = FieldValue.increment(delta.quotaBlocked)
  if (delta.followupAnswered) updates.followupAnswered = FieldValue.increment(delta.followupAnswered)
  if (delta.testInputTokens) updates.testInputTokens = FieldValue.increment(delta.testInputTokens)
  if (delta.testOutputTokens) updates.testOutputTokens = FieldValue.increment(delta.testOutputTokens)
  if (delta.testEmbeddingTokens) updates.testEmbeddingTokens = FieldValue.increment(delta.testEmbeddingTokens)
  if (delta.testInvocations) updates.testInvocations = FieldValue.increment(delta.testInvocations)
  if (delta.buildEmbeddingTokens) updates.buildEmbeddingTokens = FieldValue.increment(delta.buildEmbeddingTokens)
  if (delta.backgroundTokens) updates.backgroundTokens = FieldValue.increment(delta.backgroundTokens)
  if (delta.assistTokens) updates.assistTokens = FieldValue.increment(delta.assistTokens)
  // 巢狀 map ＋ merge:true＝只動到有寫的那幾格（其他模型、其他桶的明細不會被蓋掉）
  const modelTokens = modelTokenIncrements(delta.modelTokens)
  if (modelTokens) updates.modelTokens = modelTokens

  await Promise.all([ref.set(updates, { merge: true }), quotaWrite])
}

/** `billable` 欄位開始被寫入的月份（`D-69` 上線於 2026-09-07，故 2026-09 是跨口徑的那個月）。 */
export const BILLABLE_FIELD_SINCE = '202609'

/**
 * 從月結桶讀「這個月計費幾則」。
 *
 * ⚠️ `billable` 這個欄位是 2026-09-07（`D-69`）才開始寫的，分三段處理：
 *
 * 1. **`D-69` 之前的月份** → 回 `answered`。那是**正確的歷史值**，不是湊數：當時計費口徑
 *    就是「答出才算」，兩個數字本來就相等。⛔ 不要為此回填舊資料（回填等於偽造當時的帳）。
 * 2. **2026-09（跨口徑那個月）** → `billable` 只從 9/7 起算，直接讀它會少掉月初那幾天
 *    （實測 myfeel：billable=18，整月照新口徑其實是 62）。改用分項還原整月——
 *    依 {@link UsageDelta.billable} 的規則，`billable ≡ answered + disambiguations + followupAnswered`。
 * 3. **之後的月份** → 分項和 ≤ `billable`（「反問後客人點選項、AI 又反問一次」只記 billable，
 *    沒有對應的分項欄位），所以 `Math.max` 會自動選 `billable`，這裡不必再改一次。
 *
 * ⚠️ 分項和要扣掉 `unbilledAnswered`（`D-132`②，2026-10-19 起：跟本店無關、AI 婉拒的那句記 answered 但不扣則）。
 *    不扣的話分項和會比 billable 多，`Math.max` 就把不收錢的那幾句又算回去。
 */
export function monthlyBillable(
  data: { billable?: number; answered?: number; unbilledAnswered?: number; disambiguations?: number; followupAnswered?: number; period?: string } | undefined | null,
): number {
  if (!data) return 0
  const answered = Number(data.answered ?? 0)
  const period = String(data.period ?? '')
  if (period && period < BILLABLE_FIELD_SINCE) return answered
  const derived = Math.max(0, answered - Number(data.unbilledAnswered ?? 0))
    + Number(data.disambiguations ?? 0) + Number(data.followupAnswered ?? 0)
  return Math.max(Number(data.billable ?? 0), derived)
}

/**
 * 本月「呼叫／答出」兩個計數（超管 C-91/C-7 高成本比警示用）。
 * 一次點讀月結桶；沒有文件＝這個月還沒有任何 AI 活動，回兩個 0。
 */
export async function getCurrentMonthUsageCounts(
  workspaceId: string,
  db: Firestore = getDb(),
): Promise<{ invocations: number, answered: number, billable: number }> {
  const snap = await db.collection(AI_USAGE_COLLECTION).doc(usageDocId(workspaceId, currentYyyyMm())).get()
  // 整包丟給 monthlyBillable：它要 disambiguations / followupAnswered / period 才還原得出
  // 跨口徑月份的則數（少帶欄位會靜靜地少算，不會報錯）。
  const d = snap.data() as Partial<AiUsageDoc> | undefined
  return {
    invocations: Number(d?.invocations ?? 0),
    answered: Number(d?.answered ?? 0),
    billable: monthlyBillable(d),
  }
}

/**
 * 呼叫上限（`C-8`）的次數快取：每則客人訊息都要看一次，不快取就是每則多一次點讀。
 * 60 秒（同訂閱、維運上限的快取）：次數這個月只會往上加，舊 60 秒頂多讓「停下來」晚一分鐘，
 * 不會讓已經停的又放行。鍵帶月份——跨月那一刻直接換一格，不會拿上個月的數字擋這個月。
 */
const AI_CALLS_CACHE_MS = 60_000
const aiCallsCache = new Map<string, { expiresAt: number; calls: number }>()

/** 測試用：清掉呼叫次數快取 */
export function invalidateAiCallsCache() {
  aiCallsCache.clear()
}

/**
 * 這個月（台北日曆月）AI 真的被叫了幾次——呼叫上限的分子（`aiCallsTowardCeiling`：扣掉指名真人、被額度擋下的）。
 * 讀月結桶，60 秒快取。讀失敗會丟錯，由呼叫端決定 fail-open（護欄那邊一律當 0）。
 */
export async function getCurrentMonthAiCalls(
  workspaceId: string,
  db: Firestore = getDb(),
): Promise<number> {
  const yyyyMm = currentYyyyMm()
  const key = usageDocId(workspaceId, yyyyMm)
  const cached = aiCallsCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.calls
  const snap = await db.collection(AI_USAGE_COLLECTION).doc(key).get()
  const calls = aiCallsTowardCeiling(snap.exists ? (snap.data() as Partial<AiUsageDoc>) : null)
  aiCallsCache.set(key, { expiresAt: Date.now() + AI_CALLS_CACHE_MS, calls })
  capMapSize(aiCallsCache, 2000)
  return calls
}

/**
 * 本月已用 token 總數（input + output + embedding）。
 *
 * 只在「沒有則數上限」時才會被讀（enterprise 客製未設額度 / 訂閱讀取失敗）——
 * 那種帳號沒有則數可擋,token 護欄是唯一煞車。有則數額度的帳號不讀這個,
 * 否則會在遠低於所購則數處被固定的 token cap 提早切斷。
 */
export async function getCurrentMonthTokens(
  workspaceId: string,
  db: Firestore = getDb(),
): Promise<number> {
  const yyyyMm = currentYyyyMm()
  const ref = db.collection(AI_USAGE_COLLECTION).doc(usageDocId(workspaceId, yyyyMm))
  const snap = await ref.get()
  if (!snap.exists) return 0
  const data = snap.data() as Partial<AiUsageDoc>
  // 建索引 embedding 已改記 buildEmbeddingTokens；仍是真實花費，token 護欄要算回來（測試 test* 不算）。
  return Number(data?.inputTokens ?? 0) + Number(data?.outputTokens ?? 0)
    + Number(data?.embeddingTokens ?? 0) + Number(data?.buildEmbeddingTokens ?? 0)
}

// ═══════════════════════════════════════════════════════════════════
//  維運（匯入/切卡/OCR/自動套用/embedding）的月度花費上限——C-45 額度收口
//
//  背景：全系統原本唯一的額度閘門在「回答客人」路徑上；匯入 30 份掃描 PDF、
//  整站 50 頁、常變網頁開自動套用……全部不受任何限制，額度燈一路綠。
//  這裡給維運桶一個「防失控」的硬上限：不是計費（計費照舊賣則數），
//  是煞車——正常使用碰不到，失控（迴圈重試、惡意灌檔）才會撞上。
//
//  執行點收口在 gemini.ts 單一出口（runWithLlmBudget 圈起來的呼叫都會查），
//  未來新功能只要在最外層圈一次，就自動被守住——「忘了加檢查」從此絕種。
//
//  `C-413`（2026-10-29）拆成三本帳（AiBudgetKind）：以前只有一本，數的是整理知識庫那整桶、
//  擋的是所有圈起來的呼叫。那桶裡有 AI 貼標建議、標籤發現、知識缺口掃描這些「客人聊越多用越多」的
//  背景工作，於是生意好的店家會在沒加資料的月份被說「加太多」，撞到時小幫手、擬推播文案也一起停。
//  現在每本帳只數自己、只擋自己（圈的時候要講是哪一本，見 gemini.ts 的 runWithLlmBudget）。
// ═══════════════════════════════════════════════════════════════════

/**
 * 預設維運月上限（import LLM + 建索引 embedding 合計 token）＝「店家加資料」那本。
 * 量級：正常一份 100k 字文件整套切卡+embedding ≈ 20 萬 token；20M ≈ 100 份/月，
 * 一般商家碰不到、失控迴圈會撞上。要調整就改這裡（或日後開 per-workspace 欄位）。
 * ⚠️ 方案分級（`D-157`③）等真實店家資料再定：MYFEEL 最忙的月份（2026-09）整理桶才 75 萬。
 */
export const DEFAULT_MAINTENANCE_TOKEN_CAP = 20_000_000

/**
 * 三本帳各自的上限。背景與後台自用目前沒有實測依據，先跟店家那本同一個量級——
 * 只是防失控的煞車，正常使用碰不到。
 */
export const AI_BUDGET_CAPS: Record<AiBudgetKind, number> = {
  knowledge: DEFAULT_MAINTENANCE_TOKEN_CAP,
  background: 20_000_000,
  assist: 20_000_000,
}

type BudgetCounts = {
  importInputTokens: number
  importOutputTokens: number
  buildEmbeddingTokens: number
  backgroundTokens: number
  assistTokens: number
}

/**
 * 某一本帳這個月用了多少（純函式，給測試直接驗口徑）。
 *   knowledge  ＝ 整理桶（import 進出＋建索引向量）扣掉背景那份
 *   background ＝ backgroundTokens（整理桶的子集）
 *   assist     ＝ assistTokens（後台自用桶的子集：只有圈在這本裡的那幾件）
 * `C-413` 上線前的舊資料沒有 backgroundTokens：整桶都算店家那本（寧可多算，上限遠高於實際用量）。
 * ⛔ assist 不可以數整個後台自用桶（`C-414`）：那桶還有測試對話、AI 產生腳本、小幫手確認後的操作——
 *    都沒有被這本擋，數進來的話店家在測試對話多聊幾句，小幫手、擬文案就跟著停，測試對話卻照跑。
 */
export function aiBudgetUsed(data: Partial<AiUsageDoc> | null | undefined, kind: AiBudgetKind): number {
  const n = (v: unknown) => Math.max(0, Number(v ?? 0) || 0)
  if (kind === 'background') return n(data?.backgroundTokens)
  if (kind === 'assist') return n(data?.assistTokens)
  const build = n(data?.importInputTokens) + n(data?.importOutputTokens) + n(data?.buildEmbeddingTokens)
  return Math.max(0, build - n(data?.backgroundTokens))
}

/** 快取 60 秒：批次 embedding 每卡查一次額度會把讀取費燒在守門上，得不償失。存原始數字，一次讀三本帳都夠用 */
const maintBudgetCache = new Map<string, { expiresAt: number; counts: BudgetCounts }>()

/** 測試用：清掉快取 */
export function invalidateMaintenanceBudgetCache(workspaceId?: string) {
  if (workspaceId) maintBudgetCache.delete(workspaceId)
  else maintBudgetCache.clear()
}

/** 本月某一本帳的已用量；不指定就是「店家加資料」那本（以前唯一的那本） */
export async function getMaintenanceBudgetStatus(
  workspaceId: string,
  db: Firestore = getDb(),
  kind: AiBudgetKind = 'knowledge',
): Promise<{ used: number; cap: number; blocked: boolean; kind: AiBudgetKind }> {
  const cached = maintBudgetCache.get(workspaceId)
  let counts: BudgetCounts
  if (cached && cached.expiresAt > Date.now()) {
    counts = cached.counts
  }
  else {
    const yyyyMm = currentYyyyMm()
    const snap = await db.collection(AI_USAGE_COLLECTION).doc(usageDocId(workspaceId, yyyyMm)).get()
    const data = (snap.exists ? snap.data() : {}) as Partial<AiUsageDoc>
    counts = {
      importInputTokens: Number(data?.importInputTokens ?? 0),
      importOutputTokens: Number(data?.importOutputTokens ?? 0),
      buildEmbeddingTokens: Number(data?.buildEmbeddingTokens ?? 0),
      backgroundTokens: Number(data?.backgroundTokens ?? 0),
      assistTokens: Number(data?.assistTokens ?? 0),
    }
    maintBudgetCache.set(workspaceId, { expiresAt: Date.now() + 60_000, counts })
  }
  const used = aiBudgetUsed(counts, kind)
  const cap = AI_BUDGET_CAPS[kind]
  return { used, cap, blocked: used >= cap, kind }
}

/** 擋下來時講的話搬到 shared（`C-414`）：資料頁、標籤頁要在讀的當下組「幾號恢復」。這裡轉出去給既有的呼叫端 */
export { aiBudgetMessage, aiBudgetResumeLabel }

/**
 * 某一本帳超過上限就丟 429（給入口端點與 gemini 出口共用）；不指定就是「店家加資料」那本。
 * 訊息寫給店家看：發生什麼、影響什麼、什麼時候恢復。
 */
export async function assertMaintenanceBudget(
  workspaceId: string,
  db: Firestore = getDb(),
  kind: AiBudgetKind = 'knowledge',
): Promise<void> {
  const s = await getMaintenanceBudgetStatus(workspaceId, db, kind)
  if (!s.blocked) return
  const msg = aiBudgetMessage(kind)
  throw createError({
    statusCode: 429,
    statusMessage: `${msg.title}。${msg.body}`,
    data: { reason: AI_BUDGET_ERROR_REASON, kind },
  })
}
