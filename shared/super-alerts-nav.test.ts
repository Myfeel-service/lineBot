import { describe, expect, it } from 'vitest'
import { superAlertsNav } from './super-alerts-nav'
import type { SuperAlertsOverviewPayload, SuperImageReadFailures } from './types/super-alerts'

/** 超管側欄「異常總覽」那顆點（C-91；`C-164` 加讀圖） */

const OK_USAGE = { invocations: 0, billable: 0, ratio: null, flagged: false } as SuperAlertsOverviewPayload['workspaces'][number]['usage']

function payload(over: Partial<SuperAlertsOverviewPayload> = {}): SuperAlertsOverviewPayload {
  return {
    checkedAt: 0,
    heartbeat: { state: 'ok', lastRunAt: 1, ageMinutes: 1 },
    workspaces: [{ id: 'ws1', name: 'MYFEEL', items: [], probedCount: 10, usage: OK_USAGE }],
    truncated: false,
    newLeads: 0,
    aiMistakes: [],
    imageReadFailures: null,
    ...over,
  }
}

function imgs(over: Partial<SuperImageReadFailures> = {}): SuperImageReadFailures {
  return { windowDays: 7, total: 0, truncated: false, burst: null, workspaces: [], ...over }
}

describe('superAlertsNav', () => {
  it('還沒載到 → 不畫', () => {
    expect(superAlertsNav(null)).toEqual({ severity: null, tip: '' })
  })

  it('都沒事 → 不畫（⛔不畫綠燈）', () => {
    expect(superAlertsNav(payload({ imageReadFailures: imgs() })).severity).toBeNull()
  })

  it('🔴 客人傳的圖一小時內連著讀不出來 → 紅，滑上去講是這件事', () => {
    const nav = superAlertsNav(payload({ imageReadFailures: imgs({ total: 4, burst: { count: 4, startMs: 1, endMs: 2 } }) }))
    expect(nav).toEqual({ severity: 'critical', tip: '客人傳的圖一小時內有 4 張讀不出來' })
  })

  it('偶發一兩張（沒連著壞）→ 不亮點：偶發不吵，清單在總覽頁上', () => {
    const nav = superAlertsNav(payload({ imageReadFailures: imgs({ total: 2, workspaces: [] }) }))
    expect(nav.severity).toBeNull()
  })

  it('查不到（null）→ 不亮點也不畫綠，誠實狀態在總覽頁講', () => {
    expect(superAlertsNav(payload({ imageReadFailures: null })).severity).toBeNull()
  })

  it('原本的三種照舊：排程停擺／有帳號紅色異常 → 紅；高成本 → 琥珀', () => {
    expect(superAlertsNav(payload({ heartbeat: { state: 'stalled', lastRunAt: 1, ageMinutes: 90 } })))
      .toEqual({ severity: 'critical', tip: '背景排程停擺' })
    expect(superAlertsNav(payload({
      workspaces: [{ id: 'ws1', name: 'A', items: [{ id: 'lineWebhookBroken', state: 'active' }], probedCount: 1, usage: OK_USAGE }],
    }))).toEqual({ severity: 'critical', tip: '有帳號的客人正在受影響' })
    expect(superAlertsNav(payload({
      workspaces: [{ id: 'ws1', name: 'A', items: [], probedCount: 1, usage: { ...OK_USAGE, flagged: true } }],
    }))).toEqual({ severity: 'warning', tip: '有事情建議處理' })
  })

  it('同時好幾件紅的 → 一句講完全部（點是紅的、頁上找不到原因比沒有點更糟）', () => {
    const nav = superAlertsNav(payload({
      heartbeat: { state: 'stalled', lastRunAt: 1, ageMinutes: 90 },
      imageReadFailures: imgs({ total: 3, burst: { count: 3, startMs: 1, endMs: 2 } }),
    }))
    expect(nav.tip).toBe('背景排程停擺；客人傳的圖一小時內有 3 張讀不出來')
  })
})
