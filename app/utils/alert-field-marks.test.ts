/**
 * 「壞掉的就是這一格」規則測試。
 *
 * 為什麼值得一支測試：這個標記的失效方式**在畫面上跟「一切正常」長得一樣**——
 * 該標的沒標，頁面看起來就只是一個普通頁面，沒有人會發現它壞了（同側欄那顆點）。
 * 三個真的會出事的判斷各釘一條：指不出格子的異常、使用者動不了手的異常、撞到同一格。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ALERT_MARK_ATTR, ALERT_MARK_LABEL_ATTR, ALERT_MARK_REL_ATTR, alertFieldMarks, clearAlertFieldMarks, paintAlertFieldMark } from './alert-field-marks'
import type { AlertMarkSource } from './alert-field-marks'

function src(over: Partial<AlertMarkSource> & Pick<AlertMarkSource, 'id'>): AlertMarkSource {
  return {
    title: `標題-${over.id}`,
    severity: 'critical',
    ...over,
  }
}

describe('要標哪些格子', () => {
  it('沿用「帶我看」的錨點：能處理它的區塊通常就是壞掉的那一格', () => {
    const marks = alertFieldMarks([
      src({ id: 'anyTextBlocking', anchor: { selector: '[data-tour="scr-list"]' } }),
    ])
    expect(marks).toEqual([
      { selector: '[data-tour="scr-list"]', tone: 'critical', label: '標題-anyTextBlocking' },
    ])
  })

  it('mark 蓋過 anchor：「能處理的區塊」跟「壞掉的那一格」不同時要標後者', () => {
    const marks = alertFieldMarks([
      src({
        id: 'quotaExceeded',
        mark: '[data-tour="bill-quota"]',
        anchor: { selector: '[data-tour="something-else"]' },
      }),
    ])
    expect(marks[0]?.selector).toBe('[data-tour="bill-quota"]')
  })

  it('指不出格子的異常不標——圈一個「大概在這附近」比不圈更糟', () => {
    expect(alertFieldMarks([src({ id: 'renewalNotBound' })])).toEqual([])
  })
})

describe('哪些異常刻意不標', () => {
  it('系統這邊的狀況不標：圈起來只會讓人對著沒東西可按的區塊找半天', () => {
    const marks = alertFieldMarks([
      src({ id: 'llmError', owner: 'system', anchor: { selector: '[data-tour="usg-cases"]' } }),
    ])
    expect(marks).toEqual([])
  })

  it('但有「幫我修」就標——有按鈕可按時「不用你操作」那句話就不是真的了', () => {
    const marks = alertFieldMarks([
      src({
        id: 'knowledgeIndexStuck',
        owner: 'system',
        fixOpId: 'knowledge-retry-index-stuck',
        anchor: { selector: '[data-tour="kb-health"]' },
      }),
    ])
    expect(marks).toHaveLength(1)
  })

  it('建議類不標——沒有東西壞掉，圈起來會變裝飾', () => {
    const marks = alertFieldMarks([
      src({ id: 'knowledgeSuggestions', severity: 'suggestion', anchor: { selector: '[data-tour="kb-health"]' } }),
    ])
    expect(marks).toEqual([])
  })
})

describe('撞到同一格', () => {
  it('紅排在琥珀前面（撞格子時紅蓋過琥珀，與側欄那顆點同一條規則）', () => {
    const marks = alertFieldMarks([
      src({ id: 'scriptUnreachable', severity: 'warning', anchor: { selector: '[data-tour="scr-list"]' } }),
      src({ id: 'scriptDeadEnd', severity: 'critical', anchor: { selector: '[data-tour="conv-tabs"]' } }),
    ])
    expect(marks.map(m => m.tone)).toEqual(['critical', 'warning'])
  })

  it('同一個選擇器只留一次，留比較嚴重的那句話（否則同一格會被標兩次、標籤打架）', () => {
    const marks = alertFieldMarks([
      src({ id: 'scriptDeadEnd', severity: 'critical', anchor: { selector: '[data-tour="scr-list"]' } }),
      src({ id: 'scriptUnreachable', severity: 'warning', anchor: { selector: '[data-tour="scr-list"]' } }),
    ])
    expect(marks).toEqual([
      { selector: '[data-tour="scr-list"]', tone: 'critical', label: '標題-scriptDeadEnd' },
    ])
  })
})

/**
 * 最小假 DOM：只支援這支程式真的用到的三件事（querySelectorAll、屬性存取、量 position）。
 * 專案的 vitest 是 node 環境沒有 DOM，而畫框那段**不能只靠讀 code 確認**——
 * 屬性沒掛上去時畫面看起來就只是一個普通頁面，不會有任何錯誤訊息。
 */
class FakeEl {
  attrs = new Map<string, string>()
  constructor(public sel: string, public position = 'static') {}
  getAttribute(n: string) { return this.attrs.get(n) ?? null }
  setAttribute(n: string, v: string) { this.attrs.set(n, v) }
  removeAttribute(n: string) { this.attrs.delete(n) }
  get ownerDocument() {
    return { defaultView: { getComputedStyle: () => ({ position: this.position }) } }
  }
}

