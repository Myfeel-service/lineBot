import { describe, expect, it } from 'vitest'
import { kbImportStepProgress } from './kb-import-step'
import type { KbImportStep } from './kb-import-step'

const ALL: KbImportStep[] = ['input', 'sitePages', 'preview', 'result']

describe('kbImportStepProgress', () => {
  it('⛔總數永遠是 3，兩條路都不會讓它跳動', () => {
    const totals = new Set([
      ...ALL.map(s => kbImportStepProgress(s).total),
      ...ALL.map(s => kbImportStepProgress(s, { siteFinished: true }).total),
    ])
    expect(totals).toEqual(new Set([3]))
  })

  it('正常路：給資料 1 → 看整理結果 2 → 完成 3', () => {
    expect(kbImportStepProgress('input').index).toBe(1)
    expect(kbImportStepProgress('preview').index).toBe(2)
    expect(kbImportStepProgress('result').index).toBe(3)
  })

  it('整站路：選頁面是第 2 步，匯完（同一畫面出結論）就是第 3 步', () => {
    expect(kbImportStepProgress('sitePages').index).toBe(2)
    expect(kbImportStepProgress('sitePages', { siteFinished: true }).index).toBe(3)
  })

  it('步數不會倒退也不會超出總數', () => {
    for (const s of ALL) {
      for (const siteFinished of [false, true]) {
        const p = kbImportStepProgress(s, { siteFinished })
        expect(p.index).toBeGreaterThanOrEqual(1)
        expect(p.index).toBeLessThanOrEqual(p.total)
      }
    }
  })
})
