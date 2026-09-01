/**
 * 動態嚴重度（`D-44`②，2026-09-01）。
 *
 * 分級搬進 shared 就是為了「畫面與 LINE 推播用同一把尺」，所以蓋掉預設的管道
 * 只能有一條。這裡釘住兩件事：探針帶的值會贏、沒帶就用預設表。
 * ⛔ 任何地方直接查 ALERT_SEVERITY 而不走 severityOf，都會讓「畫面是紅的、推播不推」
 * 這種對不起來的狀況回來。
 */
import { describe, expect, it } from 'vitest'
import { ALERT_SEVERITY, severityOf } from './alerts'

describe('severityOf', () => {
  it('沒帶就用預設表', () => {
    expect(severityOf({ id: 'llmError' })).toBe(ALERT_SEVERITY.llmError)
    expect(severityOf({ id: 'lineWebhookBroken' })).toBe('critical')
  })

  it('探針帶了就用探針的——這是「偶發不升紅」唯一的實作方式', () => {
    expect(severityOf({ id: 'llmError', severity: 'suggestion' })).toBe('suggestion')
    expect(severityOf({ id: 'llmError', severity: 'critical' })).toBe('critical')
  })

  it('每一顆異常在預設表裡都有分級（漏一顆會變 undefined，畫面與推播都會漏掉它）', () => {
    for (const [id, sev] of Object.entries(ALERT_SEVERITY))
      expect(['critical', 'warning', 'suggestion'], `${id} 沒有合法分級`).toContain(sev)
  })
})
