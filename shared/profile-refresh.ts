/**
 * 每月從對話回頭更新店家輪廓（`D-85` / `C-226`）。
 *
 * ── 為什麼需要它 ───────────────────────────────────────────────
 * 輪廓是開帳那天問來的，但店會變：換了主打商品、客人問的東西不一樣了、
 * 旺季跟他當初想的不同。⛔ 沒有這一段的話，輪廓會慢慢變成一份「三個月前的他」，
 * 而下游所有建議都照著那份舊資料長。
 *
 * ── 四條紀律 ───────────────────────────────────────────────────
 * ① **不覆蓋商家自己填的**。學到的東西一律以 `conversation` 身分提出來，
 *    商家在輪廓卡按確認才變成 `owner`——⛔ 靜默改掉他填的東西是最傷信任的事。
 * ② **一次最多兩題**。每月一則、兩題以內，多了沒人看。
 * ③ **講得出「我是從哪裡學到的」**：每一則都帶出處（幾位客人問過、問了幾次）。
 * ④ **沒學到就整段不出現**。⛔ 不可以每個月都硬擠一句「你的店有變化嗎」。
 */

import {
  storeProfileFieldDef,
  type StoreProfileDoc,
  type StoreProfileFieldId,
} from './types/store-profile'

/** 一則「我學到的事」。 */
export interface ProfileLearning {
  field: StoreProfileFieldId
  /** 學到的新值（要寫進輪廓的那一段） */
  value: string
  /** 講給人看的一句：我從哪裡學到的 */
  evidence: string
}

/** 多久提一次。⛔ 不是每週——每週問同一件事會被當成雜訊直接忽略。 */
export const PROFILE_REFRESH_INTERVAL_DAYS = 28
/** 一次最多提幾題 */
export const PROFILE_REFRESH_MAX = 2
/** 一個主題至少被問過幾次才值得提。低於這個數字是雜訊不是趨勢。 */
export const PROFILE_REFRESH_MIN_EVENTS = 3

/**
 * 今天該不該提。
 * @param lastAskedMs 上次提的時間（epoch ms）；0／null＝從來沒提過
 */
export function shouldAskProfileRefresh(lastAskedMs: number | null | undefined, nowMs: number): boolean {
  if (!lastAskedMs) return true
  return nowMs - lastAskedMs >= PROFILE_REFRESH_INTERVAL_DAYS * 86_400_000
}

export interface FaqCandidate {
  topic: string
  eventCount: number
  /** 事件數是取樣值（撞到掃描上限）——要講「至少」而不是精確值 */
  sampled?: boolean
}

/**
 * 從「客人問了什麼」歸納出要不要更新「客人最常問的事」。
 *
 * ⛔ **商家自己填過就不提**：他填的比我們統計的準，而且提了等於在質疑他。
 * ⛔ 跟現在的值一樣也不提（那不是「更新」，是雜訊）。
 */
export function learnFaq(
  profile: StoreProfileDoc | null | undefined,
  candidates: FaqCandidate[],
): ProfileLearning | null {
  const current = profile?.fields?.faq
  if (current?.source === 'owner') return null

  const strong = candidates
    .filter(c => c.topic.trim() && c.eventCount >= PROFILE_REFRESH_MIN_EVENTS)
    .sort((a, b) => b.eventCount - a.eventCount)
    .slice(0, 3)
  if (!strong.length) return null

  const value = strong.map(c => c.topic.trim()).join('、')
  if (value === String(current?.value ?? '').trim()) return null

  const sampled = strong.some(c => c.sampled)
  const total = strong.reduce((n, c) => n + c.eventCount, 0)
  return {
    field: 'faq',
    value,
    evidence: `這一個月客人問了${sampled ? '至少 ' : ''}${total} 次，最常問的是「${strong[0]!.topic}」`,
  }
}

/**
 * 從標籤成長歸納出「主要客群」是不是變了。
 * ⛔ 這一條比 FAQ 弱得多（標籤名不等於客群），所以**只在商家完全沒填過時提**，
 *    而且措辭要是問句不是斷言。
 */
export function learnCustomers(
  profile: StoreProfileDoc | null | undefined,
  topTag: { name: string, addedThisMonth: number } | null,
): ProfileLearning | null {
  const current = profile?.fields?.customers
  if (current?.value) return null // 有值就不動（不管是誰填的）
  if (!topTag || topTag.addedThisMonth < PROFILE_REFRESH_MIN_EVENTS) return null
  return {
    field: 'customers',
    value: `常被貼「${topTag.name}」的客人`,
    evidence: `這一個月有 ${topTag.addedThisMonth} 位客人被貼上「${topTag.name}」`,
  }
}

/** 湊出這次要提的題目（最多兩題，強的排前面）。 */
export function collectLearnings(
  profile: StoreProfileDoc | null | undefined,
  faqCandidates: FaqCandidate[],
  topTag: { name: string, addedThisMonth: number } | null,
): ProfileLearning[] {
  return [learnFaq(profile, faqCandidates), learnCustomers(profile, topTag)]
    .filter((x): x is ProfileLearning => x !== null)
    .slice(0, PROFILE_REFRESH_MAX)
}

/**
 * 併進「本週顧客觀察」的那幾行。**沒學到就回空陣列**（整段不出現）。
 *
 * ⛔ 不另發一則訊息（08-06 拍板「一則錢講完全部」）。
 * ⛔ 指路用側欄的名字（「組織與 LINE」），不要寫頁面別名。
 */
export function formatProfileRefreshLines(learnings: ProfileLearning[]): string[] {
  if (!learnings.length) return []
  const lines = learnings.map((l) => {
    const label = storeProfileFieldDef(l.field)?.label ?? l.field
    return `我想把你的「${label}」更新成「${l.value}」——${l.evidence}`
  })
  // ⛔ 一定要講「還沒改」：不講的話他會以為系統已經自己改掉了
  lines.push('這幾項我還沒改，到「組織與 LINE」的輪廓卡按一下確認就好。')
  return lines
}
