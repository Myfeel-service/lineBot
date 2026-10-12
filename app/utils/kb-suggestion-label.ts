/**
 * 「AI 建議補的知識」列表上的主題名（`D-124` 新手走查，2026-10-12；2026-10-13 `/code-review` 再修）。
 *
 * 伺服器建新主題時，AI 還沒擬到草稿（時間預算用完或失敗）就先拿**客人第一句的前 12 字**當 topic。
 * 是不是原句由伺服器判好給 topicIsRaw（建立時寫明、舊資料比對所有存著的問句，見 shared/knowledge-suggestion-topic）——
 * ⛔ 以前畫面自己比 sampleQueries[0]，每輪掃描重排樣本句之後就認不出來，又掛回「您好，請問，小耳記，go」。
 *  · 是原句 → 有草稿用草稿標題；沒有就照實標成「客人問」的引號句
 *  · 其餘照 topic（AI 起的主題名）
 */
export function suggestionTopicLabel(s: { topic: string, topicIsRaw?: boolean, sampleQueries?: string[], draft?: { title?: string } | null }): { text: string, quoted: boolean } {
  if (!s.topicIsRaw) return { text: s.topic, quoted: false }
  const title = s.draft?.title?.trim()
  if (title) return { text: title, quoted: false }
  const first = String(s.sampleQueries?.[0] ?? s.topic)
  return { text: first.slice(0, 24), quoted: true }
}
