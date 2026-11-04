/**
 * 開帳標籤卡的「還想怎麼分？問 AI」（`D-171`，示意頁 v2，2026-11-05 老闆「好 執行」）。
 *
 * 店家用一句話講他想怎麼分客人（「我想分內用、外帶、外送的客人」），AI 回幾顆標籤，
 * 他按「加進上面」才進那一排、按「建立 N 顆」才真的建。
 *
 * ── 三條規矩 ───────────────────────────────────────────────────
 * ① **只收對話裡講得出來的分法**：每顆都要帶 AI 判斷條件，之後 AI 讀對話才貼得上。
 *    「買過」「常客」「VIP」「第一次來」要訂單或來店紀錄，我們沒有——建了永遠 0 人，⛔ 不收。
 * ② **擋掉的要說得出擋了什麼**（`feedback_filters_must_report_what_they_dropped`）：
 *    他問「我想分 VIP」卻什麼都沒回，他會以為 AI 壞了。⛔ 不可以按了沒反應。
 * ③ **只回草稿**：這裡不建任何東西，建立在他按「建立 N 顆」那一刻（08-14 紅線：最後一顆按鈕留人）。
 */
import type { TagDraft } from './store-profile-drafts'

/** 一次最多加幾顆 */
export const TAG_IDEA_MAX = 4
/** 他打的那句最多幾個字 */
export const TAG_IDEA_ASK_MAX = 120
/** 一張卡最多問幾次（⛔ 用完要講，不可以變成按了沒反應） */
export const TAG_IDEA_ASKS_PER_CARD = 5
/** 名字幾個字以內（手機上一排放得下；標籤管理頁的上限是 30，這裡刻意更短） */
export const TAG_IDEA_NAME_MAX = 10
/** 判斷條件上限＝標籤編輯器與 ai-tag-suggest 的 200（動一邊要動另一邊） */
const CRITERIA_MAX = 200
const WHY_MAX = 40
const SKIP_REASON_MAX = 60

/**
 * 要訂單、來店、消費紀錄才分得出來的名字。
 * ⚠️ 只擋**名字**：判斷條件裡寫「買過的不算」是正常的排除句，不能擋。
 * ⚠️ 「問過會員方案」「想首購優惠」是對話裡講得出來的——開頭是「問過／想／在等」的不擋（`needsRecords`）。
 */
export const TAG_NEEDS_RECORDS_RE = /買過|購買過|回購|回頭客|常客|熟客|老客|新客|VIP|會員|消費|金額|第一次|首購|首次|來過|去過|下單過|成交|沒買|未購/i
export const TAG_NEEDS_RECORDS_REASON = '要有訂單或來店紀錄才分得出來，對話裡看不出來'

export function needsRecords(name: string): boolean {
  return !/^(問過|詢問過|想|在等|在問)/.test(name) && TAG_NEEDS_RECORDS_RE.test(name)
}

export type TagIdea = Pick<TagDraft, 'name' | 'why' | 'criteria'>

export interface TagIdeaSkip {
  name: string
  reason: string
}

export interface TagIdeasVetted {
  ideas: TagIdea[]
  /** 他要的、但我們做不到的（⛔ 一定要講給他聽） */
  skipped: TagIdeaSkip[]
  /** 他要的、上面已經有了 */
  already: string[]
  /** 格式不對被丟掉的（只記 log，不講給他聽——那是模型的錯不是他的） */
  dropped: { text: string, reason: string }[]
}

function tidyName(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .replace(/^[「『"'“‘【[(（]+|[」』"'”’】\])）]+$/g, '')
    .replace(/\s+/g, '')
}

const keyOf = (name: string) => tidyName(name).toLowerCase()

/**
 * 驗模型回來的那一包。`have`＝那一排現在已經有的名字（勾不勾都算）。
 */
export function vetTagIdeas(raw: unknown, have: readonly string[]): TagIdeasVetted {
  const out: TagIdeasVetted = { ideas: [], skipped: [], already: [], dropped: [] }
  const seen = new Set(have.map(keyOf))
  const data = (raw && typeof raw === 'object' ? raw : {}) as { tags?: unknown, skipped?: unknown }
  const list = Array.isArray(data.tags) ? data.tags : []

  for (const item of list) {
    const o = (item && typeof item === 'object' ? item : {}) as { name?: unknown, criteria?: unknown, why?: unknown }
    const name = tidyName(o.name)
    if (!name) { out.dropped.push({ text: '', reason: '沒有名字' }); continue }
    if (needsRecords(name)) {
      out.skipped.push({ name, reason: TAG_NEEDS_RECORDS_REASON })
      continue
    }
    if (seen.has(keyOf(name))) {
      if (!out.already.includes(name)) out.already.push(name)
      continue
    }
    if (name.length > TAG_IDEA_NAME_MAX) { out.dropped.push({ text: name, reason: `名字太長（${name.length} 字）` }); continue }
    const criteria = String(o.criteria ?? '').trim()
    // ⛔ 沒有判斷條件＝AI 之後貼不上＝永遠 0 人，跟「回購客」同一種病
    if (!criteria) { out.dropped.push({ text: name, reason: '沒有判斷條件' }); continue }
    if (out.ideas.length >= TAG_IDEA_MAX) { out.dropped.push({ text: name, reason: `超過 ${TAG_IDEA_MAX} 顆` }); continue }
    seen.add(keyOf(name))
    out.ideas.push({
      name,
      criteria: criteria.slice(0, CRITERIA_MAX),
      why: String(o.why ?? '').trim().slice(0, WHY_MAX),
    })
  }

  // 模型自己判斷做不到的（照規則它應該放這裡）
  for (const s of Array.isArray(data.skipped) ? data.skipped : []) {
    const o = (s && typeof s === 'object' ? s : {}) as { name?: unknown, reason?: unknown }
    const name = tidyName(o.name).slice(0, 20)
    if (!name || out.skipped.some(x => x.name === name)) continue
    out.skipped.push({ name, reason: String(o.reason ?? '').trim().slice(0, SKIP_REASON_MAX) || TAG_NEEDS_RECORDS_REASON })
  }

  if (!list.length) out.dropped.push({ text: '', reason: '模型沒有回任何一顆' })
  return out
}

/**
 * 問完之後卡片上那一句。回空字串＝不用講（有新的可以加、也沒擋掉什麼）。
 * ⛔ 什麼都沒回的時候一定要有一句——不可以按了沒反應。
 */
export function tagIdeasNote(v: Pick<TagIdeasVetted, 'ideas' | 'skipped' | 'already'>): string {
  const parts: string[] = []
  if (v.skipped.length) {
    const names = v.skipped.slice(0, 3).map(s => `「${s.name}」`).join('')
    parts.push(`${names}沒列：${v.skipped[0]!.reason}。`)
  }
  if (!v.ideas.length && v.already.length) {
    parts.push(`${v.already.slice(0, 3).map(n => `「${n}」`).join('')}上面已經有了。`)
  }
  if (!v.ideas.length && !v.skipped.length && !v.already.length) {
    parts.push('這次想不出合適的分法，換個說法再問一次。')
  }
  return parts.join('')
}
