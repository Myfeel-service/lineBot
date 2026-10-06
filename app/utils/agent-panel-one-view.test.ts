/**
 * 小幫手三個分頁合成一頁（`D-114`，2026-10-05 老闆拍板）的回歸鎖。
 *
 * 為什麼要鎖：以前「問／交辦」排第三格、打開先停在「目前狀況」，紅點講的又都是狀況，
 * 大家把小幫手當警報、想不到能叫它做事（`D-113` 的「一進來找不到」）。這幾條只要有一條被改回去，
 * 那個問題就原樣回來，而且畫面上看起來「也還能用」，不會有人回報。
 * ⚠️ 只驗得到「長相的規矩」；按下去會不會真的發生，交給實機守門員 `scripts/agent-entry-check.mjs`。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AGENT_SELF_ONLY } from '~~/shared/agent-entry'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const agent = readFileSync(`${APP_DIR}components/TutorialAgent.vue`, 'utf8')
const chat = readFileSync(`${APP_DIR}components/AdminAgentChat.vue`, 'utf8')
const help = readFileSync(`${APP_DIR}components/admin/AdminPageHelpButton.vue`, 'utf8')
const scss = readFileSync(`${APP_DIR}assets/scss/components/_tutorial-agent.scss`, 'utf8')
/** 只看模板（註解裡寫著舊做法的字不算） */
const template = (src: string) => src.slice(src.indexOf('<template>'), src.indexOf('<script')).replace(/<!--[\s\S]*?-->/g, '')

describe('小幫手只有一頁（D-114）', () => {
  it('⛔ 沒有分頁', () => {
    expect(template(agent)).not.toMatch(/role="tab"/)
    expect(template(agent)).not.toContain('問／交辦')
  })

  it('「目前狀況」收成最上面那一條，紅的時候自動展開', () => {
    expect(template(agent)).toContain('class="ta-strip"')
    expect(agent).toContain('strip.value.tone === \'danger\'')
  })

  it('⛔ 狀況展開時只藏對話紀錄、不藏輸入框（任何時候都能直接打字）', () => {
    expect(template(chat)).toMatch(/v-show="!props\.listHidden[^"]*"[^>]*class="aa-chat__list"/)
    // 輸入框那一塊本身不帶任何 v-show／v-if（狀況展開、「我會做的 N 件」打開時都要在）
    const input = template(chat).slice(template(chat).indexOf('class="aa-chat__input"') - 200)
    expect(input).not.toMatch(/listHidden|showAll/)
  })

  it('頁尾那行紅線收進「我會做的 N 件」（`D-114` 第 3 題），頁尾不再一直佔著', () => {
    expect(template(agent)).not.toContain('一律要你自己到那一頁按')
    expect(template(agent)).toMatch(/<footer v-if="activeGuide \|\| moved"/)
    expect(template(chat)).toContain('{{ AGENT_SELF_ONLY }}')
    expect(AGENT_SELF_ONLY).toBe('發推播、回客人、刪東西、改 LINE 連線與成員')
    expect(template(chat)).toContain('我會做的 {{ catalogueCount }} 件')
  })

  it('「我會做的 N 件」＝先選一類、再點一句（`D-115`）；點一句只放進輸入框、⛔ 不送出', () => {
    expect(template(chat)).toContain('class="aa-cat__tabs"')
    expect(template(chat)).toContain('@click="pickExample(it.say)"')
    const pick = chat.slice(chat.indexOf('function pickExample'), chat.indexOf('function pickExample') + 200)
    expect(pick).toContain('fillSuggestion(say)')
    expect(pick).not.toMatch(/\bsend\(/)
    // ⛔ 分類那排不能用 role="tab"：小幫手已經沒有分頁了（守門員量的是整個面板裡有沒有分頁）
    expect(template(chat)).not.toMatch(/role="tab"/)
  })

  it('兩處「打開／收起」同一種長相、同一組字（老闆 10-06：「建議處理跟可以這樣說的收合是否用類似的方式做」）', () => {
    // 字：收著朝下的箭頭、打開後一律「收起」——⛔ 不可以一個叫「收起」一個叫「收合」
    expect(template(agent)).toContain('statusOpen ? \'收起\' : \'展開\'')
    expect(template(agent)).toMatch(/statusOpen \? ArrowUp : ArrowDown/)
    expect(template(chat)).toMatch(/收起<el-icon><ArrowUp \/><\/el-icon>/)
    expect(template(chat)).toMatch(/我會做的 \{\{ catalogueCount \}\} 件<el-icon><ArrowDown \/><\/el-icon>/)
    expect(template(chat)).not.toContain('收合')
    // 長相：字級、字重、顏色兩邊同一組值
    const block = (sel: string) => { const at = scss.indexOf(sel); return scss.slice(at, scss.indexOf('}', at)) }
    for (const rule of ['font-size: 0.75rem', 'font-weight: 400', 'color: var(--text-secondary)']) {
      expect(block('&__toggle {'), rule).toContain(rule)
      expect(block('&__all-toggle {'), rule).toContain(rule)
    }
  })

  it('左側欄那一格「跟小幫手說要做什麼…」（`D-113`）：每頁都在、按了只打開對話、⛔ 不替他送話、記成 sidebar', () => {
    const layout = readFileSync(`${APP_DIR}layouts/default.vue`, 'utf8')
    expect(template(layout)).toContain('跟小幫手說要做什麼…')
    expect(template(layout)).toContain('askAgent({ send: false, source: \'sidebar\' })')
  })

  it('每一頁的「？」都有「看全部教學」（全部教學唯一的常駐入口）', () => {
    expect(template(help)).toContain('看全部教學')
    // ⛔ 只有一支教學時直接開跑的那條捷徑拿掉了，否則那些頁面就找不到全部教學
    expect(template(help)).not.toContain('available.length === 1')
  })

  it('面板高度固定：展開狀況、打開全部教學，外框都不動（老闆 10-05「統一高度」）', () => {
    // 行首那一個才是面板本體（上面拖曳中那段也有一個巢狀的 `.ta-panel {`）
    const at = scss.search(/^\.ta-panel \{/m)
    const block = scss.slice(at, at + 900)
    expect(block).toMatch(/\n\s*height: min\(/)
    expect(block).toContain('max-height: var(--ta-dock-panelh, none)')
  })
})