function fakeRoot(els: FakeEl[]) {
  return {
    querySelectorAll(selector: string) {
      if (selector === `[${ALERT_MARK_ATTR}]`)
        return els.filter(e => e.attrs.has(ALERT_MARK_ATTR))
      const wanted = selector.split(',').map(s => s.trim())
      return els.filter(e => wanted.includes(e.sel))
    },
  } as unknown as Document
}

describe('把框畫到 DOM 上', () => {
  it('一顆異常圈到好幾格時，只有第一格掛那句話（同一句印兩次是雜訊）', () => {
    const tok = new FakeEl('[data-tour="org-token"]')
    const sec = new FakeEl('[data-tour="org-secret"]')
    const painted = paintAlertFieldMark(fakeRoot([tok, sec]), {
      selector: '[data-tour="org-token"], [data-tour="org-secret"]',
      tone: 'critical',
      label: 'LINE 官方帳號還沒接上',
    })
    expect(painted).toBe(2)
    expect(tok.getAttribute(ALERT_MARK_ATTR)).toBe('critical')
    expect(sec.getAttribute(ALERT_MARK_ATTR)).toBe('critical')
    expect(tok.getAttribute(ALERT_MARK_LABEL_ATTR)).toBe('LINE 官方帳號還沒接上')
    expect(sec.getAttribute(ALERT_MARK_LABEL_ATTR)).toBeNull()
  })

  it('這一頁沒有那個區塊 → 圈到 0 格，不會亂標別的東西', () => {
    const other = new FakeEl('[data-tour="bc-list"]')
    expect(paintAlertFieldMark(fakeRoot([other]), {
      selector: '[data-tour="org-token"]',
      tone: 'critical',
      label: '不該出現',
    })).toBe(0)
    expect(other.attrs.size).toBe(0)
  })

  it('原本就有定位的元素不補 position:relative（⛔別把頁面的 sticky 靜靜弄壞）', () => {
    const stat = new FakeEl('[data-tour="a"]', 'static')
    const stick = new FakeEl('[data-tour="b"]', 'sticky')
    paintAlertFieldMark(fakeRoot([stat, stick]), { selector: '[data-tour="a"], [data-tour="b"]', tone: 'warning', label: 'x' })
    expect(stat.attrs.has(ALERT_MARK_REL_ATTR)).toBe(true)
    expect(stick.attrs.has(ALERT_MARK_REL_ATTR)).toBe(false)
  })

  it('撞到同一格：琥珀不蓋紅，紅可以把琥珀升上來', () => {
    const el = new FakeEl('[data-tour="scr-list"]')
    const root = fakeRoot([el])
    paintAlertFieldMark(root, { selector: '[data-tour="scr-list"]', tone: 'critical', label: '紅的' })
    paintAlertFieldMark(root, { selector: '[data-tour="scr-list"]', tone: 'warning', label: '黃的' })
    expect(el.getAttribute(ALERT_MARK_ATTR)).toBe('critical')
    expect(el.getAttribute(ALERT_MARK_LABEL_ATTR)).toBe('紅的')

    const el2 = new FakeEl('[data-tour="scr-list"]')
    const root2 = fakeRoot([el2])
    paintAlertFieldMark(root2, { selector: '[data-tour="scr-list"]', tone: 'warning', label: '黃的' })
    paintAlertFieldMark(root2, { selector: '[data-tour="scr-list"]', tone: 'critical', label: '紅的' })
    expect(el2.getAttribute(ALERT_MARK_ATTR)).toBe('critical')
  })

  it('重標之前會全部收乾淨——修好的格子不能一直圈著', () => {
    const el = new FakeEl('[data-tour="org-token"]')
    const root = fakeRoot([el])
    paintAlertFieldMark(root, { selector: '[data-tour="org-token"]', tone: 'critical', label: '還沒接上' })
    clearAlertFieldMarks(root)
    expect(el.attrs.size).toBe(0)
  })
})

describe('標記真的會被畫出來', () => {
  /**
   * 這兩條守的是**最安靜的失效方式**：規則算得再對，只要元件沒去呼叫、
   * 或樣式沒有對應的選擇器，畫面上就完全看不出差別，而且不會有任何錯誤訊息
   * （2026-08-23 教訓：typecheck 綠 + 既有測試綠 ≠ 新程式真的被執行過）。
   */
  it('提醒帶真的有算標記、也真的有去畫', () => {
    const strip = readFileSync(
      fileURLToPath(new URL('../components/admin/AdminPageAlertStrip.vue', import.meta.url)),
      'utf8',
    )
    expect(strip).toContain('alertFieldMarks')
    expect(strip).toContain('paintAlertFieldMark')
    expect(strip).toContain('clearAlertFieldMarks')
  })

  it('樣式檔有對應的選擇器，而且 main.scss 真的載了它', () => {
    const scss = readFileSync(
      fileURLToPath(new URL('../assets/scss/components/_alert-field-mark.scss', import.meta.url)),
      'utf8',
    )
    expect(scss).toContain('[data-alert-mark]')
    expect(scss).toContain('[data-alert-mark="warning"]')
    const main = readFileSync(
      fileURLToPath(new URL('../assets/scss/main.scss', import.meta.url)),
      'utf8',
    )
    expect(main).toContain('@use "./components/alert-field-mark"')
  })
})
