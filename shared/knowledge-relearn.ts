/**
 * AI 沒學會的知識怎麼講、什麼時候才給「再試一次」（`D-129`，2026-10-19 老闆「按你建議」）。
 *
 * 為什麼：學失敗的那幾條，排程每 10 分鐘自己再試（`retryStuckChunks`，最多 5 次），畫面卻在失敗當下就叫店家去按「重新學習」——
 * 操作紀錄裡全平台店家按過 0 次，紅字＋按鈕只會讓他以為要自己處理，而系統本來就會修好。現在分兩段：
 *  · 還在自動再試的（`isAutoRetrying`）：只講「AI 還沒學會，系統會自己再試」，⛔ 不給按鈕、不上紅色；
 *  · 試完 5 次還是沒學會的（`isAutoRetryExhausted`）：這時才講原因、給「再試一次」，並講還不行怎麼辦。
 * ⛔ 給店家看的字不再出現「重新學習」這個詞（只有平台超管看得到的「重新學習全部知識（維護用）」例外）。
 * 前端各處、體檢、小幫手、伺服器排程都吃這一份——判斷跟講法只有一份，才不會一處說「系統會再試」、另一處叫他去按。
 */

/**
 * 排程自動重試的上限（**含**第一次失敗那一次）。伺服器的 `MAX_AUTO_RETRIES` 就是這一個。
 * 失敗一次 `retryCount` +1（`runIndexOnChunk`），排程只撿 `retryCount < 5` 的；學會了就歸零。
 */
export const KNOWLEDGE_MAX_AUTO_RETRIES = 5

export interface RetryableChunkLike {
  status?: unknown
  retryCount?: unknown
}

export function chunkRetryCount(c: RetryableChunkLike | null | undefined): number {
  const n = Number(c?.retryCount ?? 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 學失敗了、系統還會自己再試（這時候什麼都不用他做） */
export function isAutoRetrying(c: RetryableChunkLike | null | undefined): boolean {
  return c?.status === 'failed' && chunkRetryCount(c) < KNOWLEDGE_MAX_AUTO_RETRIES
}

/** 學失敗了、自動重試也用完了＝要人看一下（這時候才給「再試一次」） */
export function isAutoRetryExhausted(c: RetryableChunkLike | null | undefined): boolean {
  return c?.status === 'failed' && chunkRetryCount(c) >= KNOWLEDGE_MAX_AUTO_RETRIES
}

/**
 * 編輯框上這一條「沒學會」是哪一種、要不要給「再試一次」（`D-129`）：
 *  · retrying：學失敗、系統還會自己再試——只講「系統會自己再試」，⛔ 不給按鈕；
 *  · exhausted：自動重試用完還是沒學會——講原因、給「再試一次」、講還不行怎麼辦；
 *  · disabledNoVector：停用中、上一次學沒成（停用的學失敗時會留原因、不落 failed）——排程不碰停用的，
 *    所以一開始就給「再試一次」（伺服器擋「打開」時那句叫他按的就是這一顆）；
 *  · none：沒事（可用、處理中、等你看過⋯）。
 */
export type ChunkLearnState = 'none' | 'retrying' | 'exhausted' | 'disabledNoVector'

export function chunkLearnState(c: RetryableChunkLike & { failureReason?: unknown } | null | undefined): ChunkLearnState {
  if (c?.status === 'failed') return isAutoRetryExhausted(c) ? 'exhausted' : 'retrying'
  if (c?.status === 'disabled' && String(c?.failureReason ?? '').trim()) return 'disabledNoVector'
  return 'none'
}

/** 這一種要不要給「再試一次」那顆（只有試完的、跟停用中沒學成的） */
export function chunkRetryButtonShown(state: ChunkLearnState): boolean {
  return state === 'exhausted' || state === 'disabledNoVector'
}

/** 還在自動再試的那幾條：全站同一句 */
export const KB_AUTO_RETRY_TEXT = 'AI 還沒學會，系統會自己再試'
/** 試完了還是沒學會 */
export const KB_RETRY_EXHAUSTED_TEXT = `系統試了 ${KNOWLEDGE_MAX_AUTO_RETRIES} 次都沒學會`
/** 那顆按鈕（只在試完之後出現） */
export const KB_RETRY_BUTTON = '再試一次'
/** 試完了還是沒學會，他可以怎麼辦（「再試一次」那顆就在旁邊，這句只講按了還不行之後） */
export const KB_RETRY_EXHAUSTED_ADVICE = '再試一次還是不行的話，改一下內容再存，或聯絡我們'

/**
 * 失敗原因（多半是 Gemini 回的英文原文）→ 白話一句＋重試有沒有用。
 * 只有試完 5 次那幾條才拿出來講：還在自動再試的，原因是什麼他都不用管。
 */
export function plainIndexFailure(reason?: string | null): { text: string, retryable: boolean } {
  const r = String(reason ?? '').toLowerCase()
  if (!r) return { text: '原因不明', retryable: true }
  if (/timeout|timed out|etimedout|econnreset|socket/.test(r))
    return { text: '連線逾時（暫時性問題）', retryable: true }
  if (/429|rate limit|quota|resource.*exhausted/.test(r))
    return { text: 'AI 服務忙碌中（暫時性問題）', retryable: true }
  if (/5\d\d|internal|unavailable|bad gateway/.test(r))
    return { text: 'AI 服務暫時故障（暫時性問題）', retryable: true }
  if (/too long|exceed|payload|size/.test(r))
    return { text: '這一條內容太長，AI 讀不下', retryable: false }
  if (/empty|invalid|no content|內容為空/.test(r))
    return { text: '這一條內容有問題（可能是空的或只有符號）', retryable: false }
  if (/api key|permission|denied|unauthorized|401|403/.test(r))
    return { text: 'AI 服務金鑰或權限有問題，重試無效，請聯絡我們', retryable: false }
  return { text: '學習失敗（暫時性問題居多）', retryable: true }
}
