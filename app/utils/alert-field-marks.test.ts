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
import { ALERT_MARK_ATTR, ALERT_MARK_INSET_ATTR, ALERT_MARK_LABEL_ATTR, ALERT_MARK_REL_ATTR, alertFieldMarks, clearAlertFieldMarks, markRingFitsOutside, paintAlertFieldMark } from './alert-field-marks'
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

/**
 * 會量位置的假 DOM（量框與標籤放不放得下用）：多支援 parentElement、getBoundingClientRect
 * 與 overflow。⚠️上面那個 FakeEl 刻意不加這些——它守的是「量不到位置時要退回原本的外描邊」。
 */
interface FakeRect { left: number, right: number, top: number, bottom: number }

class FakeBoxEl {
  attrs = new Map<string, string>()
  parentElement: FakeBoxEl | null = null
  scrollTop = 0
  scrollLeft = 0
  scrollHeight = 0
  clientHeight = 0
  scrollWidth = 0
  clientWidth = 0
  constructor(
    public sel: string,
    public rect: FakeRect,
    public style: Record<string, string> = {},
  ) {}

  getAttribute(n: string) { return this.attrs.get(n) ?? null }
  setAttribute(n: string, v: string) { this.attrs.set(n, v) }
  removeAttribute(n: string) { this.attrs.delete(n) }
  getBoundingClientRect() { return this.rect }
  child(el: FakeBoxEl) { el.parentElement = this; return el }
  get ownerDocument() {
    return {
      defaultView: {
        getComputedStyle: (el: FakeBoxEl) => ({
          position: 'static',
          overflowX: 'visible',
          overflowY: 'visible',
          ...el.style,
        }),
      },
    }
  }
}

function asEl(el: FakeBoxEl) { return el as unknown as HTMLElement }

describe('框畫哪裡、標籤放哪裡', () => {
  /** 側欄：`.split-list-container{overflow:hidden}` 裡塞一列跟它一樣寬的分頁列 */
  function sidebarRow() {
    const container = new FakeBoxEl('.split-list-container', { left: 220, right: 500, top: 140, bottom: 800 }, { overflowX: 'hidden', overflowY: 'hidden' })
    return container.child(new FakeBoxEl('[data-tour="conv-tabs"]', { left: 220, right: 500, top: 140, bottom: 226 }))
  }

  it('全出血的整列：框畫在外面會被容器切掉 → 改內描邊', () => {
    expect(markRingFitsOutside(asEl(sidebarRow()))).toBe(false)
  })

  it('外面放得下就維持外描邊：知識庫「要處理的事」外面有 48px，框沒壞不要順手改掉', () => {
    const stage = new FakeBoxEl('.split-empty-state', { left: 0, right: 900, top: 0, bottom: 900 }, { overflowX: 'auto', overflowY: 'auto' })
    stage.scrollHeight = 900
    stage.clientHeight = 900
    const todo = stage.child(new FakeBoxEl('[data-tour="kb-health"]', { left: 48, right: 852, top: 200, bottom: 600 }, { overflowX: 'hidden', overflowY: 'hidden' }))
    expect(markRingFitsOutside(asEl(todo))).toBe(true)
  })

  it('卡片裡的表單欄位：外面放得下，維持原本的外描邊', () => {
    const card = new FakeBoxEl('.message-card', { left: 0, right: 900, top: 0, bottom: 400 }, { overflowX: 'hidden', overflowY: 'hidden' })
    const field = card.child(new FakeBoxEl('[data-tour="org-liff"]', { left: 16, right: 884, top: 16, bottom: 200 }))
    expect(markRingFitsOutside(asEl(field))).toBe(true)
  })

  it('在摺線以下的格子照樣放得下：量的是內容裡有沒有空間，不是現在看得到的那一格畫面', () => {
    // 後台表單頁的真實骨架：會捲的是 .split-editor-body，外面還包著一整疊 overflow:hidden
    // 的容器（.split-editor-inner / .split-editor / .split-layout / .main-content…）
    const outer = new FakeBoxEl('.split-editor-inner', { left: 0, right: 900, top: 0, bottom: 800 }, { overflowX: 'hidden', overflowY: 'hidden' })
    const scroller = outer.child(new FakeBoxEl('.split-editor-body', { left: 0, right: 900, top: 0, bottom: 800 }, { overflowX: 'hidden', overflowY: 'auto' }))
    scroller.scrollHeight = 2000
    scroller.clientHeight = 800
    const field = scroller.child(new FakeBoxEl('[data-tour="bill-quota"]', { left: 40, right: 860, top: 1100, bottom: 1300 }))
    expect(markRingFitsOutside(asEl(field))).toBe(true)
    // 捲到底、格子貼在可視區上緣時也要是同一個答案（⛔不可以因為捲到哪裡而換一種畫法）
    scroller.scrollTop = 1200
    field.rect = { left: 40, right: 860, top: -100, bottom: 100 }
    expect(markRingFitsOutside(asEl(field))).toBe(true)
  })

  it('量不到位置（還沒進畫面）就當放得下——最差是回到原本的樣子，不會亂改版面', () => {
    expect(markRingFitsOutside(new FakeEl('[data-tour="conv-tabs"]') as unknown as HTMLElement)).toBe(true)
  })

  it('畫框時真的會把屬性掛上去、收框時真的會拔掉（沒掛＝樣式整套不會生效）', () => {
    const el = sidebarRow()
    const root = {
      querySelectorAll: (selector: string) =>
        selector === `[${ALERT_MARK_ATTR}]` ? [el].filter(e => e.attrs.has(ALERT_MARK_ATTR)) : [el],
    } as unknown as Document
    paintAlertFieldMark(root, { selector: '[data-tour="conv-tabs"]', tone: 'warning', label: '有客人在等真人回覆' })
    expect(el.getAttribute(ALERT_MARK_INSET_ATTR)).toBe('')
    clearAlertFieldMarks(root)
    expect(el.getAttribute(ALERT_MARK_INSET_ATTR)).toBeNull()
  })

  it('補畫時會重量一次：第一次畫的時候清單還是空的，長出來之後位置不一樣', () => {
    const el = sidebarRow()
    const root = { querySelectorAll: () => [el] } as unknown as Document
    const mark = { selector: '[data-tour="conv-tabs"]', tone: 'warning' as const, label: '有客人在等真人回覆' }
    paintAlertFieldMark(root, mark)
    expect(el.getAttribute(ALERT_MARK_INSET_ATTR)).toBe('')
    // 側欄被拖寬、外面挪出空間之後（同一顆異常、同一格）：框要換回外描邊
    el.rect = { left: 240, right: 480, top: 160, bottom: 226 }
    paintAlertFieldMark(root, mark)
    expect(el.getAttribute(ALERT_MARK_INSET_ATTR)).toBeNull()
  })
})

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
    // JS 掛了屬性但樣式沒有對應規則的話，框照樣會被切
    expect(scss).toContain('[data-alert-mark-inset]')
    expect(scss).toContain('alert-field-mark-pulse-inset')
    // 那句話一律收進框裡：少了讓位的內距，標籤就會直接壓在內容上（實測蓋掉帳單頁的用量數字）
    expect(scss).toContain('padding-block-start: 1.65rem !important')
    const main = readFileSync(
      fileURLToPath(new URL('../assets/scss/main.scss', import.meta.url)),
      'utf8',
    )
    expect(main).toContain('@use "./components/alert-field-mark"')
  })
})
