/**
 * 每月 AI 用量上限（`C-413`）擋下來時講的話，以及「這個月先停」的標記還算不算數（`C-414`）。
 *
 * 放 shared：伺服器丟錯誤、資料頁、標籤頁、「客人問了、AI 答不出來」那一區都講同一句，
 * 而且「幾號恢復」要在**讀的當下**才算——存成整句的話，排程之後不再碰那一份，12 月還掛著「11 月 1 日恢復」。
 */
import { taipeiYyyyMm } from './time'
import type { AiBudgetKind } from './types/ai-knowledge'

/** 下個月 1 號（台灣日曆月）：「X 月 1 日恢復」 */
export function aiBudgetResumeLabel(date = new Date()): string {
  const month = Number(taipeiYyyyMm(date).slice(4))
  return `${month === 12 ? 1 : month + 1} 月 1 日`
}

/**
 * 擋下來時給人看的話（照示意頁 `RsVDnyeaVEbv76CgZ3TRoA` 的字）：發生什麼、幾號恢復、還照常的是什麼。
 * ⛔ 不講 token、不講 M——以前是「本月 AI 整理用量已達安全上限（20.0M/20M token）」，店家看不懂。
 * 加入知識視窗的「擋在門口」那張卡拿 title／body 分兩行排；錯誤訊息用兩句接起來。
 * 背景那本要講出停了哪幾件（`C-414`）：三件都在不同頁，只講「讀對話」他對不上是哪一個功能。
 */
export function aiBudgetMessage(kind: AiBudgetKind, date = new Date()): { title: string; body: string } {
  const resume = aiBudgetResumeLabel(date)
  if (kind === 'background') {
    return { title: `這個月 AI 讀對話到上限了，${resume}恢復`, body: '貼標建議、找新標籤、整理答不出來的問題先停；回答客人不受影響。' }
  }
  if (kind === 'assist') {
    return { title: `這個月小幫手、擬文案、畫選單底圖這類後台 AI 到上限了，${resume}恢復`, body: '回答客人不受影響。' }
  }
  return {
    title: `這個月加入資料到上限了，${resume}恢復`,
    body: '這段期間網頁、試算表改了，AI 也要等到那天才跟上；已經放進去的照常回答客人。需要更多請跟我們聯絡。',
  }
}

/**
 * 「這個月先停」的標記還算不算數：標記只存**哪個月**停的（`taipeiYyyyMm`），月份對上才算。
 * 為什麼一個月份就夠：用量只增不減、上限是常數——同一個月擋下了，整個月都會擋；過了月自然失效，不用誰回頭清。
 * ⚠️ 哪天上限改成可以月中調高（`D-157`③ 方案分級），這裡要改成「重查一次」，不然調高了也要等到月底。
 */
export function budgetPauseActive(pausedMonth: unknown, date = new Date()): boolean {
  return typeof pausedMonth === 'string' && pausedMonth === taipeiYyyyMm(date)
}

/**
 * 伺服器丟回來的錯誤是不是每月上限（瀏覽器端用）。HTTP 的錯看 `data.data.reason`（h3 把 createError 的 data 包在回應的 data 裡）；
 * 輪詢工作那種只拿得到一句話的，比對 aiBudgetMessage 組出來的那半句。
 */
export function isAiBudgetErrorLike(err: unknown): boolean {
  const e = err as { data?: { data?: { reason?: unknown }, statusMessage?: unknown }, message?: unknown } | null | undefined
  if (e?.data?.data?.reason === 'ai_budget') return true
  return /到上限了，\d{1,2} 月 1 日恢復/.test(String(e?.data?.statusMessage ?? e?.message ?? ''))
}
