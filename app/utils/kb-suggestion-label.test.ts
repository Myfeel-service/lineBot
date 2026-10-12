import { describe, expect, it } from 'vitest'
import { isRawSuggestionTopic } from '~~/shared/knowledge-suggestion-topic'
import { suggestionTopicLabel } from './kb-suggestion-label'

describe('suggestionTopicLabel（AI 建議補的知識的主題名，D-124）', () => {
  const q = '您好，請問，小耳記，go 可以連藍牙嗎'

  it('AI 起過主題名 → 照用', () => {
    expect(suggestionTopicLabel({ topic: '小耳記藍牙連線', topicIsRaw: false, sampleQueries: [q] })).toEqual({ text: '小耳記藍牙連線', quoted: false })
  })

  it('⛔ topic 只是客人原句的前 12 字、但後來補到了草稿 → 用草稿標題（以前一直掛著原句）', () => {
    expect(suggestionTopicLabel({ topic: q.slice(0, 12), topicIsRaw: true, sampleQueries: [q], draft: { title: '小耳記怎麼連藍牙' } }))
      .toEqual({ text: '小耳記怎麼連藍牙', quoted: false })
  })

  it('還沒有草稿 → 照實標成「客人問」，多給一點原句', () => {
    expect(suggestionTopicLabel({ topic: q.slice(0, 12), topicIsRaw: true, sampleQueries: [q], draft: null }))
      .toEqual({ text: q.slice(0, 24), quoted: true })
  })

  it('沒有樣本句 → 照 topic', () => {
    expect(suggestionTopicLabel({ topic: '(未命名主題)', topicIsRaw: false, sampleQueries: [] })).toEqual({ text: '(未命名主題)', quoted: false })
  })
})

describe('isRawSuggestionTopic（是不是客人原句，伺服器判好給畫面，2026-10-13 /code-review）', () => {
  const q = '您好，請問，小耳記，go 可以連藍牙嗎'

  it('建立時寫明的照它', () => {
    expect(isRawSuggestionTopic({ topic: '小耳記藍牙連線', topicIsRaw: true })).toBe(true)
    expect(isRawSuggestionTopic({ topic: q.slice(0, 12), topicIsRaw: false, sampleQueries: [q] })).toBe(false)
  })

  it('⛔ 舊資料（沒有那一格）：樣本句被下一輪重排、原句不在第一個了照樣認得', () => {
    const resorted = ['小耳記可以錄音嗎', '小耳記多少錢', q]
    expect(isRawSuggestionTopic({ topic: q.slice(0, 12), sampleQueries: resorted })).toBe(true)
  })

  it('舊資料：原句已經擠出 5 條樣本、還在 30 條問句裡 → 也認得', () => {
    expect(isRawSuggestionTopic({ topic: q.slice(0, 12), sampleQueries: ['別的問題'], queries: ['別的問題', q] })).toBe(true)
  })

  it('AI 起的主題名不會被誤認', () => {
    expect(isRawSuggestionTopic({ topic: '小耳記藍牙連線', sampleQueries: [q], queries: [q] })).toBe(false)
  })
})
