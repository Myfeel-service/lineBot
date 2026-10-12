/**
 * 「AI 建議補的知識」列表上的主題名（`D-124` 新手走查，2026-10-12）。
 *
 * 伺服器建新主題時，AI 還沒擬到草稿（時間預算用完或失敗）就先拿**客人第一句的前 12 字**當 topic；
 * 以前之後補到草稿也不回頭換名，列表上就一直掛著「您好，請問，小耳記，go」這種句子，新手看不懂那是什麼。
 * 伺服器這次一起修了（補草稿時順便換名），但已經存在的那幾筆不會自己變，所以畫面這邊也要接住：
 *  · topic 就是那句原話的前 12 字 → 有草稿用草稿標題；沒有就照實標成「客人問」的引號句
 *  · 其餘照 topic（AI 起的主題名）
 */
export function suggestionTopicLabel(s: { topic: string, sampleQueries?: string[], draft?: { title?: string } | null }): { text: string, quoted: boolean } {
  const first = String(s.sampleQueries?.[0] ?? '')
  const isRawFallback = !!first && s.topic === first.slice(0, 12)
  if (!isRawFallback) return { text: s.topic, quoted: false }
  const title = s.draft?.title?.trim()
  if (title) return { text: title, quoted: false }
  return { text: first.slice(0, 24), quoted: true }
}
