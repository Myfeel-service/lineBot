import { describe, expect, it } from 'vitest'
import { suggestionTopicLabel } from './kb-suggestion-label'

describe('suggestionTopicLabel（AI 建議補的知識的主題名，D-124）', () => {
  const q = '您好，請問，小耳記，go 可以連藍牙嗎'

  it('AI 起過主題名 → 照用', () => {
    expect(suggestionTopicLabel({ topic: '小耳記藍牙連線', sampleQueries: [q] })).toEqual({ text: '小耳記藍牙連線', quoted: false })
  })

  it('⛔ topic 只是客人原句的前 12 字、但後來補到了草稿 → 用草稿標題（以前一直掛著原句）', () => {
    expect(suggestionTopicLabel({ topic: q.slice(0, 12), sampleQueries: [q], draft: { title: '小耳記怎麼連藍牙' } }))
      .toEqual({ text: '小耳記怎麼連藍牙', quoted: false })
  })

  it('還沒有草稿 → 照實標成「客人問」，多給一點原句', () => {
    expect(suggestionTopicLabel({ topic: q.slice(0, 12), sampleQueries: [q], draft: null }))
      .toEqual({ text: q.slice(0, 24), quoted: true })
  })

  it('沒有樣本句 → 照 topic', () => {
    expect(suggestionTopicLabel({ topic: '(未命名主題)', sampleQueries: [] })).toEqual({ text: '(未命名主題)', quoted: false })
  })
})
