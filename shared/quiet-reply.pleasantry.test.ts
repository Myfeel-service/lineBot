/**
 * isPleasantryOnly：真人處理中客人回這種話不叫人（`C-381`）。
 * 例句取自 MYFEEL 2026-10-22 唯讀查到的真實回覆（客服回完之後客人回的那一句）。
 */
import { describe, expect, it } from 'vitest'
import { isPleasantryOnly } from './quiet-reply'

describe('isPleasantryOnly', () => {
  it.each([
    '謝謝', '好的謝謝', '好的 謝謝', '好的，感謝！', '了解，謝謝', '了解~謝謝', '謝謝您～～～',
    '好、謝謝你們', '感謝您', '好的', '收到', 'OK', '好', '(thank you)', '掰掰', '👍', '🙏',
  ])('客套：%s', (text) => {
    expect(isPleasantryOnly(text)).toBe(true)
  })

  it.each([
    '請問廠商有回覆了嗎',
    '好的那運費呢',
    '好的 謝謝 以後買不到便宜的濾芯了',
    '好再麻煩了謝謝',
    '非常謝謝 那我再去問問',
    '可以嗎？',
    'OK?',
    '哈囉',
    '我想換黑色的',
    '',
  ])('不是客套（要叫人）：%s', (text) => {
    expect(isPleasantryOnly(text)).toBe(false)
  })
})
