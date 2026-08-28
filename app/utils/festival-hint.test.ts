/**
 * 後台節慶提示的判定測試。
 *
 * 為什麼值得測：它的失效方式是「該出現的沒出現」——畫面上跟平常一模一樣，
 * 沒有錯誤訊息，沒有人會發現（同側欄狀態點、欄位圈框的理由）。
 * 日期用節日表裡查證過的中秋節 2026-09-25 當錨。
 */
import { describe, expect, it } from 'vitest'
import { festivalHint } from './festival-hint'

describe('節日 7 天窗', () => {
  it('窗外（前 20 天）→ 不顯示，元件整塊不渲染', () => {
    expect(festivalHint('2026-09-05')).toBeNull()
  })

  it('前 7 天進窗：講「備素材」那一檔', () => {
    const h = festivalHint('2026-09-18')
    expect(h?.name).toBe('中秋節')
    expect(h?.daysUntil).toBe(7)
    expect(h?.text).toContain('再過 7 天就是中秋節')
    expect(h?.text).toContain('先把檔期優惠')
  })

  it('剩 3 天換檔：講「今天就去排推播」——跟 LINE 上同一句', () => {
    const h = festivalHint('2026-09-22')
    expect(h?.text).toContain('再過 3 天就是中秋節')
    expect(h?.text).toContain('推播')
  })

  it('節日當天還在：講「今天」，過了才消失', () => {
    expect(festivalHint('2026-09-25')?.daysUntil).toBe(0)
    // 隔天就沒了（過了的節日不追講）——除非又踩進下一個節日的窗
    const after = festivalHint('2026-09-26')
    if (after) expect(after.name).not.toBe('中秋節')
  })

  it('後台是常駐的：窗內每一天都有話講（不像 LINE 講過一次就閉嘴）', () => {
    for (const d of ['2026-09-19', '2026-09-20', '2026-09-21', '2026-09-23', '2026-09-24']) {
      expect(festivalHint(d), d).not.toBeNull()
    }
  })
})
