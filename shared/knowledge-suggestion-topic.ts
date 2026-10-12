/**
 * 「AI 建議補的知識」的主題名是不是客人原句（`D-124`，2026-10-13 `/code-review` 再修）。
 *
 * 伺服器建新主題時 AI 還沒擬到草稿，就先拿客人第一句的前 12 字當主題名；之後補到草稿要換成 AI 起的名字。
 * 以前認「是不是原句」只比 sampleQueries[0]——但每一輪掃描都會照次數重排、覆寫樣本句，
 * 最常被問的那句一換就認不出來；已經有草稿的舊資料伺服器也從不回頭改名。
 *
 * 判斷：有 topicIsRaw 照它（2026-10-13 起建立時寫明）；舊資料沒有這一格，比對**所有**存著的問句前 12 字。
 */
export interface SuggestionTopicFields {
  topic: string
  topicIsRaw?: boolean
  sampleQueries?: string[]
  queries?: string[]
}

export function isRawSuggestionTopic(s: SuggestionTopicFields): boolean {
  if (typeof s.topicIsRaw === 'boolean') return s.topicIsRaw
  const topic = String(s.topic ?? '')
  if (!topic) return false
  return [...(s.sampleQueries ?? []), ...(s.queries ?? [])].some(q => String(q ?? '').slice(0, 12) === topic)
}

/** 有草稿時拿它的標題當主題名（跟 AI 起的主題名一樣限 20 字） */
export function topicFromDraftTitle(title: string): string {
  return String(title ?? '').trim().slice(0, 20)
}
