/**
 * 建議卡「這次不做」——收起來、記住、可以還原（`C-236`）。
 *
 * ── 為什麼要有 ─────────────────────────────────────────────────
 * 90 天視窗裡常有 6–8 檔，其中一半跟這家店無關（賣工具機的不做情人節）。
 * 不能收起來的話，每次開後台首頁都要重看一次不相干的建議，兩週後整張卡就沒人看了
 * ——跟 `D-25` 週報那條「全部為零就整段不出現」同一個道理。
 *
 * ⚠️ 這條本來寫在 `C-224` 的規格裡（「建議卡能被『這次不做』並**記住**」），
 *   但程式裡從來沒有過，而且 `C-224` 的完成紀錄**也沒說它刻意不做**——
 *   是規格靜靜掉了一條，2026-09-23 做 `C-235` 時才查出來。
 *
 * ── 三條鐵律 ───────────────────────────────────────────────────
 * ① **收起來的要看得見、要能還原**。⛔ 靜靜消失的話，他會以為系統漏掉那個節日
 *    （`C-223` 節慶提醒那條同一個道理）。
 * ② **記在節日 id 上就好**。`TAIWAN_FESTIVALS` 的 id 本來就含年份（`midautumn-2026`），
 *    所以**明年那一檔自然會回來**，⛔ 不要另外設計「每年重置」。
 * ③ **全部被收起來時要講一句**，⛔ 不可以只剩一張空白的卡——那看起來像壞掉。
 */

/** 存在 Firestore 的形狀：`{ 節日id: 收起來的時間(ms) }` */
export type MarketingSkipMap = Record<string, number>

/**
 * 最多記得幾檔。過了 90 天視窗的節日再也不會出現在卡上，
 * 留著只是讓文件無限長大——存檔前先剪掉。
 */
export const SKIP_MAP_MAX = 60

/** 把資料庫拿到的東西洗成乾淨的 map。⛔ 壞掉的值一律丟掉，不要讓它炸掉整張卡。 */
export function normalizeSkipMap(raw: unknown): MarketingSkipMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: MarketingSkipMap = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const id = String(k ?? '').trim()
    const at = Number(v)
    // ⛔ Firestore 的 map key 不可以含「.」；節日 id 本來就不含，含的就是髒資料
    if (!id || id.includes('.') || !Number.isFinite(at) || at <= 0) continue
    out[id] = at
  }
  return out
}

/** 這一檔被收起來了嗎？ */
export function isSkipped(map: MarketingSkipMap, festivalId: string): boolean {
  return Boolean(map[String(festivalId ?? '')])
}

/**
 * 寫入前把 map 剪到上限（留最近收的那幾筆）。
 * ⛔ 不要無限成長：一份文件塞滿幾年份的節日，讀寫都會變慢。
 */
export function pruneSkipMap(map: MarketingSkipMap, max = SKIP_MAP_MAX): MarketingSkipMap {
  const entries = Object.entries(map)
  if (entries.length <= max) return { ...map }
  const kept = entries.sort((a, b) => b[1] - a[1]).slice(0, max)
  return Object.fromEntries(kept)
}

/** 卡上那一列的最小形狀（`CalendarEntry` 的子集，這裡不依賴整個型別） */
export interface SkippableEntry {
  festivalId: string
  name: string
}

/** 把月曆拆成「要顯示的」與「收起來的」兩堆。 */
export function splitBySkip<T extends SkippableEntry>(
  entries: readonly T[],
  map: MarketingSkipMap,
): { visible: T[], skipped: T[] } {
  const visible: T[] = []
  const skipped: T[] = []
  for (const e of entries) {
    if (isSkipped(map, e.festivalId)) skipped.push(e)
    else visible.push(e)
  }
  return { visible, skipped }
}

/**
 * 收起來那幾檔要講的那一句（鐵律①：看得見）。
 * ⛔ 一檔都沒收就回空字串（整列不出現）。
 */
export function skippedNoticeText(skipped: readonly SkippableEntry[]): string {
  if (!skipped.length) return ''
  const names = skipped.slice(0, 4).map(s => s.name).join('、')
  const more = skipped.length > 4 ? ` 等 ${skipped.length} 檔` : ''
  return `你收起了${names}${more}`
}

/**
 * 全部被收起來時要講的那一句（鐵律③）。
 * ⛔ 只剩一張空白的卡看起來像壞掉，一定要講「是你自己收的」並指路怎麼還原。
 */
export function allSkippedText(skipped: readonly SkippableEntry[]): string {
  if (!skipped.length) return ''
  return `接下來 90 天的 ${skipped.length} 檔你都收起來了。想看的話按下面的「還原」。`
}

/** 還原之後要講的那一句 */
export function restoredText(name: string): string {
  return `「${name}」放回來了。`
}

/** 收起來之後要講的那一句。⛔ 一定要講得出「明年會回來」，否則他會以為是永久刪除。 */
export function skippedToastText(name: string): string {
  return `「${name}」這一檔收起來了，明年的還是會出現。`
}
