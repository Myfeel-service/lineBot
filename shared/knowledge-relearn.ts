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

// ── 重學沒成、AI 先用原本學好的（`C-351`，2026-10-19 老闆「照建議」）─────────────
/**
 * 本來可用的知識（`indexed`、有向量）**重學**時碰上 AI 忙：以前直接變「學失敗」＝回客人的檢索找不到它
 * （10-16 搬家 261 條下架約 7 分鐘就是這個）。現在照樣用原本學好的那份，另外記一格「還要重學」：
 *  · `retrying`：排程（`retryStuckChunks`）會自己再學，學好了才換成新的——店家什麼都不用做，⛔ 畫面不講；
 *  · `exhausted`：試完 5 次還是沒學成——AI 還是用原本的，那一條灰字一行＋編輯框給「再試一次」（同 `D-129`）。
 * 沒有這一格＝沒有在等重學。學好了、內容被改了（舊的那份對不上新內容）就拿掉。
 * ⛔ 這種的 `status` 一直是 `indexed`：體檢「要處理的事」、小幫手紅燈、LINE 推播（都只看 `failed`）不會為它亮——它沒有「客人問到會找不到」。
 */
export type KnowledgeRelearnState = 'retrying' | 'exhausted'

export interface KeptRelearnChunkLike extends RetryableChunkLike {
  relearnState?: unknown
}

/** 重學沒成、AI 先用原本的、系統還會自己再學（店家什麼都不用做） */
export function isKeptPreviousRelearning(c: KeptRelearnChunkLike | null | undefined): boolean {
  return c?.status === 'indexed' && c?.relearnState === 'retrying'
}

/** 重學試完 5 次還是沒成、AI 先用原本的（這時才給「再試一次」） */
export function isKeptPreviousExhausted(c: KeptRelearnChunkLike | null | undefined): boolean {
  return c?.status === 'indexed' && c?.relearnState === 'exhausted'
}

/**
 * 這一次重學又沒成之後，次數跟記號該寫成什麼（純函式；伺服器 runIndexOnChunk 用）。
 * countThisOne＝false：維運額度守門擋下（429，不是這一條的錯），不耗次數（同學失敗那條路）。
 */
export function relearnStateAfterFailure(prevRetryCount: unknown, countThisOne: boolean): { retryCount: number, relearnState: KnowledgeRelearnState } {
  const prev = chunkRetryCount({ retryCount: prevRetryCount })
  const retryCount = countThisOne ? prev + 1 : prev
  return { retryCount, relearnState: retryCount >= KNOWLEDGE_MAX_AUTO_RETRIES ? 'exhausted' : 'retrying' }
}

/** 「再試一次」那幾條（`D-129` 學失敗試完 5 次的＋`C-351` 重學試完 5 次、先用原本的） */
export function needsManualRetry(c: KeptRelearnChunkLike | null | undefined): boolean {
  return isAutoRetryExhausted(c) || isKeptPreviousExhausted(c)
}

/**
 * 編輯框上這一條「沒學會」是哪一種、要不要給「再試一次」（`D-129`）：
 *  · retrying：學失敗、系統還會自己再試——只講「系統會自己再試」，⛔ 不給按鈕；
 *  · exhausted：自動重試用完還是沒學會——講原因、給「再試一次」、講還不行怎麼辦；
 *  · disabledNoVector：停用中、上一次學沒成（停用的學失敗時會留原因、不落 failed）——排程不碰停用的，
 *    所以一開始就給「再試一次」（伺服器擋「打開」時那句叫他按的就是這一顆）；
 *  · keptRetrying：重學沒成、AI 先用原本學好的、系統還會自己再學（`C-351`）——⛔ 什麼都不講（原因原文也不給看）；
 *  · keptExhausted：重學試完 5 次還是沒成、AI 先用原本的（`C-351`）——灰字講一句、給「再試一次」；
 *  · none：沒事（可用、處理中、等你看過⋯）。
 */
export type ChunkLearnState = 'none' | 'retrying' | 'exhausted' | 'disabledNoVector' | 'keptRetrying' | 'keptExhausted'

export function chunkLearnState(c: KeptRelearnChunkLike & { failureReason?: unknown } | null | undefined): ChunkLearnState {
  if (c?.status === 'failed') return isAutoRetryExhausted(c) ? 'exhausted' : 'retrying'
  if (c?.status === 'disabled' && String(c?.failureReason ?? '').trim()) return 'disabledNoVector'
  if (isKeptPreviousExhausted(c)) return 'keptExhausted'
  if (isKeptPreviousRelearning(c)) return 'keptRetrying'
  return 'none'
}

/** 這一種要不要給「再試一次」那顆（只有試完的、停用中沒學成的、重學試完先用原本的） */
export function chunkRetryButtonShown(state: ChunkLearnState): boolean {
  return state === 'exhausted' || state === 'disabledNoVector' || state === 'keptExhausted'
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
 * 重學試完 5 次還是沒成、AI 先用原本學好的（`C-351`）：接在 KB_RETRY_EXHAUSTED_TEXT 後面講。
 * ⛔ 這種不給 KB_RETRY_EXHAUSTED_ADVICE 的「改一下內容再存」：內容一改，原本學好的那份就對不上、得整條重學——
 *    碰上 AI 忙就真的變成客人問到找不到，比現在（AI 照樣答得出來）更糟。按「再試一次」或放著都行。
 */
export const KB_KEPT_PREVIOUS_TEXT = 'AI 先用原本學好的'
/** 知識清單上那一行（灰字，⛔ 不上紅色：客人問到照樣答得出來） */
export const KB_KEPT_EXHAUSTED_LINE = `${KB_RETRY_EXHAUSTED_TEXT}，${KB_KEPT_PREVIOUS_TEXT}`

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
