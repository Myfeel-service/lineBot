/**
 * 行銷月曆「為這一檔擬推播」→ 推播頁 的草稿交接（`D-85` / `C-225`）。
 *
 * ⛔ **刻意不在月曆頁就建一筆推播草稿**（沿用 `C-210` 的判斷）：他還沒決定要不要發，
 *    半途反悔就會留下一堆空草稿。改成把文案暫存在瀏覽器、推播頁開一張**還沒存檔**的草稿。
 *
 * ⚠️ `sessionStorage` 是**這個瀏覽器分頁自己的**東西：無痕視窗、擋了網站資料、
 *    另開分頁貼網址都可能讀不到——所以**讀不到的時候要講出來**，
 *    ⛔ 不可以安靜地開一張空白推播（那會讓人以為文案弄丟了）。
 */

/** ⛔ 帶前綴：這個網域上還有別的功能在用 sessionStorage */
export const BROADCAST_DRAFT_HANDOFF_KEY = 'minime:broadcast-draft-handoff'

/**
 * 多久算過期。比名單那份（10 分鐘）長一點——擬文案本來就要看一下再決定，
 * 但⛔ 仍要有上限：隔天回來還套用昨天那一檔是最難察覺的錯。
 */
export const BROADCAST_DRAFT_HANDOFF_TTL_MS = 30 * 60 * 1000

/** 一次給幾版文案。三版＝夠挑又不會選擇癱瘓。 */
export const BROADCAST_DRAFT_VARIANTS = 3

export interface BroadcastDraftHandoff {
  festivalId: string
  /** 節日名稱（推播的預設名字用得到） */
  festivalName: string
  /** 建議的推播名字，例：「中秋節檔期」 */
  suggestedName: string
  /** 三版文案，⛔ 已經在後端驗過（長度、沒有金額、沒有假商品） */
  variants: string[]
  /** 建議的受眾標籤 id；空陣列＝沒有對得上的標籤，讓他自己挑 */
  suggestedTagIds: string[]
  /**
   * 受眾這件事要對他講的那一句（`C-235`）——**挑到了就講憑什麼，沒挑到就講找過了沒有**。
   *
   * ⛔ 這一欄不可以省成「選了 N 個標籤」：挑三顆卻說不出理由，人只能全盤接受或全盤不信；
   *   而挑不到時只寫「要你自己挑」，他分不出「系統沒找」「找了沒有」
   *   （[[feedback_filters_must_report_what_they_dropped]]）。
   * ⚠️ 舊的交接單沒有這一欄，所以 `draftHandoffNoticeText` 要吃得下空字串。
   */
  audienceNotice?: string
  /** 給人看的一句：這幾版是照什麼寫的 */
  basis: string
  ts: number
}

export function isFreshDraftHandoff(
  payload: BroadcastDraftHandoff | null,
  now = Date.now(),
): payload is BroadcastDraftHandoff {
  if (!payload) return false
  if (!Array.isArray(payload.variants) || payload.variants.length === 0) return false
  if (!payload.variants.every(v => typeof v === 'string' && v.trim().length > 0)) return false
  if (typeof payload.ts !== 'number' || !Number.isFinite(payload.ts)) return false
  return now - payload.ts <= BROADCAST_DRAFT_HANDOFF_TTL_MS
}

export function parseDraftHandoff(raw: string | null): BroadcastDraftHandoff | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as BroadcastDraftHandoff
    return v && typeof v === 'object' ? v : null
  }
  catch {
    return null
  }
}

/**
 * 帶過來之後要對他講的那一句。
 * ⛔ 一定要講「這是草稿、還沒有送出去」：`C-221` 同一條紅線——
 *    對客人說話的東西，最後一顆按鈕永遠是人。
 */
export function draftHandoffNoticeText(p: BroadcastDraftHandoff): string {
  // `C-235`：受眾那句由 `festival-audience.ts` 算好帶過來（挑到了講憑什麼、沒挑到講為什麼）。
  // ⚠️ 舊交接單沒有 `audienceNotice`，退回原本那句，⛔ 不要讓它變成空白。
  const tail = p.audienceNotice
    ? `。${p.audienceNotice}`
    : (p.suggestedTagIds.length ? `，發送對象先幫你選了 ${p.suggestedTagIds.length} 個標籤` : '，發送對象要你自己挑')
  return `幫你擬了 ${p.variants.length} 版「${p.festivalName}」的文案${tail}${tail.endsWith('。') ? '' : '。'}這是草稿，還沒有送出去。`
}

/** 讀不到時要講的那一句。⛔ 不可以安靜地開一張空白推播。 */
export const DRAFT_HANDOFF_MISSING_TEXT
  = '文案沒有帶過來（可能已經過期，或這個瀏覽器擋了暫存）。回後台首頁的「接下來的檔期」再按一次就好。'
