import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 守門測試：「還沒有現成資料？」三條路的**選項順序**與**面板順序**必須一致。
 *
 * 為什麼值得寫：2026-09-13 改推薦順序（見元件裡「三版」那段註解）時，三顆膠囊搬了位置，
 * 但三塊展開面板還留在原地。**這種不一致畫面上完全看不出來**——一次只會有一塊面板出現，
 * 點哪顆就開哪塊，眼睛看起來永遠是對的。代價要到下一個人維護時才出現：
 * 他照畫面順序去改「第一條」，改到的卻是別條的內容，而且沒有任何測試會紅。
 *
 * 順帶守住 Vue 的 v-if / v-else-if 鏈：三塊面板是互斥的，第一塊必須是 v-if、其餘是 v-else-if。
 * 搬動區塊時很容易留下兩個 v-if（行為不變、但鏈斷了）或把 v-else-if 排到 v-if 前面（編譯錯）。
 *
 * ⛔ 這裡刻意**不驗文案**：小註與說明常改，寫進測試只會變成每次改字都要來改測試的稅。
 *    驗的是「順序」這個結構事實。
 */

const SRC = readFileSync(
  fileURLToPath(new URL('./KnowledgeImportDialog.vue', import.meta.url)),
  'utf8',
)

/** 只取 template：script 裡也有 'sheet' | 'web' | 'excel' 的型別宣告，會干擾順序判讀 */
function template(): string {
  const end = SRC.indexOf('<script setup')
  return end > 0 ? SRC.slice(0, end) : SRC
}

/** 三顆膠囊：照原始碼出現順序取 pickStart('x') 的 x */
function chipOrder(tpl: string): string[] {
  return [...tpl.matchAll(/@click="pickStart\('([a-z]+)'\)"/g)].map(m => m[1]!)
}

/** 三塊面板：照原始碼出現順序取 startOpen === 'x' 的 x 與它用的指令 */
function panelOrder(tpl: string): { route: string, directive: string }[] {
  return [...tpl.matchAll(/<div v-(if|else-if)="startOpen === '([a-z]+)'" class="kb-start__panel">/g)]
    .map(m => ({ directive: m[1]!, route: m[2]! }))
}

describe('「還沒有現成資料？」三條路', () => {
  const tpl = template()

  it('面板的原始碼順序跟膠囊一致（畫面看不出來，只有維護時會中招）', () => {
    const chips = chipOrder(tpl)
    const panels = panelOrder(tpl).map(p => p.route)

    expect(chips, '找不到三顆膠囊的 pickStart(...)').toHaveLength(3)
    expect(
      panels,
      `膠囊順序是 ${chips.join(' → ')}，面板順序卻是 ${panels.join(' → ')}。\n`
      + '修法：把面板區塊搬成跟膠囊一樣的順序（只搬位置，內容別動），並記得第一塊要是 v-if。',
    ).toEqual(chips)
  })

  it('三塊面板是一條完整的 v-if / v-else-if 鏈', () => {
    const panels = panelOrder(tpl)
    const directives = panels.map(p => p.directive)

    expect(
      directives,
      `面板的指令是 ${directives.join(' / ')}。第一塊必須 v-if、其餘 v-else-if——`
      + '留下兩個 v-if 雖然現在看起來正常（startOpen 一次只會等於一個值），但鏈一斷，'
      + '之後任何人加第四條路都會踩到兩塊同時出現。',
    ).toEqual(['if', 'else-if', 'else-if'])
  })

  it('Google 試算表排第一（2026-09-13 拍板的推薦順序）', () => {
    const chips = chipOrder(tpl)
    expect(
      chips[0],
      '推薦順序是拍板過的：試算表精準度最高（一列一卡，AI 不用猜分段），\n'
      + '而且是唯一「資料改了會自己更新」的來源（排程只處理 url／gsheet，檔案型完全不在裡面）。\n'
      + '要改順序請先更新元件裡「三版」那段註解，再改這條測試——別默默對調。',
    ).toBe('sheet')
  })

  it('下載範本排最後（它是唯一「改了不會自己更新、也不會提醒」的路）', () => {
    expect(chipOrder(tpl).at(-1)).toBe('excel')
  })
})
