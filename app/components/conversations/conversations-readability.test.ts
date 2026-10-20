import { fileURLToPath } from 'node:url'
import * as sass from 'sass'
import { describe, expect, it } from 'vitest'
import { CUSTOMER_PANEL_MIN_EDITOR_PX, editorTooNarrowForCustomerColumn } from '~/utils/conversation-layout'

/**
 * `D-76` 客服對話頁「先好讀」：量出來要修的幾件，鎖在這裡（拿掉修正會紅）。
 * 畫面上的量測（對比、盒子重疊、1100 寬時訊息拿回整個寬度）在 headless 實走那一支；
 * 這裡鎖「規則還在」——把 _conversations.scss 真的編譯一次，看編出來的 CSS，不看原始碼字串。
 */

// ── 很小的 CSS 解析：只為了在編譯結果裡找「哪條規則、在不在哪個 @media 裡、宣告了什麼」 ──
/** 編譯結果會留著註解（說明舊寫法的註解會提到舊的規則），一律先剝掉 */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '')
interface Rule { selectors: string[], media: string, decls: Record<string, string> }
function parseCss(css: string): Rule[] {
  const rules: Rule[] = []
  const stack: string[] = []
  let buf = ''
  for (const ch of stripComments(css)) {
    // 選擇器前面可能還黏著上一句（例如最前面的 @charset "UTF-8";），只取最後一個分號之後那段
    if (ch === '{') { stack.push(buf.split(';').pop()!.trim()); buf = '' }
    else if (ch === '}') {
      const prelude = stack.pop() ?? ''
      if (!prelude.startsWith('@')) {
        const decls: Record<string, string> = {}
        for (const d of buf.split(';')) {
          const i = d.indexOf(':')
          if (i > 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).trim()
        }
        rules.push({ selectors: prelude.split(',').map(s => s.trim().replace(/\s+/g, ' ')), media: stack.filter(s => s.startsWith('@')).join(' '), decls })
      }
      buf = ''
    }
    else buf += ch
  }
  return rules
}

const css = sass.compile(fileURLToPath(new URL('../../assets/scss/pages/_conversations.scss', import.meta.url)), { style: 'expanded' }).css
const rules = parseCss(css)
/** 某個選擇器（可以在某個 @media 裡）最後宣告的那個值——跟瀏覽器一樣，後面的蓋前面的 */
function declOf(selector: string, prop: string, media = ''): string | undefined {
  let found: string | undefined
  for (const r of rules) {
    if (r.media !== media) continue
    if (r.selectors.includes(selector) && r.decls[prop] !== undefined) found = r.decls[prop]
  }
  return found
}

describe('`D-76` 對話區不夠寬就不掛右邊那一欄客人檔案', () => {
  it('門檻 800px：1100 寬（對話區 620）改抽屜；1280 以上（≥ 800）照舊掛著', () => {
    expect(CUSTOMER_PANEL_MIN_EDITOR_PX).toBe(800)
    expect(editorTooNarrowForCustomerColumn(620, false)).toBe(true)
    expect(editorTooNarrowForCustomerColumn(799, false)).toBe(true)
    expect(editorTooNarrowForCustomerColumn(800, true)).toBe(false)
    expect(editorTooNarrowForCustomerColumn(960, true)).toBe(false)
  })

  it('量到 0（這一刻藏著）維持原值，不要亂翻', () => {
    expect(editorTooNarrowForCustomerColumn(0, true)).toBe(true)
    expect(editorTooNarrowForCustomerColumn(0, false)).toBe(false)
  })

  it('⛔ 那條從來沒生效過的 @container 規則已經拿掉（這頁沒有容器宣告）', () => {
    expect(stripComments(css)).not.toMatch(/@container/)
  })

  it('右邊那一欄不在時，電腦版回覆列讓出右下角小幫手的位置（送出不被蓋）', () => {
    expect(declOf('.conversations-page .conv-body-split:not(.has-customer-column) .conv-input-row', 'padding-right', '@media (min-width: 721px)'))
      .toBe('calc(1.5rem + 58px + 10px)')
  })
})

describe('`D-76` 字讀得清楚：內容字不用 muted 灰、不低於 12px', () => {
  it('清單第二行（訊息預覽）與時間：次要色、12px；客人講的那一行主文字色（主次照舊）', () => {
    expect(declOf('.conversations-page .split-list-meta-text', 'color')).toBe('var(--text-secondary)')
    expect(declOf('.conversations-page .split-list-meta-text', 'font-size')).toBe('0.75rem')
    expect(declOf('.conversations-page .split-list-item__time', 'color')).toBe('var(--text-secondary)')
    expect(declOf('.conversations-page .split-list-meta.is-strong .split-list-meta-text', 'color')).toBe('var(--text-primary)')
  })

  it('泡泡旁的時間、誰回的標籤、為什麼這樣答：次要色，字級吃 12px 那一格', () => {
    expect(declOf('.conversations-page', '--line-font-meta')).toBe('0.75rem')
    expect(declOf('.conversations-page .conv-bubble-meta', 'color')).toBe('var(--text-secondary)')
    expect(declOf('.conversations-page .conv-bubble-wrap.incoming .conv-bubble-meta', 'color')).toBe('var(--text-secondary)')
    expect(declOf('.conversations-page .conv-bubble-wrap.outgoing .conv-bubble-meta', 'color')).toBe('var(--text-secondary)')
    expect(declOf('.conversations-page .conv-sender-tag', 'color')).toBe('var(--text-secondary)')
    expect(declOf('.conversations-page .conv-sender-tag', 'font-size')).toBe('var(--line-font-meta)')
    expect(declOf('.conversations-page .conv-bubble-why', 'color')).toBe('var(--text-secondary)')
  })

  it('「我接手」「客人檔案 →」的字用可讀深綠（亮綠字只有 2.1:1）', () => {
    expect(declOf('.conversations-page .conv-session-actions .el-button--primary.is-plain', '--el-button-text-color')).toBe('var(--brand-green-text)')
    expect(declOf('.conversations-page .conv-header-row--identity .conv-customer-reopen.el-button--primary', '--el-button-text-color')).toBe('var(--brand-green-text)')
  })
})

describe('`D-76` 手機', () => {
  it('觸控裝置上「⋯」一直露著，標題那一行讓出它的位置（不再蓋住時間）', () => {
    expect(declOf('.conversations-page .conv-list-row .split-list-item__title-row', 'padding-right', '@media (hover: none)')).toBe('1.6rem')
  })

  it('標頭按鈕手機上 32px（點得準）', () => {
    expect(declOf('.conversations-page .conv-header-row--session', '--conv-header-control-h', '@media (max-width: 720px)')).toBe('32px')
    expect(declOf('.conversations-page .conv-session-actions .el-button', 'height', '@media (max-width: 720px)')).toBe('32px')
  })
})
