/**
 * 「補一條知識」小視窗（`C-317`，2026-10-15 老闆拍板 D-126③）：送出去的那一條長什麼樣子、按鈕能不能按、
 * 加好之後講什麼。
 *
 * 為什麼要有：以前補一條有 6 個入口、兩種結果，手動新增的視窗有五個欄位（標題、內容、問法、標籤、有效期限）。
 * 現在每個入口都打開同一個小視窗：「客人問」＋「正確答案（一兩句就好）」→（可以按「AI 幫我整理」）→ 加入就上線。
 * 規則抽成純函式才測得到——尤其「AI 沒整理成也加得進去」與「客人問的那句一定放進問法」。
 */
import { countKnowledgeDraftBlanks, type KnowledgeSuggestionDraft } from '~~/shared/types/ai-knowledge'
import { syncTickedQuestions } from './kb-suggestion-answered'
import { KB_AUTO_RETRY_TEXT } from '~~/shared/knowledge-relearn'

/** 一條知識的標題上限（跟編輯視窗同一個：maxlength 100） */
export const ADD_ONE_TITLE_MAX = 100

/** 視窗的 `suggestion` prop——建議收件匣那條路（`C-318`）：哪一筆、這一組全部的題目、預設勾哪幾題；草稿有內容就先擺出來 */
export interface AddOneSuggestion {
  id: string
  queries: string[]
  answeredDefault: string[]
  draft?: KnowledgeSuggestionDraft | null
}

/** 視窗的 `created` 事件 */
export interface AddOneCreated {
  chunkId?: string
  sourceId?: string
  mode: 'manual' | 'suggestion'
  /** 建議那條路：沒勾、還留在清單上的題數（0＝整組回答完了） */
  remainingQuestions?: number
}

/** 「AI 整理成這樣」那一塊：可以直接改；問法與標籤不給看（標籤是系統分類用的，`C-314`） */
export interface AddOnePreview {
  title: string
  content: string
  questions: string[]
  tags: string[]
  /**
   * 這份整理是照哪一句答案做的。答案一改，這份就作廢（畫面收掉、加入改回照打的字）——
   * 不然他改了答案、按加入，存進去的卻是改之前整理的那一版。AI 先擬好的草稿＝''（還沒有他寫的答案）。
   */
  basis: string
  /** AI 先擬好的（建議收件匣的草稿），不是他按「AI 幫我整理」出來的：標題字不同 */
  fromDraft: boolean
}

export interface AddOneState {
  /** 「客人問」那一格（手動補、或建議只有一題時） */
  question: string
  answer: string
  preview: AddOnePreview | null
  /** 建議那一組全部的題目；一題以上才出「這一條回答了哪幾題？」 */
  queries: string[]
  ticked: string[]
}

export interface AddOnePayload {
  title: string
  content: string
  tags: string[]
  questions: string[]
  /** 只有一題以上的建議才帶（`C-311`：沒帶＝整組都回答了） */
  answeredQueries?: string[]
}

export function isMultiQuestion(s: Pick<AddOneState, 'queries'>): boolean {
  return s.queries.length > 1
}

/** 勾了的題目，照清單順序（伺服器拿第一題試答，順序要穩定） */
export function tickedInOrder(s: Pick<AddOneState, 'queries' | 'ticked'>): string[] {
  const set = new Set(s.ticked)
  return s.queries.filter(q => set.has(q))
}

/** 這一條在回答哪一句客人的話：一題以上＝勾的第一題，否則＝「客人問」那一格 */
export function addOneLeadQuestion(s: AddOneState): string {
  return (isMultiQuestion(s) ? tickedInOrder(s)[0] ?? '' : s.question).trim()
}

/** 建議收件匣的草稿 → 一開始就擺著的「AI 先擬好的」；草稿是空的（知識庫本來就沒答案時常常是）＝沒有 */
export function previewFromDraft(draft: KnowledgeSuggestionDraft | null | undefined, fallbackTitle: string): AddOnePreview | null {
  const content = String(draft?.content ?? '').trim()
  if (!content) return null
  return {
    title: (String(draft?.title ?? '').trim() || fallbackTitle.trim()).slice(0, ADD_ONE_TITLE_MAX),
    content,
    questions: (draft?.questions ?? []).map(q => String(q).trim()).filter(Boolean),
    tags: (draft?.tags ?? []).map(t => String(t).trim()).filter(Boolean),
    basis: '',
    fromDraft: true,
  }
}

