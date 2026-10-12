import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 守門測試：「手上有什麼？」那幾格的**順序**，與展開面板的**順序**必須一致。
 *
 * 為什麼值得寫：2026-09-13 改推薦順序時，膠囊搬了位置，但展開面板還留在原地。
 * **這種不一致畫面上完全看不出來**——一次只會有一塊面板出現，點哪顆就開哪塊，
 * 眼睛看起來永遠是對的。代價要到下一個人維護時才出現：他照畫面順序去改「第一條」，
 * 改到的卻是別條的內容，而且沒有任何測試會紅。
 *
 * 2026-10-12 五版（`D-123`）改成四格之後，「檔案」那格不展開面板（點了直接開選檔視窗），
 * 所以面板順序＝格子順序拿掉「檔案」。
 *
 * 順帶守住 Vue 的 v-if / v-else-if 鏈：面板是互斥的，第一塊必須 v-if、其餘 v-else-if。
 * 搬動區塊時很容易留下兩個 v-if（行為不變、但鏈斷了）或把 v-else-if 排到 v-if 前面（編譯錯）。
 *
 * ⛔ 這裡刻意**不驗文案**：小註與說明常改，寫進測試只會變成每次改字都要來改測試的稅。
 *    驗的是「順序」這個結構事實。
 */

const SRC = readFileSync(
  fileURLToPath(new URL('./KnowledgeImportDialog.vue', import.meta.url)),
  'utf8',
)

/**
 * 拍板的順序（2026-10-12 `D-123`①）：照「手上有什麼」排，最常見的放前面——
 *  · file  手邊已經有東西的最多（型錄、價目表、說明書、拍的照片）；
 *  · web   有官網就零工作量；
 *  · sheet 改了表格 AI 會自己跟著更新，但要先設定一次（約 3 分鐘）；
 *  · text  還沒整理好：直接打幾題，範本收在這一格裡。
 * 以前（2026-09-13 三／四版）是照「之後改了會怎樣」排、試算表第一——一般人選之前得先學那個概念，這正是 `D-123` 要拿掉的。
 * 要改順序請先更新元件裡「五版」那段註解，再改這個陣列——別默默對調。
 */
const EXPECTED_ORDER = ['file', 'web', 'sheet', 'text']
/** 不展開面板的格子：點了直接做事（開選檔視窗） */
const NO_PANEL = new Set(['file'])

/** 只取 template：script 裡也有同名字串的型別宣告，會干擾順序判讀 */
function template(): string {
  const end = SRC.indexOf('<script setup')
  return end > 0 ? SRC.slice(0, end) : SRC
}

/** 格子：照原始碼出現順序取 pickStart('x') 的 x */
function tileOrder(tpl: string): string[] {
  return [...tpl.matchAll(/@click="pickStart\('([a-z]+)'\)"/g)].map(m => m[1]!)
}

/** 面板：照原始碼出現順序取 startOpen === 'x' 的 x 與它用的指令 */
function panelOrder(tpl: string): { route: string, directive: string }[] {
  return [...tpl.matchAll(/<div v-(if|else-if)="startOpen === '([a-z]+)'" class="kb-start__panel">/g)]
    .map(m => ({ directive: m[1]!, route: m[2]! }))
}

describe('「手上有什麼？」的起步格子', () => {
  const tpl = template()

  it('面板的原始碼順序跟格子一致（畫面看不出來，只有維護時會中招）', () => {
    const tiles = tileOrder(tpl)
    const withPanel = tiles.filter(t => !NO_PANEL.has(t))
    const panels = panelOrder(tpl).map(p => p.route)

    expect(tiles.length, '找不到格子的 pickStart(...)').toBeGreaterThan(0)
    expect(
      panels,
      `格子順序是 ${withPanel.join(' → ')}（不含直接開選檔的「檔案」），面板順序卻是 ${panels.join(' → ')}。\n`
      + '修法：把面板區塊搬成跟格子一樣的順序（只搬位置、內容別動），並記得第一塊要是 v-if。',
    ).toEqual(withPanel)
  })

  it('面板是一條完整的 v-if / v-else-if 鏈', () => {
    const panels = panelOrder(tpl)
    const directives = panels.map(p => p.directive)
    const expected = panels.map((_, i) => (i === 0 ? 'if' : 'else-if'))

    expect(
      directives,
      `面板的指令是 ${directives.join(' / ')}。第一塊必須 v-if、其餘全部 v-else-if——`
      + '留下兩個 v-if 雖然現在看起來正常（startOpen 一次只會等於一個值），但鏈一斷，'
      + '之後任何人再加一格都會踩到兩塊同時出現。',
    ).toEqual(expected)
  })

  it('格子的順序就是拍板的那個順序', () => {
    expect(
      tileOrder(tpl),
      '順序是拍板過的，依據寫在這個檔案上面的 EXPECTED_ORDER 註解與元件的「五版」段落。\n'
      + '真要改順序：先改那兩段說明，再改這裡——別讓程式跟說明各講各的。',
    ).toEqual(EXPECTED_ORDER)
  })

  it('投放框收得了的種類，每一種都有一格', () => {
    // ⛔ 這條是 2026-09-13「四版」的重點（老闆：這是教學匯入方式，應該要把能怎麼做都列出來）：
    //    detectImportKind 認得 file／url／gsheet／text 四種，四種都要在畫面上找得到入口，
    //    不能因為「我覺得那條不值得推薦」就讓它整個不存在。五版從五條收成四格，靠的正是這條還成立
    //    （拿掉的「下載範本」不是一種輸入，收進「還沒整理好」那格裡）。
    const tiles = tileOrder(tpl)
    for (const [kind, route] of [
      ['gsheet', 'sheet'],
      ['text', 'text'],
      ['url', 'web'],
      ['file', 'file'],
    ] as const) {
      expect(tiles, `投放框收得了「${kind}」，但格子裡沒有對應的 ${route}`).toContain(route)
    }
  })
})
