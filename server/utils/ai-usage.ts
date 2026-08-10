/**
 * AI 用量統計。這裡有**兩套計數,用途不同,刻意不共用同一把尺**：
 *
 * ① `aiUsage/{workspaceId}_{yyyyMM}` —— **成本報表**。對齊台灣日曆月,讓用量監控頁
 *    能按月比較、對得上財務期間。記 token、次數、轉真人率等所有欄位。
 *
 * ② `quotaUsage/{workspaceId}_{periodStart}` —— **則數額度攔截**。對齊訂閱週期（錨定日）,
 *    只記 answered。換一期 = 換一顆 doc,所以「額度歸零」不需要任何寫入或排程,
 *    也不會出現「月底升級 → 額度被同月份的免費用量吃掉」。
 *
 * 兩者都用 Firestore 原子 increment 避免 race；失敗只 log,不阻塞回覆。
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import { getDb } from './firebase'
import { getWorkspaceSubscription } from './billing'
import { taipeiYyyyMm } from '~~/shared/time'
import type { AiUsageDoc } from '~~/shared/types/ai-knowledge'

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
 * 把 answered 記進「本期」額度桶。週期由訂閱決定（讀取時就地推算,60s 快取）。
 * 訂閱讀不到就跳過——寧可漏記一則,也不要因為記帳失敗而擋掉客人的回覆。
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
  answered?: number
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
   * handoffs 的子集（比照 importInputTokens ⊆ inputTokens 的子集慣例）：
   * 客人一開口就指名真人（「找真人」捷徑，含傳圖後被引導語叫來的）——**AI 根本沒出手**。
   * 沒有這個分項的話，這種「客人偏好」會被算進 AI 的成績單，把自己搞定率往下拉
   * （2026-08-10 實測：90 次轉真人有 13 次是這種）。恆等式不動：仍同時記 handoffs。
   */
  directHandoffs?: number
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
}

/**
 * 把這次 AI 介入的用量記帳：報表月結桶（全部欄位）+ 額度週期桶（只記 answered）。
 * 失敗只 log 不阻塞主流程。
 */
export async function recordAiUsage(
  workspaceId: string,
  delta: UsageDelta,
  db: Firestore = getDb(),
): Promise<void> {
  // answered 同時要記進「本期」額度桶——攔截看的是它,不是月結桶。
  // 兩顆 doc 互不相干,並行寫（這段在回覆路徑上,不該串著等）。
  const quotaWrite = delta.answered
    ? recordQuotaAnswered(workspaceId, delta.answered, db)
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
  if (delta.answered) updates.answered = FieldValue.increment(delta.answered)
  if (delta.handoffs) updates.handoffs = FieldValue.increment(delta.handoffs)
  if (delta.disambiguations) updates.disambiguations = FieldValue.increment(delta.disambiguations)
  if (delta.importInputTokens) updates.importInputTokens = FieldValue.increment(delta.importInputTokens)
  if (delta.importOutputTokens) updates.importOutputTokens = FieldValue.increment(delta.importOutputTokens)
  if (delta.answeredThenHandoffs) updates.answeredThenHandoffs = FieldValue.increment(delta.answeredThenHandoffs)
  if (delta.directHandoffs) updates.directHandoffs = FieldValue.increment(delta.directHandoffs)
  if (delta.followupAnswered) updates.followupAnswered = FieldValue.increment(delta.followupAnswered)
  if (delta.testInputTokens) updates.testInputTokens = FieldValue.increment(delta.testInputTokens)
  if (delta.testOutputTokens) updates.testOutputTokens = FieldValue.increment(delta.testOutputTokens)
  if (delta.testEmbeddingTokens) updates.testEmbeddingTokens = FieldValue.increment(delta.testEmbeddingTokens)
  if (delta.testInvocations) updates.testInvocations = FieldValue.increment(delta.testInvocations)
  if (delta.buildEmbeddingTokens) updates.buildEmbeddingTokens = FieldValue.increment(delta.buildEmbeddingTokens)

  try {
    await Promise.all([ref.set(updates, { merge: true }), quotaWrite])
  }
  catch (e) {
    console.error('[ai-usage] recordAiUsage failed:', e)
  }
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