/** 答案改過了，那份整理就不算數（見 AddOnePreview.basis） */
export function previewStillFits(preview: AddOnePreview | null, answer: string): boolean {
  return !!preview && preview.basis === answer.trim()
}

/** 「AI 幫我整理」送什麼：標題＝客人問的那一句、內容＝他打的答案（/api/ai/knowledge/normalize 兩格都要有字） */
export function addOneNormalizeInput(s: AddOneState): { title: string; content: string } | null {
  const title = addOneLeadQuestion(s).slice(0, ADD_ONE_TITLE_MAX)
  const content = s.answer.trim()
  return title && content ? { title, content } : null
}

/**
 * 送出去的那一條。
 * - 有整理過（或 AI 先擬好的）→ 用那一份；沒有（沒按、或 AI 沒整理成）→ 標題＝客人問的那一句、內容＝他打的答案。
 * - 問法：客人問的那一句（一題以上＝勾的那幾題）一定放進去——那正是客人實際的問法，AI 最容易靠它找到這一條；
 *   一條最多 3 個，滿了換掉 AI 擬的（規則同 `C-311` 的 syncTickedQuestions，同一套不另寫）。
 */
export function addOnePayload(s: AddOneState): AddOnePayload {
  const multi = isMultiQuestion(s)
  const lead = addOneLeadQuestion(s)
  const p = previewStillFits(s.preview, s.answer) ? s.preview : null
  const asked = multi ? tickedInOrder(s) : (lead ? [lead] : [])
  return {
    title: (p ? p.title.trim() : lead).slice(0, ADD_ONE_TITLE_MAX),
    content: p ? p.content.trim() : s.answer.trim(),
    tags: p ? [...p.tags] : [],
    questions: syncTickedQuestions(p ? p.questions : [], [], asked),
    ...(multi ? { answeredQueries: tickedInOrder(s) } : {}),
  }
}

/** 「加入」那顆按鈕：能不能按、上面寫什麼（擋下來的原因直接寫在按鈕上，不另外放一行說明） */
export function addOneButton(s: AddOneState): { ok: boolean; label: string } {
  if (isMultiQuestion(s) && !s.ticked.length) return { ok: false, label: '至少勾一題' }
  const payload = addOnePayload(s)
  // 草稿裡「【請填寫：…】」是知識庫查不到、AI 依規則留空的事實——伺服器也會擋（accept 400），先擋在這裡省一趟
  const blanks = countKnowledgeDraftBlanks(payload.content)
  if (blanks > 0) return { ok: false, label: `還有 ${blanks} 個空格要補` }
  return { ok: !!payload.title && !!payload.content, label: '加入' }
}

/** 加好之後那一句。⛔ 不可以一律說「AI 會用這一條」——沒學成、或試問還答不出來時那就是假話 */
export function addOneDoneToast(r: {
  status?: string
  /** 用客人的話試問的結果（建議那條路是 accept 回的 verify、手動那條路是另外問一次；逾時＝null，不算答不出來） */
  verifyDecision?: string | null
  /**
   * 這次真的試問過了嗎（/code-review 第 5 條）。沒試問成（失敗、逾時）＝不知道 AI 找不找得到，
   * ⛔ 不講「AI 回客人會用這一條」，只講加好了
   */
  verified?: boolean
  remainingQuestions?: number
}): { text: string; tone: 'success' | 'warning' | 'error' } {
  const left = Number(r.remainingQuestions ?? 0)
  const leftNote = left > 0 ? `。沒勾的 ${left} 題還在清單上` : ''
  // 沒學成（`D-129`）：系統每 10 分鐘自己再試（最多 5 次）——⛔ 不叫他去按什麼、不上紅色；試完還不行，知識庫「要處理的事」才會列出來
  if (r.status && r.status !== 'indexed') {
    return { text: `加好了，但 ${KB_AUTO_RETRY_TEXT}${leftNote}`, tone: 'warning' }
  }
  // 反問也算學會了（相近的有好幾條，AI 先問客人是哪一個），同 kbVerifyOutcome
  if (r.verifyDecision && r.verifyDecision !== 'answered' && r.verifyDecision !== 'disambiguate') {
    return { text: `加好了，但用客人的話試問，AI 還是答不出來——可以在「問 AI 一題」再問一次${leftNote}`, tone: 'warning' }
  }
  if (r.verified === false) return { text: `加好了${leftNote}`, tone: 'success' }
  return { text: `加好了，AI 回客人會用這一條${leftNote}`, tone: 'success' }
}
